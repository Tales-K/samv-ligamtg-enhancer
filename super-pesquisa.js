/**
 * Adds a "Super Pesquisa" button to the "Compra por Lista" results screen
 * (?view=cards/lista), right below "Análise de Economia". Clicking it hands
 * the current card list off to background.js (see handleStartSuperPesquisa),
 * which opens and drives a second, focused tab through a wider search meant
 * to surface stores a normal search of just this list would never consider
 * — see background.js's own "Super Pesquisa" section for the full mechanism
 * and why it works. This file covers: the button/caption, the dialog that
 * explains what's about to happen, rendering whatever result eventually
 * comes back from the second tab, AND (since this file's own content script
 * is injected into every ligamagic.com.br page — the second tab included,
 * same as any other) the second tab's own side of the finish line: once
 * background.js's search there lands, it messages that exact tab asking it
 * to apply every viable "economia por reorganização" for real and show its
 * own completion modal (see the "superPesquisaFinalizeOnThisTab" listener
 * near the bottom).
 *
 * Depends on: content-utils.js (log, sendMessage, getSettings,
 * applySamvStyle), lista-defaults.js (isListaCardsPage), analise-economia.js
 * (consolidarResultado, formatarMoeda, calcularTotalConsolidado,
 * maximizarReorganizacoes, selecionarReorganizacoes,
 * construirPlanoAplicacaoReorganizacao — genuinely top-level declarations in
 * that file, safe to call directly), lista-copy-button.js (buildListaText).
 *
 * NOT safe the same way: anything declared inside analise-economia.js's own
 * `if (typeof document !== "undefined")` UI guard (aguardarFreteEObterResultado,
 * mostrarAviso, freteAindaCalculando, esperarFreteCalculado, ANALISE_BOTAO_GAP,
 * aplicarPlanoNaTela, ...) — confirmed live (2026-09-13) that calling
 * aguardarFreteEObterResultado from here throws "not defined", even though
 * it's a `function` declaration and this file shares the same isolated
 * world. Only a genuinely top-level (unblocked) declaration in another
 * content script file crosses that boundary; a block-nested one doesn't,
 * whether `function` or `const` — so this file keeps its own small local
 * copies of the couple of things it needs from that guarded half instead
 * (see below).
 */

const superPesquisaLog = (...args) => log("[Super Pesquisa]", ...args);

// Same 10px gap the rest of this button stack uses (see ANALISE_BOTAO_GAP in
// analise-economia.js) -- kept as its own literal rather than reaching across
// files for it: that one is a `const` declared inside an `if` block, and
// unlike a `function` declaration (Annex B-hoisted to the shared isolated
// world even from inside a block, in this codebase's sloppy-mode scripts),
// a block-scoped `const`/`let` never crosses that boundary -- confirmed live
// (2026-09-13): referencing it here threw a silent ReferenceError the first
// time the button tried to build, which killed the injection with no visible
// symptom beyond the button never appearing.
const SUPER_PESQUISA_BOTAO_GAP = "10px";

function buildSuperPesquisaButton() {
  const button = document.createElement("div");
  button.id = "lgm-super-pesquisa-btn";
  button.className = "botao";
  button.style.cssText =
    `cursor: pointer; display: block; width: 100%; box-sizing: border-box; ` +
    `text-align: center; margin-top: ${SUPER_PESQUISA_BOTAO_GAP};`;
  button.textContent = "Super Pesquisa";
  applySamvStyle(button);
  return button;
}

function buildSuperPesquisaIndicador() {
  const indicador = document.createElement("div");
  indicador.id = "lgm-super-pesquisa-indicador";
  indicador.style.cssText =
    "text-align: center; font-size: 11px; margin: 0 auto; width: fit-content; font-weight: 600;";
  return indicador;
}

function renderSuperPesquisaIndicador(indicador, texto, cor) {
  if (!indicador) return;
  indicador.textContent = texto ?? "";
  indicador.style.color = cor ?? "#1a7f37";
  indicador.style.marginTop = texto ? SUPER_PESQUISA_BOTAO_GAP : "0";
}

