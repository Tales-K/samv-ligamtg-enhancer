/**
 * "Super Pesquisa": widens a normal "Compra por Lista" search to more stores
 * than it would naturally consider, looking for a cheaper way to buy the
 * exact same cards. Triggered from the "Super Pesquisa" button that
 * analise-economia.js's own merged modal renders (that button calls
 * iniciarSuperPesquisa(), the one top-level entry point this file exposes for
 * that purpose) — this file has no button/UI injection of its own anymore.
 *
 * Flow: iniciarSuperPesquisa() hands the current card list off to
 * background.js (see handleStartSuperPesquisa), which opens a second,
 * unfocused tab and drives it through a wider search — see background.js's
 * own "Super Pesquisa" section for the full mechanism and why it works.
 * Once that lands, background.js messages this exact tab (the ORIGIN tab)
 * with the outcome ("superPesquisaResult"), which this file keeps in a
 * module-level variable (superPesquisaState) and renders -- progress while
 * running, then the decision prompt (Sim / Não / Sim numa nova aba) -- into
 * analise-economia.js's own modal via renderSuperPesquisaStatusSection(),
 * another top-level entry point. That modal is the only place this UI
 * appears; the outcome survives closing and reopening it.
 *
 * This same file is also injected into the SECOND tab (any
 * ligamagic.com.br page gets it, same as any other content script here),
 * where it plays a different role: once background.js's search there lands,
 * it messages that exact tab asking it to apply every viable "economia por
 * reorganização" for real and report the resulting total back (see the
 * "superPesquisaApplyReorgAndReport" listener near the bottom) — no UI of
 * its own is shown on that tab, all decision UI lives on the origin tab.
 * The same message is later reused, on the ORIGIN tab itself, for the "Sim"
 * outcome (see "superPesquisaApplyToOrigin" in background.js) — one handler
 * covers both cases via the request's own `context` field.
 *
 * Depends on: content-utils.js (log, sendMessage, applySamvStyle,
 * SAMV_PURPLE), lista-defaults.js (isListaCardsPage), analise-economia.js
 * (consolidarResultado, formatarMoeda, calcularTotalConsolidado,
 * maximizarReorganizacoes, melhorFechamento,
 * construirPlanoAplicacaoReorganizacao, ANALISE_ECONOMIA_MINIMA — genuinely
 * top-level declarations in that file, safe to call directly), lista-copy-
 * button.js (buildListaText).
 *
 * NOT safe the same way: anything declared inside analise-economia.js's own
 * `if (typeof document !== "undefined")` UI guard (aguardarFreteEObterResultado,
 * mostrarAviso, freteAindaCalculando, esperarFreteCalculado, ANALISE_BOTAO_GAP,
 * aplicarPlanoNaTela, showModal, handleAnaliseClick, ...) — confirmed live
 * (2026-09-13) that calling aguardarFreteEObterResultado from here throws
 * "not defined", even though it's a `function` declaration and this file
 * shares the same isolated world. Only a genuinely top-level (unblocked)
 * declaration in another content script file crosses that boundary; a
 * block-nested one doesn't, whether `function` or `const` — so this file
 * keeps its own small local copies of the couple of things it needs from
 * that guarded half instead (see below), and conversely exposes its OWN
 * entry points (iniciarSuperPesquisa, renderSuperPesquisaStatusSection) as
 * plain top-level functions so analise-economia.js's block-scoped UI code
 * can call them.
 */

const superPesquisaLog = (...args) => log("[Super Pesquisa]", ...args);

// ── Persisted result state ──────────────────────────────────────────────────
/**
 * Plain module-level variable, not chrome.storage -- it only needs to
 * survive across this tab's own modal open/close while the page stays
 * loaded; a fresh page load starting a brand new run is the right behavior,
 * not something to restore from a previous session.
 *
 * status: "idle" | "running" | "decision" | "no-savings" | "error"
 *   running also carries: progresso ({ etapa, total, descricao }), refreshed
 *     by background.js's own "superPesquisaProgresso" messages as the run
 *     moves between steps (see SUPER_PESQUISA_ETAPAS there)
 *   decision also carries: secondTabId, totalComReorgDepois, economia, lojas
 *   error also carries: error (string)
 */
let superPesquisaState = { status: "idle" };

