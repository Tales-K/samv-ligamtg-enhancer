/**
 * Adds an "Análise de Economia" button to the "Compra por Lista" results
 * screen (?view=cards/lista, after a search). For each expensive card in the
 * results, estimates how much extra a store's shipping fee is costing you
 * purely because that one card needs it -- deliberately EXCLUDING the card's
 * own price, since "you save its price by not buying it" is trivial and not
 * what this is for. What's reported is only the redistribution part: a
 * store the card is REALLY currently bought from dropping away entirely
 * (shipping saved), once every other card really bought there has been
 * re-priced from the stores that stay open -- net of whatever that
 * relocation costs, which can eat into or even wipe out the shipping saved.
 *
 * Deliberately LOCAL: only the store(s) a candidate card is actually bought
 * from are ever considered for closing, and only that store's own other
 * real cards are ever considered for moving. Earlier versions of this file
 * globally re-optimized the ENTIRE cart per candidate, which (a) could
 * report a store "leaving" that never even sold the candidate, just because
 * the whole-cart re-solve happened to reshuffle it for unrelated reasons,
 * and (b) computed "comprado hoje em X" from that same re-solved allocation
 * instead of from what's actually on screen -- both confirmed against a real
 * search where a card was mislabeled as bought at a store that only listed
 * it as "outras cartas disponíveis" (an unpurchased alternative), while
 * really being bought elsewhere. Every store block in `resultado` lists
 * BOTH the cards it's really selling you (quantidade > 0) AND other cards
 * it merely also carries as an alternative (quantidade 0, same chaveBusca);
 * that mix is exactly why "which store is this card really bought from"
 * must come straight from quantidade > 0, never from a re-solve.
 *
 * Data source: the same `CardsOrcamento.item.resultado` lista-copy-button.js
 * reads (via background.js's getListaResultado) -- not the results table
 * DOM. Everything below runs on data already fetched by a single search; no
 * extra requests are made.
 *
 * This file has two independent halves:
 *   1. A pure solver (no DOM, no chrome.* APIs) -- testable standalone by
 *      loading it into a vm context and calling analisarEconomia() directly.
 *   2. UI glue at the bottom that wires the solver to a button + modal.
 *
 * Depends on: content-utils.js (log, sendMessage, getSettings,
 * showCopiedFeedback, applySamvStyle), lista-defaults.js (isListaCardsPage)
 */

// ── Solver ───────────────────────────────────────────────────────────────────

// How aggressively candidate cards are picked for analysis -- see
// selecionarCandidatos(). Tunable; not exposed in the UI yet.
const ANALISE_LIMIAR_PCT = 0.02; // a card must be worth at least 2% of the cards subtotal...
const ANALISE_PISO_ABS = 5; // ...or at least R$5, whichever is higher
const ANALISE_TOP_N = 20; // at most this many candidates get analyzed

/**
 * Flattens `resultado` (indexed by block, holes from removeItem's `delete`)
 * into:
 *   - lojas: [{ nome, frete }]
 *   - cards: [{ chaveBusca, nome, qtd, valorAtual, porLoja }] -- only cards
 *     currently being REALLY bought (quantidade > 0 somewhere).
 *     `porLoja` is a Map<lojaNome, { qtd, valor }>: the actual current
 *     purchase split straight from each block's quantidade > 0 entries --
 *     this, not any recomputation, is what "bought at store X" means
 *     throughout this file.
 *   - ofertas: Map<chaveBusca, [{ preco, iQuant, loja }]> -- EVERY offer for
 *     that card, from every store, regardless of whether it's the one
 *     currently bought from (includes quantidade:0 "outras cartas
 *     disponíveis" entries -- those are exactly the alternatives a
 *     relocation would use). Flat (not grouped by store) and sorted by
 *     price, because refilling a card within a set of stores pools the
 *     cheapest offers across all of them together -- see preencherCarta().
 *   - cartasPorLoja: Map<lojaNome, Map<chaveBusca, { nome, qtd, valor }>> --
 *     reverse index of the same real purchases, for "what else does this
 *     store actually sell me right now" lookups.
 *   - lojasSemFrete: [nome] -- stores whose `frete` isn't a real number yet.
 *     LigaMagic only writes resultado[bloco].frete once a shipping option is
 *     selected for that block (auto-selected right after its own "Calculando
 *     frete..." AJAX resolves, or picked by the user) -- it is NOT part of
 *     the initial search response. A block read mid-calculation, or one with
 *     no shipping option available at all, has no `frete` yet. Silently
 *     treating that as R$0 would make closing that store look free, so it's
 *     surfaced here instead of defaulted -- callers must check this before
 *     trusting any cost computed from `lojas`.
 */