function injectSuperPesquisaButton() {
  if (document.getElementById("lgm-super-pesquisa-btn")) return true;
  // Anchors off the Análise de Economia button (not #btn-finalizar) so this
  // always lands right after it and before "Copiar Lista de Compras" (which
  // always appends itself last via appendChild, regardless of injection
  // order — see lista-copy-button.js), no matter which content script runs
  // first.
  const analiseBtn = document.getElementById("lgm-analise-economia-btn");
  if (!analiseBtn) return false;

  const indicador = buildSuperPesquisaIndicador();
  const button = buildSuperPesquisaButton();
  analiseBtn.after(indicador, button);
  button.addEventListener("click", () => handleSuperPesquisaClick(button));

  superPesquisaLog('Injected "Super Pesquisa" button.');
  return true;
}

// ── Dialog ───────────────────────────────────────────────────────────────────
const SUPER_PESQUISA_CONCEITO = "Vamos buscar suas cartas em mais lojas e calcular a economia máxima em preços + fretes.";

const SUPER_PESQUISA_EXPLICACAO =
  "Uma pesquisa pequena, com só as cartas que você quer, tende a ficar concentrada em poucas lojas. Pra " +
  "ver um pedaço maior do mercado, primeiro fazemos uma pesquisa de descoberta: sua lista + os 5 terrenos " +
  "básicos + cartas de decks públicos de preenchimento (nada disso é comprado), sem restringir a nenhuma " +
  "loja. Depois, com as lojas que essa busca encontrou, fazemos uma segunda pesquisa — só com as suas " +
  "cartas, nas quantidades que você realmente quer — restrita a essas lojas.";

const SUPER_PESQUISA_PASSOS = [
  "Abrimos uma nova aba e vamos até a Compra por Lista nela.",
  "Pesquisa de descoberta: sua lista atual + os 5 terrenos básicos + cartas de decks públicos de preenchimento, sem limite de lojas — nada disso é comprado, serve só pra ver quais lojas entram em jogo.",
  "A partir das lojas encontradas, fazemos uma segunda pesquisa — só com as suas cartas, nas quantidades reais — restrita a essas lojas.",
  "Aplicamos todas as economias por reorganização possíveis nesse resultado e mostramos quanto no total dá pra economizar.",
];

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

/**
 * `onConfirm()` — no longer takes a mode: whether to pin exact versions per
 * card is auto-detected from the user's own list (see
 * handleSuperPesquisaClick/usouVersoesExatas), not asked here. Rejecting
 * (thrown error) reopens the button, resolving closes the dialog.
 */