// ── Overlay compartilhado (avisos e notificação de resultado) ────────────────
function buildSuperPesquisaOverlay() {
  const overlay = document.createElement("div");
  overlay.id = "lgm-super-pesquisa-overlay";
  overlay.style.cssText =
    "position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 9999; " +
    "display: flex; align-items: center; justify-content: center; padding: 20px;";

  const modal = document.createElement("div");
  modal.style.cssText =
    "background: #fff; border-radius: 8px; width: min(560px, 100%); max-height: 86vh; " +
    "overflow-y: auto; padding: 20px; box-shadow: 0 8px 30px rgba(0,0,0,0.35); " +
    "font-size: 13px; color: #222; font-family: inherit;";

  overlay.appendChild(modal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.addEventListener("keydown", function escHandler(e) {
    if (e.key === "Escape") {
      overlay.remove();
      document.removeEventListener("keydown", escHandler);
    }
  });

  document.body.appendChild(overlay);
  return modal;
}

/** Local copy of analise-economia.js's freteAindaCalculando()/esperarFreteCalculado() -- see this file's own top doc comment for why those can't just be called directly. */
function superPesquisaFreteAindaCalculando() {
  const indicadorFrete = document.getElementById("main_calculando_fretes");
  return !!indicadorFrete && !indicadorFrete.classList.contains("d-none");
}

function superPesquisaEsperarFreteCalculado(timeoutMs = 12_000, intervalMs = 400) {
  return new Promise((resolve) => {
    const prazo = Date.now() + timeoutMs;
    const checar = () => {
      if (!superPesquisaFreteAindaCalculando()) return resolve(true);
      if (Date.now() >= prazo) return resolve(false);
      setTimeout(checar, intervalMs);
    };
    checar();
  });
}

/** Local, minimal stand-in for analise-economia.js's mostrarAviso() -- same reason. */
function superPesquisaAviso(titulo, mensagem) {
  const modal = buildSuperPesquisaOverlay();
  const title = document.createElement("div");
  title.style.cssText = "font-size: 15px; font-weight: 700; margin-bottom: 10px;";
  title.textContent = titulo;
  modal.appendChild(title);
  const body = document.createElement("div");
  body.style.cssText = "font-size: 13px; color: #333; line-height: 1.5;";
  body.textContent = mensagem;
  modal.appendChild(body);
}

// ── Keep-alive ───────────────────────────────────────────────────────────────
/**
 * The background orchestration this kicks off (see handleStartSuperPesquisa
 * / handleSuperPesquisaApplyToOrigin in background.js) drives a tab through
 * one or more full searches, interleaved with several plain-JS waits --
 * easily well past MV3's idle window for a service worker with no tracked
 * activity. Confirmed live (2026-09-13): without something holding it open,
 * the whole flow silently stalls forever partway through, with no error
 * anywhere, because the service worker gets torn down mid-task. A connected
 * chrome.runtime.connect() port is Chrome's own documented exemption from
 * that teardown, so one is opened here for the duration of each such run and
 * closed once the result comes back.
 */
let superPesquisaKeepAlivePort = null;

function startSuperPesquisaKeepAlive() {
  stopSuperPesquisaKeepAlive();
  try {
    superPesquisaKeepAlivePort = chrome.runtime.connect({ name: "superPesquisaKeepAlive" });
  } catch (err) {
    superPesquisaLog("Não foi possível abrir a conexão de keep-alive —", err.message);
  }
}

function stopSuperPesquisaKeepAlive() {
  if (!superPesquisaKeepAlivePort) return;
  try {
    superPesquisaKeepAlivePort.disconnect();
  } catch {
    // already gone
  }
  superPesquisaKeepAlivePort = null;
}

// ── Starting a run (called from analise-economia.js's "Super Pesquisa" button) ──
/** Same shape lista-copy-button.js's plain/detalhado options use — either pins every version detail or copies just the name/quantity, letting the second tab's own filters do the version matching. */
function buildTargetOptions(usouVersoesExatas) {
  return usouVersoesExatas
    ? { detalhado: true }
    : { detalhado: false, versao: false, qualidade: false, idioma: false, preco: false };
}

/**
 * Shared pre-flight for both flavours: makes sure the screen is actually in
 * a state worth searching from (frete finished, every store has a shipping
 * option picked) and computes the "before" reference point. Returns null
 * after showing its own explanation when something isn't ready.
 */
async function prepararSuperPesquisa() {
  if (superPesquisaState.status === "running") {
    superPesquisaAviso("Super Pesquisa", "Já existe uma Super Pesquisa em andamento — aguarde ela terminar.");
    return null;
  }

  if (superPesquisaFreteAindaCalculando()) {
    const pronto = await superPesquisaEsperarFreteCalculado();
    if (!pronto) {
      superPesquisaAviso(
        "Frete ainda calculando",
        'O cálculo do frete das lojas ainda não terminou. Aguarde o aviso "Calculando frete..." ' +
          "sumir da tela e tente novamente.",
      );
      return null;
    }
  }

  const resultado = await sendMessage({ action: "getListaResultado" });
  if (!resultado || Object.keys(resultado).length === 0) {
    superPesquisaLog("Nenhum resultado de busca encontrado.");
    return null;
  }

  const consolidado = consolidarResultado(resultado);
  if (consolidado.lojasSemFrete.length > 0) {
    superPesquisaAviso(
      "Frete pendente",
      `Selecione uma forma de envio para: ${consolidado.lojasSemFrete.join(", ")}. ` +
        "A Super Pesquisa precisa do frete de cada loja pra calcular a economia.",
    );
    return null;
  }

  // Simulated only, never applied here -- this is the "before" reference
  // point the eventual result gets compared against (best-case-before vs.
  // best-case-after, both with reorganização already counted in).
  const baselineComReorg = calcularTotalConsolidado(consolidado) - maximizarReorganizacoes(resultado).economiaTotal;
  return { resultado, baselineComReorg };
}

/** The real, unmodified shopping list both flavours search with in phase 2. */
function montarTargetLines(resultado, filtros) {
  const fullText = buildListaText(resultado, buildTargetOptions(filtros?.usouVersoesExatas), undefined);
  const rawTargetLines = fullText.split("\n").filter((linha) => linha && !linha.startsWith("#"));
  return superPesquisaConsolidarLinhas(rawTargetLines);
}

/**
 * Entry point called from analise-economia.js's merged modal. Validates the
 * current screen is ready and hands the list straight off to background.js's
 * handleStartSuperPesquisa -- the button itself is the confirmation, so
 * there's no second dialog in between. From there the run reports its own
 * progress into the modal's status section (see the
 * "superPesquisaProgresso" listener below), and the eventual outcome arrives
 * via "superPesquisaResult", not from this function's own return.
 */
async function iniciarSuperPesquisa() {
  const pronto = await prepararSuperPesquisa();
  if (!pronto) return;
  const { resultado, baselineComReorg } = pronto;

  try {
    const filtros = await sendMessage({ action: "getListaFiltros" });
    const targetLines = montarTargetLines(resultado, filtros);
    if (targetLines.length === 0) {
      throw new Error("nenhuma carta com quantidade maior que zero no resultado atual.");
    }

    startSuperPesquisaKeepAlive();
    superPesquisaState = { status: "running" };
    // Acende a seção de status da modal na hora, sem esperar a primeira
    // mensagem de progresso do background chegar.
    superPesquisaRerenderCorpos();
    await sendMessage({
      action: "startSuperPesquisa",
      payload: { targetLines, filtros: filtros?.caracteristicas, baselineComReorg },
    });
    superPesquisaLog(`Iniciada com ${targetLines.length} carta(s) alvo.`);
  } catch (err) {
    stopSuperPesquisaKeepAlive();
    superPesquisaState = { status: "idle" };
    superPesquisaRerenderCorpos();
    superPesquisaLog("Falha ao iniciar —", err.message);
    superPesquisaAviso("Super Pesquisa", `Não foi possível iniciar: ${err.message}`);
  }
}


// ── Decision UI (shared by the standalone notification and the merged modal's status section) ──
/**
 * Builds the current state's summary text (+ decision buttons, when
 * applicable) into `container`. Used both for the standalone notification
 * rendered into analise-economia.js's own "Super Pesquisa" status section
 * inside its merged modal (renderSuperPesquisaStatusSection) -- the single
 * place a run's progress and its eventual result are shown.
 */
function buildSuperPesquisaDecisionBody(container, state, { onDismiss }) {
  container.textContent = "";
  superPesquisaRegistrarCorpo(container, onDismiss);

  if (state.status === "idle") {
    container.style.display = "none";
    return;
  }
  container.style.display = "block";

  if (state.status === "running") {
    const msg = document.createElement("div");
    msg.style.cssText = "font-size: 13px; color: #6d4fc4; font-style: italic;";
    msg.textContent = "🔎 Super Pesquisa em andamento numa aba em segundo plano — pode levar um tempo...";
    container.appendChild(msg);

    const p = state.progresso;
    if (p) {
      const etapa = document.createElement("div");
      etapa.style.cssText = `margin-top: 6px; font-size: 12px; font-weight: 700; color: ${SAMV_PURPLE};`;
      etapa.textContent = `Etapa ${p.etapa} de ${p.total}: ${p.descricao}`;
      container.appendChild(etapa);

      const trilho = document.createElement("div");
      trilho.style.cssText = "margin-top: 6px; height: 4px; border-radius: 2px; background: rgba(109, 79, 196, 0.18);";
      const barra = document.createElement("div");
      barra.style.cssText =
        `height: 100%; border-radius: 2px; background: ${SAMV_PURPLE}; transition: width 0.3s; ` +
        `width: ${Math.round((p.etapa / p.total) * 100)}%;`;
      trilho.appendChild(barra);
      container.appendChild(trilho);
    }
    return;
  }

  if (state.status === "error") {
    const msg = document.createElement("div");
    msg.style.cssText = "font-size: 13px; color: #c0392b;";
    msg.textContent = `Super Pesquisa não terminou: ${state.error}`;
    container.appendChild(msg);
    return;
  }

  if (state.status === "no-savings") {
    const msg = document.createElement("div");
    msg.style.cssText = "font-size: 13px; color: #666;";
    msg.textContent = "Super Pesquisa concluída — não encontramos economia melhor que a atual desta vez.";
    container.appendChild(msg);
    return;
  }

  if (state.status !== "decision") return;

  const resumo = document.createElement("div");
  resumo.style.cssText = "font-size: 13px; color: #333; line-height: 1.5; margin-bottom: 12px; text-align: center;";
  const listaLojas = state.lojas.map((l) => l.nome).join(", ");
  resumo.textContent =
    `Identificamos que, comprando nas lojas ${listaLojas}, a compra fica em R$ ${formatarMoeda(state.totalComReorgDepois)}, ` +
    `economizando R$ ${formatarMoeda(state.economia)}.`;
  container.appendChild(resumo);

  const pergunta = document.createElement("div");
  pergunta.style.cssText = "font-size: 13px; color: #333; margin-bottom: 12px; text-align: center; font-weight: 700;";
  pergunta.textContent = "Gostaria de fazer essa mudança?";
  container.appendChild(pergunta);

  const botoes = document.createElement("div");
  botoes.style.cssText = "display: flex; justify-content: center; gap: 8px; flex-wrap: wrap;";

  // Os três botões compartilham forma e tipografia; só o "Sim" vem preenchido
  // de roxo (applySamvStyle), pra ser o destaque entre opções equivalentes.
  const estiloBotao =
    "padding: 6px 14px; border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 12px; font-weight: 700;";
  const estiloSecundario = `${estiloBotao} border: 1px solid ${SAMV_PURPLE}; background: #fff; color: ${SAMV_PURPLE};`;

  const naoBtn = document.createElement("button");
  naoBtn.type = "button";
  naoBtn.textContent = "Não";
  naoBtn.style.cssText = estiloSecundario;
  naoBtn.addEventListener("click", () => onDismiss?.());
  botoes.appendChild(naoBtn);

  const novaAbaBtn = document.createElement("button");
  novaAbaBtn.type = "button";
  novaAbaBtn.textContent = "Sim, numa nova aba";
  novaAbaBtn.style.cssText = estiloSecundario;
  novaAbaBtn.addEventListener("click", () => {
    sendMessage({ action: "superPesquisaFocusTab", secondTabId: state.secondTabId });
  });
  botoes.appendChild(novaAbaBtn);

  const simBtn = document.createElement("button");
  simBtn.type = "button";
  simBtn.textContent = "Sim";
  simBtn.style.cssText = `${estiloBotao} border: none;`;
  applySamvStyle(simBtn);
  simBtn.addEventListener("click", () => {
    simBtn.disabled = true;
    naoBtn.disabled = true;
    novaAbaBtn.disabled = true;
    simBtn.textContent = "Aplicando...";
    startSuperPesquisaKeepAlive();
    sendMessage({ action: "superPesquisaApplyToOrigin", secondTabId: state.secondTabId });
  });
  botoes.appendChild(simBtn);

  container.appendChild(botoes);
}

/**
 * Every place currently showing the status/decision body (the proactive
 * overlay, the merged modal's section, or both at once), so a progress
 * update can refresh them in place instead of only being visible on the next
 * reopen. Entries whose container left the DOM are dropped on the next pass.
 */
const superPesquisaCorpos = new Set();

function superPesquisaRegistrarCorpo(container, onDismiss) {
  superPesquisaCorpos.add({ container, onDismiss });
}

function superPesquisaRerenderCorpos() {
  for (const corpo of [...superPesquisaCorpos]) {
    if (!corpo.container.isConnected) {
      superPesquisaCorpos.delete(corpo);
      continue;
    }
    superPesquisaCorpos.delete(corpo);
    buildSuperPesquisaDecisionBody(corpo.container, superPesquisaState, { onDismiss: corpo.onDismiss });
  }
}

/**
 * Called by analise-economia.js's merged modal (block-scoped code, but that
 * only matters for referencing an identifier declared inside another file's
 * block -- calling a top-level function like this one, or handing it a DOM
 * element, is fine either direction) to render the same status/decision UI
 * into a container it provides. Renders a snapshot of the current state at
 * call time -- the modal is rebuilt fresh every time it's (re)opened, so
 * reopening it always reflects whatever superPesquisaState currently holds.
 */
function renderSuperPesquisaStatusSection(container) {
  buildSuperPesquisaDecisionBody(container, superPesquisaState, {
    onDismiss: () => {
      superPesquisaState = { status: "idle" };
      superPesquisaRerenderCorpos();
    },
  });
}

// ── Progress relay (from background.js, while the run is still going) ──
/**
 * Only updates a run that's actually in progress: a late-arriving step
 * message (the run already landed, or the user dismissed it) must not drag
 * the UI back to "em andamento" over a result that's already on screen.
 */
chrome.runtime.onMessage.addListener((request) => {
  if (request.action !== "superPesquisaProgresso") return;
  if (superPesquisaState.status !== "running") return;
  superPesquisaState = {
    ...superPesquisaState,
    progresso: { etapa: request.etapa, total: request.total, descricao: request.descricao },
  };
  superPesquisaRerenderCorpos();
});

// ── Result relay (from background.js, once the discovery+search+reorg run finishes) ──
chrome.runtime.onMessage.addListener((request) => {
  if (request.action !== "superPesquisaResult") return;
  stopSuperPesquisaKeepAlive();

  if (!request.ok) {
    superPesquisaState = { status: "error", error: request.error };
    superPesquisaLog("Falhou —", request.error);
  } else if (request.economia > ANALISE_ECONOMIA_MINIMA) {
    superPesquisaState = {
      status: "decision",
      secondTabId: request.secondTabId,
      totalComReorgDepois: request.totalComReorgDepois,
      economia: request.economia,
      lojas: request.lojas,
    };
    superPesquisaLog(
      `Concluído: economia de R$ ${formatarMoeda(request.economia)} em ${request.lojas.length} loja(s) ` +
        `(total R$ ${formatarMoeda(request.totalComReorgDepois)}).`,
    );
  } else {
    superPesquisaState = { status: "no-savings" };
    superPesquisaLog("Concluído — nenhuma economia melhor que a atual desta vez.");
  }

  superPesquisaRerenderCorpos();
});

/** Reply to the "Sim" outcome, once background.js has replayed the search + applied reorg for real on this same (origin) tab. */
chrome.runtime.onMessage.addListener((request) => {
  if (request.action !== "superPesquisaAppliedHere") return;
  stopSuperPesquisaKeepAlive();
  document.getElementById("lgm-super-pesquisa-overlay")?.remove();

  if (!request.ok) {
    superPesquisaAviso("Super Pesquisa", `Não foi possível aplicar a economia: ${request.error}`);
    return;
  }

  superPesquisaState = { status: "idle" };
  superPesquisaRerenderCorpos(); // limpa a seção de status da modal, se estiver aberta
  superPesquisaAviso(
    "Economia aplicada",
    `Pesquisa atualizada com as lojas encontradas — novo total: R$ ${formatarMoeda(request.totalComReorgDepois)}.`,
  );
});

// ── Apply-reorg-and-report (runs on whichever tab background.js targets: the second/discovery tab, or later this same origin tab for "Sim") ──
/** Local copy of analise-economia.js's aplicarPlanoNaTela -- see this file's own top doc comment for why it can't just be called directly. Drives the exact same DOM controls: bump each destination row's own qty input, then each closing store's own "remover todos os itens" control. */
function superPesquisaAplicarPlanoNaTela(plano) {
  for (const { bloco, linha, qtd } of plano.incrementar) {
    const input = document.querySelector(`input.qty[data-bloco="${bloco}"][data-linha="${linha}"]`);
    if (!input) continue;
    const atual = parseInt(input.value, 10) || 0;
    input.value = String(atual + qtd);
    input.dispatchEvent(new FocusEvent("blur"));
  }
  for (const bloco of plano.fecharLojas) {
    const del = document.querySelector(`#bloco_${bloco} img.del[onclick*="removeTodosItens"]`);
    del?.click();
  }
}

/** "1 Card Name" / "1 card name [qualidade=...]..." → { qtd, nome } -- local copy of background.js's own cardNameFromLine (that file is a separate JS realm entirely, a service worker, not reachable here even as a top-level global). */
function superPesquisaParseLinha(linha) {
  const qtd = parseInt(linha, 10) || 0;
  const nome = linha
    .replace(/^\d+\s+/, "")
    .split("[")[0]
    .trim()
    .toLowerCase();
  return { qtd, nome };
}

/**
 * `buildListaText` produces one line per store ROW, grouped under a "#
 * <Loja>" section per store -- correct for a human-readable shopping list,
 * but a card whose stock got split across stores (very common) turns into
 * several separate lines for the very same name, e.g. three "1 Polluted
 * Delta" lines instead of one "3 Polluted Delta". Left unconsolidated here,
 * background.js's own handleStartSuperPesquisa would treat each duplicate as
 * its own distinct search line -- wasting slots against
 * SUPER_PESQUISA_MAX_CARDS and, in an earlier version of this feature that
 * maxed out every line's quantity, multiplying the requested amount by
 * however many stores that one card happened to be split across (confirmed
 * live 2026-09-14: three "1 Polluted Delta" lines each independently maxed
 * out). Collapse to one line per distinct name, summing quantities, before
 * this list goes anywhere else.
 */
function superPesquisaConsolidarLinhas(linhas) {
  const porNome = new Map();
  for (const linha of linhas) {
    const { qtd, nome } = superPesquisaParseLinha(linha);
    const existente = porNome.get(nome);
    if (existente) {
      existente.qtd += qtd;
    } else {
      porNome.set(nome, { qtd, linha });
    }
  }
  return [...porNome.values()].map(({ qtd, linha }) => linha.replace(/^\d+\s+/, `${qtd} `));
}

/**
 * Real, DOM-driven counterpart to maximizarReorganizacoes: keeps re-fetching
 * the live resultado and applying the best set of stores to close right now,
 * since the live page recalculates frete as things move -- same reasoning as
 * analise-economia.js's own aplicarTodasReorganizacoes (its doc comment
 * covers this in full). Used here to put whichever tab this runs on into its
 * best real state before reporting the total back. Returns the total
 * economia actually applied.
 */
async function superPesquisaAplicarTodasReorganizacoes() {
  let totalAplicado = 0;
  while (true) {
    const resultado = await sendMessage({ action: "getListaResultado" });
    const consolidado = consolidarResultado(resultado);
    if (consolidado.lojasSemFrete.length > 0) break;
    const melhor = melhorFechamento(consolidado);
    if (!melhor) break;
    superPesquisaAplicarPlanoNaTela(construirPlanoAplicacaoReorganizacao(melhor));
    totalAplicado += melhor.economia;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return totalAplicado;
}

/**
 * Runs on whichever tab background.js sends this to: the discovery/second
 * tab right after its own scoped search lands, or -- reusing the exact same
 * message -- this origin tab itself after "Sim" replays that search here.
 * Applies every real reorganização it can, then reports the resulting total
 * back to background.js (which harvests the store list itself via
 * chrome.scripting.executeScript, so no store data needs to travel with this
 * reply).
 */
chrome.runtime.onMessage.addListener((request) => {
  if (request.action !== "superPesquisaApplyReorgAndReport") return;
  (async () => {
    await superPesquisaEsperarFreteCalculado();
    await superPesquisaAplicarTodasReorganizacoes();
    await superPesquisaEsperarFreteCalculado();
    const resultadoFinal = await sendMessage({ action: "getListaResultado" });
    const totalComReorgDepois = calcularTotalConsolidado(consolidarResultado(resultadoFinal));
    sendMessage({ action: "superPesquisaReorgApplied", context: request.context, totalComReorgDepois });
  })();
  return false;
});