function consolidarResultado(resultado) {
  const blocos = Object.values(resultado ?? {}).filter(Boolean);
  const lojas = blocos.map((b) => ({ nome: b.nomeLoja, frete: b.frete }));
  const lojasSemFrete = lojas
    .filter((l) => typeof l.frete !== "number" || Number.isNaN(l.frete))
    .map((l) => l.nome);

  const ofertas = new Map();
  const cardsMap = new Map();

  for (const bloco of blocos) {
    for (const carta of bloco.cartas ?? []) {
      if (!carta) continue;
      const chave = carta.chaveBusca;

      if (!ofertas.has(chave)) ofertas.set(chave, []);
      ofertas.get(chave).push({
        preco: carta.preco,
        iQuant: carta.iQuant ?? 0,
        loja: bloco.nomeLoja,
      });

      if (carta.quantidade > 0) {
        const atual = cardsMap.get(chave) ?? {
          chaveBusca: chave,
          nome: carta.nomeInglesSA,
          qtd: 0,
          valorAtual: 0,
          porLoja: new Map(),
        };
        atual.qtd += carta.quantidade;
        atual.valorAtual += carta.quantidade * carta.preco;
        const emLoja = atual.porLoja.get(bloco.nomeLoja) ?? { qtd: 0, valor: 0 };
        emLoja.qtd += carta.quantidade;
        emLoja.valor += carta.quantidade * carta.preco;
        atual.porLoja.set(bloco.nomeLoja, emLoja);
        cardsMap.set(chave, atual);
      }
    }
  }

  for (const lista of ofertas.values()) lista.sort((a, b) => a.preco - b.preco);

  const cartasPorLoja = new Map();
  for (const card of cardsMap.values()) {
    for (const [loja, info] of card.porLoja) {
      if (!cartasPorLoja.has(loja)) cartasPorLoja.set(loja, new Map());
      cartasPorLoja.get(loja).set(card.chaveBusca, { nome: card.nome, qtd: info.qtd, valor: info.valor });
    }
  }

  return { lojas, cards: [...cardsMap.values()], ofertas, lojasSemFrete, cartasPorLoja };
}

/** Every store name that carries at least one offer of this card, regardless of price. */
function lojasQueOferecem(consolidado, chaveBusca) {
  return [...new Set((consolidado.ofertas.get(chaveBusca) ?? []).map((o) => o.loja))];
}

/**
 * Fills `qtd` units of a card from the cheapest offers available within
 * `lojasAbertas`, pooled across every store in that set (not one store at a
 * time) -- this is what actually reproduces LigaMagic's own totals: a card
 * can and does get split across multiple already-open stores when that's
 * cheaper, with no extra shipping cost since those stores are paid for
 * regardless.
 *
 * `iQuant` on an offer is the store's TOTAL stock for that card, not what's
 * still free -- every store in `lojasAbertas` keeps its own existing real
 * purchases untouched (this only ever fills NEW demand on top of that), so
 * whatever quantity of this exact card that store is already really selling
 * elsewhere in the current cart has already spoken for that much stock.
 * Only the remainder is actually available here; skipping this check would
 * let a store's already-fully-committed stock look free to pull from twice.
 *
 * Returns { custo, porLoja: Map<loja, { qtd, custo }> }, or null if the
 * offers available within `lojasAbertas` can't cover `qtd` (this card
 * doesn't have enough free stock there). `porLoja` carries each
 * destination's own quantity and cost (not just its share of the total) so
 * callers can show exactly how much moves where, and at what price, when a
 * card ends up split across more than one store.
 */
function preencherCarta(consolidado, chaveBusca, lojasAbertas, qtd) {
  const ofertas = consolidado.ofertas.get(chaveBusca) ?? [];
  const jaRealRestante = new Map(); // loja -> quantidade real ainda a descontar das ofertas dessa loja
  let restante = qtd;
  let custo = 0;
  const porLoja = new Map();

  for (const oferta of ofertas) {
    if (restante <= 0) break;
    if (!lojasAbertas.has(oferta.loja)) continue;

    if (!jaRealRestante.has(oferta.loja)) {
      jaRealRestante.set(oferta.loja, consolidado.cartasPorLoja.get(oferta.loja)?.get(chaveBusca)?.qtd ?? 0);
    }
    const aDescontar = Math.min(oferta.iQuant, jaRealRestante.get(oferta.loja));
    jaRealRestante.set(oferta.loja, jaRealRestante.get(oferta.loja) - aDescontar);
    const livre = oferta.iQuant - aDescontar;

    const usar = Math.min(restante, livre);
    if (usar <= 0) continue;
    const custoAqui = usar * oferta.preco;
    custo += custoAqui;
    const atual = porLoja.get(oferta.loja) ?? { qtd: 0, custo: 0 };
    atual.qtd += usar;
    atual.custo += custoAqui;
    porLoja.set(oferta.loja, atual);
    restante -= usar;
  }

  return restante > 0 ? null : { custo, porLoja };
}