function buildSuperPesquisaDialog(onConfirm) {
  const modal = buildSuperPesquisaOverlay();

  const title = document.createElement("div");
  title.style.cssText = "font-size: 16px; font-weight: 700; margin-bottom: 8px;";
  title.textContent = "Super Pesquisa";
  modal.appendChild(title);

  const conceito = document.createElement("div");
  conceito.style.cssText = "font-size: 13px; font-weight: 700; color: #444; line-height: 1.4; margin-bottom: 10px;";
  conceito.textContent = SUPER_PESQUISA_CONCEITO;
  modal.appendChild(conceito);

  const explicacao = document.createElement("div");
  explicacao.style.cssText = "font-size: 12px; color: #444; line-height: 1.5; margin-bottom: 12px;";
  explicacao.textContent = SUPER_PESQUISA_EXPLICACAO;
  modal.appendChild(explicacao);

  const passosTitulo = document.createElement("div");
  passosTitulo.style.cssText = "font-size: 12px; font-weight: 700; margin-bottom: 6px;";
  passosTitulo.textContent = "Passo a passo:";
  modal.appendChild(passosTitulo);

  const passosLista = document.createElement("ol");
  passosLista.style.cssText = "font-size: 12px; color: #444; line-height: 1.5; margin: 0 0 14px; padding-left: 20px;";
  SUPER_PESQUISA_PASSOS.forEach((passo) => {
    const item = document.createElement("li");
    item.textContent = passo;
    item.style.marginBottom = "4px";
    passosLista.appendChild(item);
  });
  modal.appendChild(passosLista);

  const botoes = document.createElement("div");
  botoes.style.cssText = "display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px;";

  const cancelar = document.createElement("button");
  cancelar.type = "button";
  cancelar.textContent = "Cancelar";
  cancelar.style.cssText =
    "padding: 6px 14px; border: 1px solid #ccc; border-radius: 4px; background: #fff; cursor: pointer; " +
    "font-family: inherit; font-size: 12px;";
  cancelar.addEventListener("click", () => document.getElementById("lgm-super-pesquisa-overlay")?.remove());
  botoes.appendChild(cancelar);

  const iniciar = document.createElement("button");
  iniciar.type = "button";
  iniciar.textContent = "Iniciar Super Pesquisa";
  iniciar.style.cssText =
    "padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer; font-weight: 700; " +
    "font-family: inherit; font-size: 12px;";
  applySamvStyle(iniciar);
  iniciar.addEventListener("click", async () => {
    iniciar.disabled = true;
    iniciar.textContent = "Iniciando...";
    try {
      await onConfirm();
      document.getElementById("lgm-super-pesquisa-overlay")?.remove();
    } catch (err) {
      superPesquisaLog("Falha ao iniciar —", err.message);
      iniciar.disabled = false;
      iniciar.textContent = "Iniciar Super Pesquisa";
      superPesquisaAviso("Super Pesquisa", `Não foi possível iniciar: ${err.message}`);
    }
  });
  botoes.appendChild(iniciar);

  modal.appendChild(botoes);
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
 * The background orchestration this button kicks off (see
 * handleStartSuperPesquisa in background.js) drives a second tab through two
 * full searches, interleaved with several plain-JS waits -- easily well
 * past MV3's idle window for a service worker with no tracked activity.
 * Confirmed live (2026-09-13): without something holding it open, the whole
 * flow silently stalls forever partway through, with no error anywhere,
 * because the service worker gets torn down mid-task. A connected
 * chrome.runtime.connect() port is Chrome's own documented exemption from
 * that teardown, so one is opened here for the duration of the run and
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

// ── Click handler ────────────────────────────────────────────────────────────
/** Same shape lista-copy-button.js's plain/detalhado options use — either pins every version detail or copies just the name/quantity, letting the second tab's own filters do the version matching. */
function buildTargetOptions(usouVersoesExatas) {
  return usouVersoesExatas
    ? { detalhado: true }
    : { detalhado: false, versao: false, qualidade: false, idioma: false, preco: false };
}

async function handleSuperPesquisaClick(button) {
  const indicador = document.getElementById("lgm-super-pesquisa-indicador");

  if (superPesquisaFreteAindaCalculando()) {
    const originalLabel = button.textContent;
    button.textContent = "Aguardando frete...";
    button.style.pointerEvents = "none";
    const pronto = await superPesquisaEsperarFreteCalculado();
    button.textContent = originalLabel;
    button.style.pointerEvents = "";
    if (!pronto) {
      superPesquisaAviso(
        "Frete ainda calculando",
        'O cálculo do frete das lojas ainda não terminou. Aguarde o aviso "Calculando frete..." ' +
          "sumir da tela e tente novamente.",
      );
      return;
    }
  }

  const resultado = await sendMessage({ action: "getListaResultado" });
  if (!resultado || Object.keys(resultado).length === 0) {
    superPesquisaLog("Nenhum resultado de busca encontrado.");
    return;
  }

  const consolidado = consolidarResultado(resultado);
  if (consolidado.lojasSemFrete.length > 0) {
    superPesquisaAviso(
      "Frete pendente",
      `Selecione uma forma de envio para: ${consolidado.lojasSemFrete.join(", ")}. ` +
        "A Super Pesquisa precisa do frete de cada loja pra calcular a economia.",
    );
    return;
  }
  const baseline = calcularTotalConsolidado(consolidado);
  // Simulated only, never applied here -- this tab's own cart stays exactly
  // as the user left it (it's the "before" reference point of the two-tab
  // model). Used so the eventual "economizou" text compares apples to
  // apples: best-case-before vs. best-case-after, both with reorganização
  // already counted in, instead of a raw baseline that isn't.
  const baselineComReorg = baseline - maximizarReorganizacoes(resultado).economiaTotal;

  buildSuperPesquisaDialog(async () => {
    const filtros = await sendMessage({ action: "getListaFiltros" });
    const fullText = buildListaText(resultado, buildTargetOptions(filtros?.usouVersoesExatas), undefined);
    const rawTargetLines = fullText.split("\n").filter((linha) => linha && !linha.startsWith("#"));
    const targetLines = superPesquisaConsolidarLinhas(rawTargetLines);
    if (targetLines.length === 0) {
      throw new Error("nenhuma carta com quantidade maior que zero no resultado atual.");
    }

    startSuperPesquisaKeepAlive();
    await sendMessage({
      action: "startSuperPesquisa",
      payload: { targetLines, filtros: filtros?.caracteristicas, baseline, baselineComReorg },
    });
    renderSuperPesquisaIndicador(indicador, "🔎 Super Pesquisa em andamento na nova aba — pode levar um tempo...", "#6d4fc4");
    superPesquisaLog(
      `Iniciada com ${targetLines.length} carta(s) alvo ` +
        `(${filtros?.usouVersoesExatas ? "versões exatas" : "filtros gerais"}).`,
    );
  });
}

// ── Result relay (from the second tab, via background.js) ────────────────────
/**
 * `economia` shown here is the difference of the two MAXIMUM-achievable
 * totals, before vs. after -- baselineComReorg (this tab's own list, with
 * every viable reorganização already counted in via simulation) vs.
 * totalComReorgDepois (the second tab's list, with every viable
 * reorganização already actually applied there for real) -- never the raw
 * baseline vs. the raw post-search total, which would credit Super Pesquisa
 * for gains this tab's own "Aplicar Economia" could already reach on its
 * own.
 */
chrome.runtime.onMessage.addListener((request) => {
  if (request.action !== "superPesquisaResult") return;
  stopSuperPesquisaKeepAlive();
  const indicador = document.getElementById("lgm-super-pesquisa-indicador");
  if (!indicador) return;

  if (!request.ok) {
    renderSuperPesquisaIndicador(indicador, `Super Pesquisa não terminou: ${request.error}`, "#c0392b");
    superPesquisaLog("Falhou —", request.error);
    return;
  }

  const baselineComReorg = request.baselineComReorg ?? request.baseline ?? 0;
  const totalComReorgDepois = request.totalComReorgDepois ?? request.totalSemReorgDepois ?? 0;
  const economia = baselineComReorg - totalComReorgDepois;
  if (economia > 0.01) {
    renderSuperPesquisaIndicador(indicador, `💰 Super Pesquisa economizou R$ ${formatarMoeda(economia)}`, "#1a7f37");
  } else {
    renderSuperPesquisaIndicador(indicador, "Super Pesquisa concluída — não achou nada mais barato desta vez.", "#666");
  }
  superPesquisaLog(
    `Resultado: máximo antes R$ ${formatarMoeda(baselineComReorg)} -> ` +
      `máximo depois R$ ${formatarMoeda(totalComReorgDepois)} (ambos já com reorganização).`,
  );
});

// ── Finalize on the second tab (this exact tab, once its own search lands) ───
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
 * the live resultado and applying the single best reorganização available
 * right now, since applying one can change what else is viable -- same
 * reasoning as analise-economia.js's own aplicarTodasReorganizacoes (its
 * doc comment covers this in full). Used here to put the second tab's own
 * search result into its best real state before showing the final
 * comparison. Returns the total economia actually applied.
 */
async function superPesquisaAplicarTodasReorganizacoes() {
  let totalAplicado = 0;
  while (true) {
    const resultado = await sendMessage({ action: "getListaResultado" });
    const consolidado = consolidarResultado(resultado);
    if (consolidado.lojasSemFrete.length > 0) break;
    const reorganizacoes = selecionarReorganizacoes(consolidado);
    if (reorganizacoes.length === 0) break;
    const melhor = reorganizacoes[0];
    superPesquisaAplicarPlanoNaTela(construirPlanoAplicacaoReorganizacao(melhor));
    totalAplicado += melhor.economia;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return totalAplicado;
}

function buildSuperPesquisaResultadoLinha(label, valor) {
  const linha = document.createElement("div");
  linha.style.cssText = "display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; font-size: 12px;";
  const nome = document.createElement("span");
  nome.textContent = label;
  nome.style.color = "#444";
  linha.appendChild(nome);
  const valorEl = document.createElement("span");
  valorEl.textContent = `R$ ${formatarMoeda(valor)}`;
  valorEl.style.fontWeight = "700";
  linha.appendChild(valorEl);
  return linha;
}

/** The second tab's own completion modal: first shows what Super Pesquisa alone found, then updates in place once "economia por reorganização" has been applied for real, with the full four-way comparison. */
function buildSuperPesquisaResultModal() {
  const modal = buildSuperPesquisaOverlay();
  modal.id = "lgm-super-pesquisa-resultado-modal";

  const title = document.createElement("div");
  title.style.cssText = "font-size: 16px; font-weight: 700; margin-bottom: 10px;";
  title.textContent = "Super Pesquisa concluída!";
  modal.appendChild(title);

  const corpo = document.createElement("div");
  corpo.id = "lgm-super-pesquisa-resultado-corpo";
  corpo.style.cssText = "font-size: 13px; color: #333; line-height: 1.5;";
  modal.appendChild(corpo);

  const fechar = document.createElement("button");
  fechar.type = "button";
  fechar.textContent = "Fechar";
  fechar.style.cssText =
    "margin-top: 14px; padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer; " +
    "font-weight: 700; font-family: inherit; font-size: 12px;";
  applySamvStyle(fechar);
  fechar.addEventListener("click", () => document.getElementById("lgm-super-pesquisa-overlay")?.remove());
  modal.appendChild(fechar);

  return corpo;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== "superPesquisaFinalizeOnThisTab") return;
  (async () => {
    const { baseline, baselineComReorg } = request;
    const corpo = buildSuperPesquisaResultModal();

    // This is already the second, real-quantity search -- scoped to just the
    // stores a wider discovery search surfaced (see handleStartSuperPesquisa
    // in background.js) -- so the result already IS the state the user
    // actually wants, no further adjustment needed before reading totals off
    // of it.
    const resultadoInicial = await sendMessage({ action: "getListaResultado" });
    const totalSemReorgDepois = calcularTotalConsolidado(consolidarResultado(resultadoInicial));
    const economiaSoSuperPesquisa = (baseline ?? 0) - totalSemReorgDepois;

    corpo.textContent = "";
    const linhaSoPesquisa = document.createElement("div");
    linhaSoPesquisa.style.cssText = "font-weight: 700; margin-bottom: 10px;";
    linhaSoPesquisa.textContent =
      economiaSoSuperPesquisa > 0.01
        ? `💰 Só com a Super Pesquisa: economia de R$ ${formatarMoeda(economiaSoSuperPesquisa)}`
        : "Só com a Super Pesquisa: nenhuma economia encontrada desta vez.";
    corpo.appendChild(linhaSoPesquisa);

    const status = document.createElement("div");
    status.style.cssText = "color: #6d4fc4; font-style: italic;";
    status.textContent = "Aplicando economia por reorganização nesta aba...";
    corpo.appendChild(status);

    await superPesquisaEsperarFreteCalculado();
    await superPesquisaAplicarTodasReorganizacoes();
    await superPesquisaEsperarFreteCalculado();

    const resultadoFinal = await sendMessage({ action: "getListaResultado" });
    const totalComReorgDepois = calcularTotalConsolidado(consolidarResultado(resultadoFinal));

    status.remove();
    const comparativo = document.createElement("div");
    comparativo.style.cssText = "border-top: 1px solid #eee; margin-top: 10px; padding-top: 10px;";
    comparativo.appendChild(buildSuperPesquisaResultadoLinha("Antes (sem reorganização)", baseline ?? 0));
    comparativo.appendChild(buildSuperPesquisaResultadoLinha("Antes (com reorganização)", baselineComReorg ?? baseline ?? 0));
    comparativo.appendChild(buildSuperPesquisaResultadoLinha("Super Pesquisa (sem reorganização)", totalSemReorgDepois));
    comparativo.appendChild(buildSuperPesquisaResultadoLinha("Super Pesquisa (com reorganização)", totalComReorgDepois));
    corpo.appendChild(comparativo);

    const economiaTotal = (baselineComReorg ?? baseline ?? 0) - totalComReorgDepois;
    const linhaFinal = document.createElement("div");
    linhaFinal.style.cssText = "margin-top: 10px; font-weight: 700; font-size: 14px;";
    linhaFinal.style.color = economiaTotal > 0.01 ? "#1a7f37" : "#666";
    linhaFinal.textContent =
      economiaTotal > 0.01
        ? `💰 Economia total (Super Pesquisa + reorganização): R$ ${formatarMoeda(economiaTotal)}`
        : "Nenhuma economia total encontrada desta vez.";
    corpo.appendChild(linhaFinal);

    sendMessage({
      action: "superPesquisaFinalized",
      baseline,
      baselineComReorg,
      totalSemReorgDepois,
      totalComReorgDepois,
    });
  })();
  return false;
});

// ── Init ─────────────────────────────────────────────────────────────────────
function initSuperPesquisa() {
  if (!isListaCardsPage()) return;

  getSettings().then((settings) => {
    if (settings?.addSuperPesquisa === false) return;
    if (injectSuperPesquisaButton()) return;

    // Same reasoning as the other buttons on this screen: results only exist
    // after a search, and "Pesquisar Novamente" replaces the whole results
    // section wholesale.
    new MutationObserver(() => injectSuperPesquisaButton()).observe(document.body, {
      childList: true,
      subtree: true,
    });
  });
}

initSuperPesquisa();