/**
 * For one candidate card, finds which of the store(s) it's REALLY currently
 * bought from (card.porLoja) become closeable once it's dropped, and what
 * that actually costs: every OTHER card really bought at that store has to
 * be refilled from the stores that stay open, and that refill can be more
 * (or less) expensive than what's being paid today. The net saving for a
 * store is its shipping fee minus the sum of those refill deltas -- a store
 * only counts as "closing" if that net is positive; otherwise closing it
 * isn't actually worth it, and it's left out entirely (no partial credit,
 * no listing it as closing while secretly keeping it open).
 *
 * Deliberately local to the candidate's own store(s): a store that merely
 * also sells the candidate (its "outras cartas disponíveis", never actually
 * the one it's bought from) is never touched, since removing the candidate
 * changes nothing there. And a store the candidate is ALSO bought from is
 * never used as a relocation target for another of its stores' cards --
 * it's under consideration for closing in this same pass, so relying on its
 * capacity would be circular.
 *
 * When a candidate is really bought across SEVERAL stores and only some of
 * them can close, only THOSE stores' portion of the candidate counts as
 * "its own price" saved -- the portion still sourced from a store that
 * isn't closing (because it can't, or simply wasn't touched) keeps being
 * bought exactly as today, so nothing about it actually changes. That
 * portion is why each closing store carries its own `valorCandidato`/
 * `qtdCandidato` instead of the caller using the candidate's grand total.
 *
 * Returns { economia, lojasFechando }, where lojasFechando is
 * [{ nome, frete, valorCandidato, qtdCandidato, realocacoes }] and each
 * realocacao is { nome, qtd, precoAntes, precoDepois, delta, destino }, where
 * destino is [[loja, { qtd, custo }], ...] -- a card's units can end up
 * split across more than one destination store, see preencherCarta.
 */
function analisarFechamentosCandidato(consolidado, card) {
  const lojasCandidato = [...card.porLoja.keys()];
  const lojasCandidatoSet = new Set(lojasCandidato);
  const lojaPorNome = new Map(consolidado.lojas.map((l) => [l.nome, l]));
  const lojasParaRealocar = new Set(
    consolidado.lojas.map((l) => l.nome).filter((nome) => !lojasCandidatoSet.has(nome)),
  );

  const lojasFechando = [];

  for (const loja of lojasCandidato) {
    const outras = [...(consolidado.cartasPorLoja.get(loja) ?? new Map())].filter(
      ([chave]) => chave !== card.chaveBusca,
    );
    const lojaInfo = lojaPorNome.get(loja);
    const { qtd: qtdCandidato, valor: valorCandidato } = card.porLoja.get(loja);

    if (outras.length === 0) {
      lojasFechando.push({ nome: loja, frete: lojaInfo.frete, valorCandidato, qtdCandidato, realocacoes: [] });
      continue;
    }

    let somaDeltas = 0;
    const realocacoes = [];
    let inviavel = false;
    for (const [chaveOutra, info] of outras) {
      const preenchido = preencherCarta(consolidado, chaveOutra, lojasParaRealocar, info.qtd);
      if (!preenchido) {
        inviavel = true;
        break;
      }
      const delta = preenchido.custo - info.valor;
      somaDeltas += delta;
      realocacoes.push({
        nome: info.nome,
        qtd: info.qtd,
        precoAntes: info.valor,
        precoDepois: preenchido.custo,
        delta,
        destino: [...preenchido.porLoja], // [loja, { qtd, custo }][] -- can span more than one store
      });
    }
    if (inviavel) continue; // something at this store is exclusive to it -- can't close, whatever else is true
    if (lojaInfo.frete - somaDeltas <= 0) continue; // relocating everything else costs more than the shipping saved

    lojasFechando.push({ nome: loja, frete: lojaInfo.frete, valorCandidato, qtdCandidato, realocacoes, somaDeltas });
  }

  const economia = lojasFechando.reduce((soma, l) => soma + l.frete - (l.somaDeltas ?? 0), 0);
  return { economia, lojasFechando };
}

/**
 * Cards worth analyzing: proportionally significant to this specific
 * purchase -- a R$5 card matters in a R$100 purchase and doesn't in a
 * R$2000 one -- plus, unconditionally, any card that's the only thing
 * available from some store (the "anchor" case that motivated this
 * feature: a single expensive/exclusive card dragging a store's whole
 * shipping fee along with it, even when that card's own price doesn't
 * clear the proportional bar).
 */
function selecionarCandidatos(consolidado) {
  const totalCards = consolidado.cards.reduce((soma, c) => soma + c.valorAtual, 0);
  const limiar = Math.max(ANALISE_LIMIAR_PCT * totalCards, ANALISE_PISO_ABS);

  const porValorDesc = [...consolidado.cards].sort((a, b) => b.valorAtual - a.valorAtual);

  const escolhidos = new Map();
  for (const card of porValorDesc) {
    if (escolhidos.size >= ANALISE_TOP_N) break;
    if (card.valorAtual >= limiar) escolhidos.set(card.chaveBusca, card);
  }
  for (const card of consolidado.cards) {
    if (lojasQueOferecem(consolidado, card.chaveBusca).length === 1) {
      escolhidos.set(card.chaveBusca, card);
    }
  }
  return [...escolhidos.values()];
}

function formatarMoeda(valor) {
  return valor.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Human-readable step-by-step for the accordion: what to remove, what moves where, what's saved. */
function construirInstrucoes(card, analise, totalAtual) {
  const linhas = [];

  const lojasAtuais = [...card.porLoja.keys()];
  const lojasFechandoNomes = new Set(analise.lojasFechando.map((l) => l.nome));
  const lojasQueFicam = lojasAtuais.filter((nome) => !lojasFechandoNomes.has(nome));
  const valorFechando = analise.lojasFechando.reduce((s, l) => s + l.valorCandidato, 0);

  if (lojasQueFicam.length === 0) {
    // The candidate closes every store it's really bought from -- dropping
    // it means dropping it everywhere, so "própria carta" below is its full
    // price, same as always.
    const lojasAtuaisTexto = lojasAtuais.map((nome) => `${card.porLoja.get(nome).qtd}x ${nome}`).join(" + ");
    linhas.push(`Remova "${card.nome}" da lista (comprado hoje em ${lojasAtuaisTexto}).`);
  } else {
    // Only some of the candidate's stores can actually close -- the portion
    // still sourced from a store that isn't closing keeps being bought
    // exactly as today (that store is paying its own shipping regardless),
    // so only the closing stores' portion is actually being given up here.
    const partes = analise.lojasFechando
      .map((l) => `${l.qtdCandidato}x em "${l.nome}" (R$ ${formatarMoeda(l.valorCandidato)})`)
      .join(", ");
    linhas.push(
      `Deixe de comprar "${card.nome}" ${partes} -- o restante (comprado em ${lojasQueFicam.join(" + ")}) ` +
        "continua normalmente.",
    );
  }

  for (const loja of analise.lojasFechando) {
    for (const realoc of loja.realocacoes) {
      // Pooled fill can and does split a single card's units across more
      // than one destination store (see preencherCarta) -- one line per
      // destination, each with its own quantity and its own price delta
      // (computed against that portion's share of the original price), so
      // "retire 3" never quietly means "buy 1 here, 2 there" without saying
      // so.
      const precoUnitarioAntes = realoc.precoAntes / realoc.qtd;
      for (const [nomeLoja, { qtd: qtdAqui, custo: custoAqui }] of realoc.destino) {
        const deltaAqui = custoAqui - qtdAqui * precoUnitarioAntes;
        const sinal = deltaAqui >= 0 ? "aumentando" : "reduzindo";
        linhas.push(
          `Retire ${qtdAqui}x "${realoc.nome}" da loja "${loja.nome}" e compre ${qtdAqui}x em ${nomeLoja}, ` +
            `${sinal} o custo em R$ ${formatarMoeda(Math.abs(deltaAqui))}.`,
        );
      }
    }
    linhas.push(`A loja "${loja.nome}" sai da compra — economia de R$ ${formatarMoeda(loja.frete)} em frete.`);
  }

  const totalDepois = totalAtual - valorFechando - analise.economia;
  linhas.push(
    `Total: R$ ${formatarMoeda(totalAtual)} → R$ ${formatarMoeda(totalDepois)} ` +
      `(R$ ${formatarMoeda(valorFechando + analise.economia)} no total: R$ ${formatarMoeda(valorFechando)} ` +
      `da própria carta + R$ ${formatarMoeda(analise.economia)} de redistribuição).`,
  );
  return linhas;
}

// A card only counts as a savings opportunity if dropping it actually lets
// some cost be avoided beyond its own price -- a store closing and/or other
// cards it wasn't alone in needing reallocating, net of whatever that
// reallocation costs. This floor is just to swallow floating-point noise,
// not a real threshold.
const ANALISE_ECONOMIA_MINIMA = 0.01;

/**
 * Entry point. Every candidate is analyzed independently via
 * analisarFechamentosCandidato() -- each only ever touches the store(s) it's
 * really bought from, so this is cheap (no 2^n subset search of any kind)
 * and yields periodically just so a long candidate list doesn't block the
 * tab outright.
 */
async function analisarEconomiaAsync(resultado) {
  const consolidado = consolidarResultado(resultado);

  const totalCardsAtual = consolidado.cards.reduce((soma, c) => soma + c.valorAtual, 0);

  if (consolidado.lojasSemFrete.length > 0) {
    // Refuse to run rather than silently treating a not-yet-calculated
    // shipping fee as R$0 -- see consolidarResultado's doc comment.
    return {
      consolidado,
      baseline: null,
      totalCardsAtual,
      totalFreteAtual: null,
      resultados: [],
      lojasSemFrete: consolidado.lojasSemFrete,
    };
  }

  const totalFreteAtual = consolidado.lojas.reduce((soma, l) => soma + l.frete, 0);
  const totalAtual = totalCardsAtual + totalFreteAtual;
  const candidatos = selecionarCandidatos(consolidado);

  const resultados = [];
  for (let i = 0; i < candidatos.length; i++) {
    const card = candidatos[i];
    const analise = analisarFechamentosCandidato(consolidado, card);

    if (analise.economia > ANALISE_ECONOMIA_MINIMA) {
      // Own-price shown for this row is scoped to the store(s) that actually
      // close -- if the candidate is also bought at a store that can't (or
      // isn't being) closed, that portion isn't part of this suggestion at
      // all and shouldn't be counted as savings (see construirInstrucoes).
      const valorFechando = analise.lojasFechando.reduce((s, l) => s + l.valorCandidato, 0);
      resultados.push({
        chaveBusca: card.chaveBusca,
        nome: card.nome,
        valorAtual: valorFechando,
        economia: analise.economia,
        lojasQueSaem: analise.lojasFechando.map((l) => l.nome),
        instrucoes: construirInstrucoes(card, analise, totalAtual),
      });
    }
    if (i % 5 === 4) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  resultados.sort((a, b) => b.economia - a.economia);
  return { consolidado, baseline: totalAtual, totalCardsAtual, totalFreteAtual, resultados };
}

// Bumped whenever the report's shape or the meaning of `economia` changes,
// so a previously-cached analysis (computed under different semantics) is
// never mistaken for a fresh one and shown as-is.
const ANALISE_CACHE_VERSION = 4;

/** Cheap fingerprint of a search result, to know whether a cached analysis is still current. */
function hashResultado(resultado) {
  const blocos = Object.values(resultado ?? {}).filter(Boolean);
  const partes = blocos
    .map((b) => `${b.loja}:${b.contadorPreco}:${b.contadorItens}:${b.frete}`)
    .sort();
  return `v${ANALISE_CACHE_VERSION}|${blocos.length}|${partes.join("|")}`;
}

function formatarRelatorioTexto(relatorio) {
  const linhas = [];
  linhas.push("Análise de Economia — Compra por Lista");
  linhas.push(
    `Total atual: R$ ${formatarMoeda(relatorio.totalCardsAtual + relatorio.totalFreteAtual)} ` +
      `(${relatorio.consolidado.lojas.length} loja(s), R$ ${formatarMoeda(relatorio.totalFreteAtual)} de frete)`,
  );
  linhas.push(
    "Estimativa: considera só as lojas já presentes neste resultado e assume o frete atual de cada uma. " +
      "\"Economiza\" é só a parte por redistribuição (loja fechando e/ou cartas realocadas) -- não inclui " +
      "o preço da própria carta removida.",
  );
  linhas.push("");

  if (relatorio.resultados.length === 0) {
    linhas.push(
      "Nenhuma economia por redistribuição encontrada: todas as lojas continuam necessárias mesmo sem " +
        "as cartas mais caras da lista.",
    );
  } else {
    relatorio.resultados.forEach((item, i) => {
      linhas.push(`${i + 1}. ${item.nome} — economiza R$ ${formatarMoeda(item.economia)} (por redistribuição)`);
      item.instrucoes.forEach((l) => linhas.push(`   ${l}`));
      linhas.push("");
    });
  }

  return linhas.join("\n");
}

// ── UI ───────────────────────────────────────────────────────────────────────
// Everything below touches the DOM/chrome.* APIs and doesn't run under the
// node-based solver tests. Guarded so loading this file in a bare vm context
// (no `document`) exercises only the solver above.
if (typeof document !== "undefined") {
  const analiseLog = (...args) => log("[Análise de Economia]", ...args);

  function buildAnaliseButton() {
    const button = document.createElement("div");
    button.id = "lgm-analise-economia-btn";
    button.className = "botao";
    button.style.cssText = "cursor: pointer; display: block; width: fit-content; margin: 8px auto 0 auto;";
    button.textContent = "Análise de Economia";
    applySamvStyle(button);
    return button;
  }

  function injectAnaliseButton() {
    if (document.getElementById("lgm-analise-economia-btn")) return true;
    const finalizarBtn = document.getElementById("btn-finalizar");
    if (!finalizarBtn) return false;

    const button = buildAnaliseButton();
    finalizarBtn.parentElement.appendChild(button);
    button.addEventListener("click", () => handleAnaliseClick(button));

    analiseLog('Injected "Análise de Economia" button.');
    return true;
  }

  function buildModalShell() {
    const overlay = document.createElement("div");
    overlay.id = "lgm-analise-overlay";
    overlay.style.cssText =
      "position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 9999; " +
      "display: flex; align-items: center; justify-content: center; padding: 20px;";

    const modal = document.createElement("div");
    modal.style.cssText =
      "background: #fff; border-radius: 8px; width: min(720px, 100%); max-height: 86vh; " +
      "display: flex; flex-direction: column; overflow: hidden; " +
      "box-shadow: 0 8px 30px rgba(0,0,0,0.35); font-size: 13px; color: #222; font-family: inherit;";

    overlay.appendChild(modal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    const escHandler = (e) => {
      if (e.key === "Escape") {
        overlay.remove();
        document.removeEventListener("keydown", escHandler);
      }
    };
    document.addEventListener("keydown", escHandler);

    return { overlay, modal };
  }

  function buildHeader(relatorio, fromCache, onRecalcular) {
    const header = document.createElement("div");
    header.style.cssText = "padding: 16px 20px; border-bottom: 1px solid #eee; flex-shrink: 0;";

    const titleRow = document.createElement("div");
    titleRow.style.cssText = "display: flex; align-items: center; justify-content: space-between; gap: 12px;";

    const title = document.createElement("div");
    title.style.cssText = "font-size: 16px; font-weight: 700;";
    title.textContent = "Análise de Economia";
    titleRow.appendChild(title);

    const controls = document.createElement("div");
    controls.style.cssText = "display: flex; align-items: center; gap: 10px;";

    if (fromCache) {
      const recalcBtn = document.createElement("button");
      recalcBtn.type = "button";
      recalcBtn.textContent = "Recalcular";
      recalcBtn.style.cssText =
        "padding: 4px 10px; border: 1px solid #ccc; border-radius: 4px; background: #fff; " +
        "cursor: pointer; font-size: 12px; font-family: inherit;";
      recalcBtn.addEventListener("click", onRecalcular);
      controls.appendChild(recalcBtn);
    }

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "✕";
    closeBtn.style.cssText = "border: none; background: none; font-size: 16px; cursor: pointer; line-height: 1;";
    closeBtn.addEventListener("click", () => document.getElementById("lgm-analise-overlay")?.remove());
    controls.appendChild(closeBtn);

    titleRow.appendChild(controls);
    header.appendChild(titleRow);

    const totalAtual = relatorio.totalCardsAtual + relatorio.totalFreteAtual;
    const summary = document.createElement("div");
    summary.style.cssText = "margin-top: 6px; font-size: 13px; color: #444;";
    summary.textContent =
      `Total atual: R$ ${formatarMoeda(totalAtual)} ` +
      `(${relatorio.consolidado.lojas.length} loja(s), R$ ${formatarMoeda(relatorio.totalFreteAtual)} de frete)` +
      (fromCache ? " — resultado salvo" : "");
    header.appendChild(summary);

    const aviso = document.createElement("div");
    aviso.style.cssText = "margin-top: 6px; font-size: 11px; color: #888; font-style: italic;";
    aviso.textContent =
      'Estimativa — considera apenas as lojas já presentes neste resultado e assume o frete atual de ' +
      'cada loja. Cada "economiza" abaixo é só a parte por redistribuição (loja fechando e/ou cartas ' +
      "realocadas), sem contar o preço da própria carta removida.";
    header.appendChild(aviso);

    return header;
  }

  function buildRow(item) {
    const row = document.createElement("div");
    row.style.cssText = "border-bottom: 1px solid #eee;";

    const head = document.createElement("button");
    head.type = "button";
    head.style.cssText =
      "width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 12px; " +
      "padding: 10px 20px; background: none; border: none; cursor: pointer; font-size: 13px; " +
      "text-align: left; font-family: inherit;";

    const left = document.createElement("span");
    left.style.cssText = "display: flex; align-items: center; gap: 8px; min-width: 0;";
    const caret = document.createElement("span");
    caret.textContent = "▸";
    caret.style.cssText = "display: inline-block; transition: transform 0.15s; flex-shrink: 0;";
    left.appendChild(caret);
    const nome = document.createElement("span");
    nome.textContent = item.nome;
    nome.style.cssText = "overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    left.appendChild(nome);
    head.appendChild(left);

    const economiaLabel = document.createElement("span");
    economiaLabel.style.cssText = "font-weight: 700; white-space: nowrap; flex-shrink: 0; color: #1a7f37;";
    economiaLabel.textContent = `economiza R$ ${formatarMoeda(item.economia)}`;
    economiaLabel.title =
      "Economia por redistribuição: não inclui o preço da própria carta, só o que sobra de fechar " +
      "loja(s) e/ou realocar as outras cartas para ofertas mais baratas.";
    head.appendChild(economiaLabel);

    row.appendChild(head);

    const body = document.createElement("div");
    body.style.cssText = "display: none; padding: 0 20px 14px 40px; font-size: 12px; color: #333;";
    item.instrucoes.forEach((linha) => {
      const p = document.createElement("div");
      p.style.cssText = "margin-top: 4px;";
      p.textContent = linha;
      body.appendChild(p);
    });
    row.appendChild(body);

    head.addEventListener("click", () => {
      const aberto = body.style.display !== "none";
      body.style.display = aberto ? "none" : "block";
      caret.style.transform = aberto ? "rotate(0deg)" : "rotate(90deg)";
    });

    return row;
  }

  function buildBody(relatorio) {
    const body = document.createElement("div");
    body.style.cssText = "overflow-y: auto; flex: 1;";

    if (relatorio.resultados.length === 0) {
      const vazio = document.createElement("div");
      vazio.style.cssText = "padding: 24px 20px; color: #666; text-align: center;";
      vazio.textContent =
        "Nenhuma economia por redistribuição encontrada: todas as lojas deste resultado continuam " +
        "necessárias mesmo sem as cartas mais caras da lista.";
      body.appendChild(vazio);
      return body;
    }

    relatorio.resultados.forEach((item) => body.appendChild(buildRow(item)));
    return body;
  }

  function buildFooter(relatorio) {
    const footer = document.createElement("div");
    footer.style.cssText =
      "padding: 12px 20px; border-top: 1px solid #eee; display: flex; justify-content: flex-end; " +
      "gap: 8px; flex-shrink: 0;";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.textContent = "Copiar análise";
    copyBtn.style.cssText =
      "padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer; font-weight: 700; font-family: inherit;";
    applySamvStyle(copyBtn);
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(formatarRelatorioTexto(relatorio));
        showCopiedFeedback(copyBtn);
      } catch (err) {
        analiseLog("Falha ao copiar análise —", err.message);
      }
    });
    footer.appendChild(copyBtn);

    return footer;
  }

  function showModal(relatorio, fromCache, onRecalcular) {
    document.getElementById("lgm-analise-overlay")?.remove();
    const { overlay, modal } = buildModalShell();
    modal.appendChild(buildHeader(relatorio, fromCache, onRecalcular));
    modal.appendChild(buildBody(relatorio));
    modal.appendChild(buildFooter(relatorio));
    document.body.appendChild(overlay);
  }

  /** A simple message box, reusing the same shell the results modal uses. */
  function mostrarAviso(titulo, mensagem) {
    document.getElementById("lgm-analise-overlay")?.remove();
    const { overlay, modal } = buildModalShell();

    const header = document.createElement("div");
    header.style.cssText =
      "padding: 16px 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px;";
    const title = document.createElement("div");
    title.style.cssText = "font-size: 15px; font-weight: 700;";
    title.textContent = titulo;
    header.appendChild(title);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "✕";
    closeBtn.style.cssText = "border: none; background: none; font-size: 16px; cursor: pointer; line-height: 1;";
    closeBtn.addEventListener("click", () => overlay.remove());
    header.appendChild(closeBtn);
    modal.appendChild(header);

    const body = document.createElement("div");
    body.style.cssText = "padding: 0 20px 20px; font-size: 13px; color: #333; line-height: 1.5;";
    body.textContent = mensagem;
    modal.appendChild(body);

    document.body.appendChild(overlay);
  }

  /**
   * LigaMagic writes each store's shipping fee asynchronously, after the
   * results are already on screen (see consolidarResultado's doc comment on
   * lojasSemFrete) -- while that AJAX call is in flight, the page itself
   * shows a "Calculando frete..." block with this ID, hidden the rest of the
   * time via its own "d-none" class. A plain DOM read works fine from this
   * content script even though it's a page-owned element, since content
   * scripts share the real DOM (just not the page's JS globals).
   */
  function freteAindaCalculando() {
    const indicador = document.getElementById("main_calculando_fretes");
    return !!indicador && !indicador.classList.contains("d-none");
  }

  function esperarFreteCalculado(timeoutMs = 12_000, intervalMs = 400) {
    return new Promise((resolve) => {
      const prazo = Date.now() + timeoutMs;
      const checar = () => {
        if (!freteAindaCalculando()) return resolve(true);
        if (Date.now() >= prazo) return resolve(false);
        setTimeout(checar, intervalMs);
      };
      checar();
    });
  }

  /**
   * Waits out an in-progress shipping calculation (if any) before reading
   * the result, so the analysis never runs against a mid-calculation
   * snapshot. `resultado` on the returned object reflects whatever the page
   * has right after that wait -- still checked for per-store completeness
   * downstream (analisarEconomiaAsync's lojasSemFrete), since a store can
   * finish that AJAX round-trip with no shipping option at all.
   */
  async function aguardarFreteEObterResultado(button) {
    if (freteAindaCalculando()) {
      const originalLabel = button.textContent;
      button.textContent = "Aguardando frete...";
      button.style.pointerEvents = "none";
      const pronto = await esperarFreteCalculado();
      button.textContent = originalLabel;
      button.style.pointerEvents = "";
      if (!pronto) {
        mostrarAviso(
          "Frete ainda calculando",
          'O cálculo do frete das lojas ainda não terminou. Aguarde o aviso "Calculando frete..." ' +
            "sumir da tela e tente novamente.",
        );
        return { abortado: true };
      }
    }
    return { abortado: false, resultado: await sendMessage({ action: "getListaResultado" }) };
  }

  async function runAndCache(resultado, hash) {
    const relatorio = await analisarEconomiaAsync(resultado);
    // Only cache a real result -- an incomplete one (missing frete) would
    // otherwise sit in the cache slot under a hash that's likely to be
    // superseded the moment shipping actually finishes calculating anyway.
    if (relatorio.baseline != null) {
      sendMessage({ action: "saveSettings", settings: { analiseEconomiaCache: { hash, relatorio } } });
    }
    return relatorio;
  }

  async function handleAnaliseClick(button, forcarRecalculo = false) {
    const { abortado, resultado } = await aguardarFreteEObterResultado(button);
    if (abortado) return;
    if (!resultado || Object.keys(resultado).length === 0) {
      analiseLog("Nenhum resultado de busca encontrado.");
      return;
    }

    const hash = hashResultado(resultado);

    if (!forcarRecalculo) {
      const settings = await getSettings();
      const cache = settings?.analiseEconomiaCache;
      if (cache && cache.hash === hash) {
        showModal(cache.relatorio, true, () => handleAnaliseClick(button, true));
        return;
      }
    }

    const originalLabel = button.textContent;
    button.textContent = "Calculando...";
    button.style.pointerEvents = "none";
    try {
      const relatorio = await runAndCache(resultado, hash);
      if (relatorio.lojasSemFrete?.length > 0) {
        mostrarAviso(
          "Frete pendente",
          `Selecione uma forma de envio para: ${relatorio.lojasSemFrete.join(", ")}. ` +
            "A análise precisa do frete de cada loja pra ser precisa.",
        );
        return;
      }
      showModal(relatorio, false, () => handleAnaliseClick(button, true));
    } catch (err) {
      analiseLog("Falha ao calcular a análise —", err.message);
    } finally {
      button.textContent = originalLabel;
      button.style.pointerEvents = "";
    }
  }

  function initAnaliseEconomia() {
    if (!isListaCardsPage()) return;

    getSettings().then((settings) => {
      if (settings?.addAnaliseEconomia === false) return;

      if (injectAnaliseButton()) return;

      // Results only exist after a search, and "Pesquisar Novamente" replaces
      // the whole results section (removing our button with it) -- same
      // pattern lista-copy-button.js uses to survive re-searches.
      new MutationObserver(() => injectAnaliseButton()).observe(document.body, {
        childList: true,
        subtree: true,
      });
    });
  }

  initAnaliseEconomia();
}
