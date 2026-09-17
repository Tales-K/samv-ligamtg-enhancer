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
 * applySamvStyle), lista-defaults.js (isListaCardsPage)
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
 *     `porLoja` is a Map<lojaNome, { qtd, valor, bloco, linha }>: the actual
 *     current purchase split straight from each block's quantidade > 0
 *     entries -- this, not any recomputation, is what "bought at store X"
 *     means throughout this file. `bloco`/`linha` locate the real DOM row
 *     for that store+card (`#item_<bloco>_<linha>`), needed by
 *     aplicarPlanoNaTela() to actually carry out a suggestion; if the same
 *     card+store somehow appears as more than one row, only the first one's
 *     coordinates are kept (stores don't normally list the same card twice).
 *   - ofertas: Map<chaveBusca, [{ preco, iQuant, loja, bloco, linha }]> --
 *     EVERY offer for that card, from every store, regardless of whether
 *     it's the one currently bought from (includes quantidade:0 "outras
 *     cartas disponíveis" entries -- those are exactly the alternatives a
 *     relocation would use, and their bloco/linha is exactly the hidden,
 *     already-interactive row a relocation writes its new quantity into).
 *     Flat (not grouped by store) and sorted by price, because refilling a
 *     card within a set of stores pools the cheapest offers across all of
 *     them together -- see preencherCarta().
 *   - cartasPorLoja: Map<lojaNome, Map<chaveBusca, { nome, qtd, valor, bloco, linha }>> --
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
  // Object.entries (not .values) so the numeric block key survives -- it's
  // the "bloco" half of every #item_<bloco>_<linha> DOM row this file needs
  // to locate later, and Object.values would discard it.
  const blocosEntries = Object.entries(resultado ?? {}).filter(([, b]) => Boolean(b));
  const lojas = blocosEntries.map(([, b]) => ({ nome: b.nomeLoja, frete: b.frete }));
  const lojasSemFrete = lojas
    .filter((l) => typeof l.frete !== "number" || Number.isNaN(l.frete))
    .map((l) => l.nome);

  const ofertas = new Map();
  const cardsMap = new Map();

  for (const [blocoKey, bloco] of blocosEntries) {
    const blocoIndex = Number(blocoKey);
    const cartas = bloco.cartas ?? [];
    for (let linha = 0; linha < cartas.length; linha++) {
      const carta = cartas[linha];
      if (!carta) continue;
      const chave = carta.chaveBusca;

      if (!ofertas.has(chave)) ofertas.set(chave, []);
      ofertas.get(chave).push({
        preco: carta.preco,
        iQuant: carta.iQuant ?? 0,
        loja: bloco.nomeLoja,
        bloco: blocoIndex,
        linha,
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
        const emLoja = atual.porLoja.get(bloco.nomeLoja) ?? {
          qtd: 0,
          valor: 0,
          bloco: blocoIndex,
          linha,
        };
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
      cartasPorLoja.get(loja).set(card.chaveBusca, {
        nome: card.nome,
        qtd: info.qtd,
        valor: info.valor,
        bloco: info.bloco,
        linha: info.linha,
      });
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
 * Returns { custo, porLoja: Map<loja, { qtd, custo, bloco, linha }> }, or
 * null if the offers available within `lojasAbertas` can't cover `qtd` (this
 * card doesn't have enough free stock there). `porLoja` carries each
 * destination's own quantity and cost (not just its share of the total) so
 * callers can show exactly how much moves where, and at what price, when a
 * card ends up split across more than one store -- plus that destination's
 * own bloco/linha, so a caller can actually write the moved quantity into
 * its real (already interactive, if currently hidden) DOM row.
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
    const atual = porLoja.get(oferta.loja) ?? { qtd: 0, custo: 0, bloco: oferta.bloco, linha: oferta.linha };
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
  if (lojasCandidato.length === 0) return { economia: 0, lojasFechando: [] };

  // Which of the candidate's own stores close is one decision, not several:
  // a store that ends up staying open is a legitimate destination for
  // another one's cards, and evaluating each store against a fixed set that
  // excluded ALL of them (which is what this used to do) understates every
  // relocation. Enumerated rather than approximated -- a card is bought at
  // one or two stores in practice, so this is a handful of combinations.
  const melhor = melhorFechamento(consolidado, {
    candidatas: lojasCandidato,
    ignorarChave: card.chaveBusca,
  });
  if (!melhor) return { economia: 0, lojasFechando: [] };

  // The candidate's own price only counts as saved for the stores that
  // actually close -- whatever portion of it is bought at a store that
  // stays open keeps being bought exactly as today.
  const realocacoesPorOrigem = new Map();
  for (const realoc of melhor.realocacoes) {
    if (!realocacoesPorOrigem.has(realoc.origem)) realocacoesPorOrigem.set(realoc.origem, []);
    realocacoesPorOrigem.get(realoc.origem).push(realoc);
  }

  const lojasFechando = melhor.lojas.map((loja) => {
    const { qtd: qtdCandidato, valor: valorCandidato, linha } = card.porLoja.get(loja.nome);
    return {
      nome: loja.nome,
      frete: loja.frete,
      valorCandidato,
      qtdCandidato,
      bloco: loja.bloco,
      linha,
      realocacoes: [...(realocacoesPorOrigem.get(loja.nome) ?? [])],
    };
  });
  // A relocation whose demand was pooled across more than one closing store
  // belongs to the plan as a whole, not to any single store's row -- park it
  // on the first one so construirPlanoAplicacao still emits it exactly once.
  for (const [origem, lista] of realocacoesPorOrigem) {
    if (!origem.includes(" / ")) continue;
    lojasFechando[0].realocacoes.push(...lista);
  }

  return { economia: melhor.economia, lojasFechando };
}

/**
 * Turns a list of realocacoes (as produced by analisarFechamentosCandidato
 * or avaliarFechamentoConjunto) into the DOM writes that move each card to
 * its destination(s): rows to add `qtd` units to, on top of whatever they
 * already have (already net of that store's own existing real quantity, see
 * preencherCarta, so this is always the correct amount to add, never to
 * overwrite). The source rows themselves need no explicit action here --
 * every realocacao's source is always a card at the store the plano is
 * closing, and closing a store (see fecharLojas on the plano this feeds
 * into) already drops every one of its cards in a single step.
 */
function planoDeRealocacoes(realocacoes) {
  const incrementar = [];
  for (const realoc of realocacoes) {
    for (const [, info] of realoc.destino) {
      incrementar.push({ bloco: info.bloco, linha: info.linha, qtd: info.qtd });
    }
  }
  return incrementar;
}

/**
 * Structured, DOM-executable version of what construirInstrucoes() already
 * describes in prose for one candidate's suggestion -- consumed by
 * aplicarPlanoNaTela() to actually carry it out on the live results screen.
 * `fecharLojas` (bloco indices) are closed via the store's own "remover
 * todos os itens desta loja" control, never by removing cards one at a
 * time: LigaMagic keeps charging (and counting toward the total) a store's
 * shipping for as long as its own block is still part of the result, even
 * once every card bought there has been individually removed -- only that
 * control actually drops the block, and with it the shipping.
 */
function construirPlanoAplicacao(analise) {
  const incrementar = [];
  const fecharLojas = [];
  for (const loja of analise.lojasFechando) {
    fecharLojas.push(loja.bloco);
    incrementar.push(...planoDeRealocacoes(loja.realocacoes));
  }
  return { incrementar, fecharLojas };
}

// ── Reorganização (close a store without dropping any card) ────────────────────
/** The bloco index of a store, taken from any of its real purchases -- they all share it. */
function blocoDaLoja(consolidado, nomeLoja) {
  const cartas = consolidado.cartasPorLoja.get(nomeLoja);
  return cartas && cartas.size > 0 ? [...cartas.values()][0].bloco : null;
}

/**
 * Net saving of closing exactly the stores in `fechando`, without dropping
 * any card from the purchase: the shipping they stop charging, minus
 * however much more it costs to buy everything they were really selling
 * from the stores that stay open.
 *
 * Demand is pooled per card BEFORE refilling: a card really bought at two
 * of the closing stores becomes one refill of the combined quantity, never
 * two independent ones. preencherCarta only knows to discount the real
 * purchases still standing at the OPEN stores, so two separate calls would
 * both see the same free stock and could spend it twice.
 *
 * Still deliberately local: only stores already present in this result are
 * ever considered as a destination. Returns null when something the closing
 * stores sell can't be bought anywhere that stays open.
 */
function avaliarFechamentoConjunto(consolidado, fechando, opcoes = {}) {
  const { ignorarChave = null } = opcoes;
  if (fechando.length === 0) return null;

  const fechandoSet = new Set(fechando);
  const lojasAbertas = new Set(consolidado.lojas.map((l) => l.nome).filter((nome) => !fechandoSet.has(nome)));

  const demanda = new Map();
  for (const nomeLoja of fechando) {
    for (const [chave, info] of consolidado.cartasPorLoja.get(nomeLoja) ?? new Map()) {
      if (chave === ignorarChave) continue;
      const atual = demanda.get(chave) ?? { nome: info.nome, qtd: 0, valor: 0, origens: [] };
      atual.qtd += info.qtd;
      atual.valor += info.valor;
      atual.origens.push(nomeLoja);
      demanda.set(chave, atual);
    }
  }

  let somaDeltas = 0;
  const realocacoes = [];
  for (const [chave, info] of demanda) {
    const preenchido = preencherCarta(consolidado, chave, lojasAbertas, info.qtd);
    if (!preenchido) return null; // exclusive to a store being closed -- can't vacate it
    const delta = preenchido.custo - info.valor;
    somaDeltas += delta;
    realocacoes.push({
      nome: info.nome,
      origem: info.origens.join(" / "),
      qtd: info.qtd,
      precoAntes: info.valor,
      precoDepois: preenchido.custo,
      delta,
      destino: [...preenchido.porLoja], // can span more than one destination store, see preencherCarta
    });
  }

  const lojaPorNome = new Map(consolidado.lojas.map((l) => [l.nome, l]));
  const lojas = fechando.map((nome) => ({
    nome,
    frete: lojaPorNome.get(nome)?.frete ?? 0,
    bloco: blocoDaLoja(consolidado, nome),
  }));
  if (lojas.some((l) => l.bloco == null)) return null; // a store with nothing really bought has nothing to close

  const frete = lojas.reduce((soma, l) => soma + l.frete, 0);
  return {
    lojas,
    nome: lojas.map((l) => l.nome).join(" + "),
    frete,
    somaDeltas,
    realocacoes,
    economia: frete - somaDeltas,
  };
}

/**
 * Above this many stores actually selling something, the exhaustive pass
 * below falls back to a greedy one. 2^16 = 65536 combinations is still
 * milliseconds against a handful of cards; a real result has 5-8 stores, so
 * the fallback is a safety net, not the normal path.
 */
const ANALISE_MAX_LOJAS_EXAUSTIVO = 16;

/**
 * The single most profitable set of stores to close. Closing stores is the
 * ONLY way a reorganização saves anything (every card keeps being bought,
 * just somewhere else), so the whole decision is "which subset of the
 * stores currently selling something stops being used" -- and with a
 * handful of stores that subset can simply be enumerated instead of
 * approximated.
 *
 * This matters because closing stores is not separable: vacating A can make
 * B cheaper to vacate (A's cards were competing for the same stock B's
 * would move into) or more expensive (A was where B's cards would have
 * gone). Picking the single best store, committing to it, and repeating --
 * which is what this used to do -- lands on a worse answer whenever those
 * interactions matter. Measured against real discovery data (2026-09-16),
 * the greedy chain missed the optimum in ~7% of sampled carts, by up to
 * R$ 21,75.
 *
 * `ignorarChave` excludes one card from the refill, for the "remoção" half
 * of the analysis, where that card is being dropped rather than moved.
 */
function melhorFechamento(consolidado, opcoes = {}) {
  const candidatas = opcoes.candidatas ?? [...consolidado.cartasPorLoja.keys()];
  if (candidatas.length === 0) return null;

  let melhor = null;
  const considerar = (fechando) => {
    const avaliacao = avaliarFechamentoConjunto(consolidado, fechando, opcoes);
    if (!avaliacao || avaliacao.economia <= ANALISE_ECONOMIA_MINIMA) return null;
    if (!melhor || avaliacao.economia > melhor.economia) melhor = avaliacao;
    return avaliacao;
  };

  if (candidatas.length <= ANALISE_MAX_LOJAS_EXAUSTIVO) {
    for (let mascara = 1; mascara < 1 << candidatas.length; mascara++) {
      considerar(candidatas.filter((_, i) => mascara & (1 << i)));
    }
    return melhor;
  }

  // Fallback for an implausibly wide result: grow the closing set one store
  // at a time, keeping whichever addition helps most.
  const fechando = [];
  const restantes = [...candidatas];
  while (restantes.length > 0) {
    let passo = null;
    for (const nome of restantes) {
      const avaliacao = avaliarFechamentoConjunto(consolidado, [...fechando, nome], opcoes);
      if (!avaliacao) continue;
      if (!passo || avaliacao.economia > passo.avaliacao.economia) passo = { nome, avaliacao };
    }
    if (!passo || (melhor && passo.avaliacao.economia <= melhor.economia)) break;
    fechando.push(passo.nome);
    restantes.splice(restantes.indexOf(passo.nome), 1);
    if (passo.avaliacao.economia > ANALISE_ECONOMIA_MINIMA) melhor = passo.avaliacao;
  }
  return melhor;
}

/** Structured, DOM-executable version of a reorganização's realocacoes -- see construirPlanoAplicacao. */
function construirPlanoAplicacaoReorganizacao(reorg) {
  return {
    incrementar: planoDeRealocacoes(reorg.realocacoes),
    fecharLojas: reorg.lojas.map((l) => l.bloco),
  };
}

/**
 * What the "Economia por reorganização" list shows: one entry per store
 * that's worth vacating on its own, plus -- when the real optimum needs
 * more than one store to close at once and beats every single-store move --
 * that combined move at the top, since no per-store row would ever surface
 * it.
 */
function selecionarReorganizacoes(consolidado) {
  const resultados = [];
  for (const loja of consolidado.lojas) {
    const analise = avaliarFechamentoConjunto(consolidado, [loja.nome]);
    if (analise && analise.economia > ANALISE_ECONOMIA_MINIMA) resultados.push(analise);
  }
  resultados.sort((a, b) => b.economia - a.economia);

  const melhor = melhorFechamento(consolidado);
  if (melhor && melhor.lojas.length > 1 && (resultados.length === 0 || melhor.economia > resultados[0].economia)) {
    resultados.unshift(melhor);
  }
  return resultados;
}

/** Sum of every card really bought plus the frete of only the stores that really sell at least one of them -- the same "total atual" shape used throughout this file, factored out because maximizarReorganizacoes below needs it fresh at every step of a simulated chain, not just once at the top of analisarEconomiaAsync. */
function calcularTotalConsolidado(consolidado) {
  const lojasComCompra = new Set(consolidado.cartasPorLoja.keys());
  const totalCards = consolidado.cards.reduce((soma, c) => soma + c.valorAtual, 0);
  const totalFrete = consolidado.lojas
    .filter((l) => lojasComCompra.has(l.nome))
    .reduce((soma, l) => soma + l.frete, 0);
  return totalCards + totalFrete;
}

/**
 * The maximum a reorganização can actually save on this result: the economia
 * of the single best set of stores to close (see melhorFechamento), never
 * the sum of the per-store suggestions listed above -- two of those can
 * depend on the same relocation capacity, or on each other's store staying
 * open, so summing them double-counts.
 *
 * Returns { economiaTotal, lojas } -- lojas being the stores that close to
 * reach it, for display. A real DOM application should still re-derive its
 * plano from a fresh analysis after each step rather than trusting this one
 * (see aplicarTodasReorganizacoes in the UI half of this file, and its
 * counterpart in super-pesquisa.js), since the live page recalculates frete
 * as things move.
 */
function maximizarReorganizacoes(resultadoInicial) {
  const consolidado = consolidarResultado(resultadoInicial);
  if (consolidado.lojasSemFrete.length > 0) return { economiaTotal: 0, lojas: [] };
  const melhor = melhorFechamento(consolidado);
  if (!melhor) return { economiaTotal: 0, lojas: [] };
  return { economiaTotal: melhor.economia, lojas: melhor.lojas.map((l) => l.nome) };
}

/** Human-readable step-by-step for a reorganization: nothing is dropped, only moved. */
function construirInstrucoesReorganizacao(reorg, totalAtual) {
  const linhas = [];
  linhas.push(`Nenhuma carta precisa deixar de ser comprada — troque só a loja de origem:`);

  for (const realoc of reorg.realocacoes) {
    const precoUnitarioAntes = realoc.precoAntes / realoc.qtd;
    for (const [nomeLoja, { qtd: qtdAqui, custo: custoAqui }] of realoc.destino) {
      const deltaAqui = custoAqui - qtdAqui * precoUnitarioAntes;
      const sinal = deltaAqui >= 0 ? "aumentando" : "reduzindo";
      linhas.push(
        `Retire ${qtdAqui}x "${realoc.nome}" da loja "${realoc.origem}" e compre ${qtdAqui}x em ${nomeLoja}, ` +
          `${sinal} o custo em R$ ${formatarMoeda(Math.abs(deltaAqui))}.`,
      );
    }
  }

  const quais = reorg.lojas.map((l) => `"${l.nome}"`).join(" e ");
  linhas.push(
    reorg.lojas.length > 1
      ? `As lojas ${quais} saem da compra juntas, sem remover nenhuma carta — economia de ` +
          `R$ ${formatarMoeda(reorg.frete)} em frete. Fechar todas de uma vez rende mais do que ` +
          `fechar qualquer uma delas sozinha.`
      : `A loja ${quais} sai da compra sem remover nenhuma carta — economia de R$ ${formatarMoeda(reorg.frete)} em frete.`,
  );

  const totalDepois = totalAtual - reorg.economia;
  linhas.push(
    `Total: R$ ${formatarMoeda(totalAtual)} → R$ ${formatarMoeda(totalDepois)} ` +
      `(R$ ${formatarMoeda(reorg.economia)} de economia por reorganização).`,
  );
  return linhas;
}

/** Stores whose current shipping fee is above `limiar`, most expensive first. */
function selecionarLojasFreteCaro(consolidado, limiar) {
  return consolidado.lojas
    .filter((l) => typeof l.frete === "number" && l.frete > limiar)
    .sort((a, b) => b.frete - a.frete);
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
 *
 * Returns three independent sections, never mixed together:
 *   - resultados: "Economia de frete por remoção" -- drop an expensive/
 *     exclusive card, see analisarFechamentosCandidato.
 *   - reorganizacoes: "Economia por reorganização" -- keep buying every
 *     card, just from a different store, see avaliarFechamentoConjunto.
 *   - alertasFreteCaro: stores whose shipping fee alone is above
 *     `freteCaroLimiar`, regardless of whether either analysis above found
 *     anything to do about it.
 */
async function analisarEconomiaAsync(resultado, freteCaroLimiar = FRETE_CARO_LIMIAR_PADRAO) {
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
      reorganizacoes: [],
      alertasFreteCaro: [],
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
        plano: construirPlanoAplicacao(analise),
      });
    }
    if (i % 5 === 4) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  resultados.sort((a, b) => b.economia - a.economia);

  const reorganizacoes = selecionarReorganizacoes(consolidado).map((reorg) => ({
    nome: reorg.nome,
    frete: reorg.frete,
    economia: reorg.economia,
    instrucoes: construirInstrucoesReorganizacao(reorg, totalAtual),
    plano: construirPlanoAplicacaoReorganizacao(reorg),
  }));

  const alertasFreteCaro = selecionarLojasFreteCaro(consolidado, freteCaroLimiar).map((l) => ({
    nome: l.nome,
    frete: l.frete,
  }));

  // The actual maximum achievable by applying every viable reorganização in
  // sequence -- never the naive sum of `reorganizacoes[].economia` above,
  // since applying one can invalidate or change the value of another (see
  // maximizarReorganizacoes's own doc comment).
  const economiaMaximaReorganizacao = maximizarReorganizacoes(resultado).economiaTotal;

  return {
    consolidado,
    baseline: totalAtual,
    totalCardsAtual,
    totalFreteAtual,
    resultados,
    reorganizacoes,
    economiaMaximaReorganizacao,
    alertasFreteCaro,
    freteCaroLimiar,
  };
}

// Bumped whenever the report's shape or the meaning of `economia` changes,
// so a previously-cached analysis (computed under different semantics) is
// never mistaken for a fresh one and shown as-is. Bumped to 10 because both
// halves of the analysis now pick the best SET of stores to close instead of
// the best single one (see melhorFechamento), so `economia` on a cached
// report can differ from what the same cart reports now.
const ANALISE_CACHE_VERSION = 10;

/** Cheap fingerprint of a search result, to know whether a cached analysis is still current. */
function hashResultado(resultado) {
  const blocos = Object.values(resultado ?? {}).filter(Boolean);
  const partes = blocos
    .map((b) => `${b.loja}:${b.contadorPreco}:${b.contadorItens}:${b.frete}`)
    .sort();
  return `v${ANALISE_CACHE_VERSION}|${blocos.length}|${partes.join("|")}`;
}

// ── UI ───────────────────────────────────────────────────────────────────────
// Everything below touches the DOM/chrome.* APIs and doesn't run under the
// node-based solver tests. Guarded so loading this file in a bare vm context
// (no `document`) exercises only the solver above.
if (typeof document !== "undefined") {
  const analiseLog = (...args) => log("[Análise de Economia]", ...args);

  // Same 10px gap the site's own "Adicionar ao Carrinho" / "Finalizar
  // Compra" pair uses between each other, and the same full width as those
  // two -- so this reads as one consistent stack of 4 buttons, not two
  // native ones followed by two narrower, oddly-spaced extras.
  const ANALISE_BOTAO_GAP = "10px";

  function buildAnaliseButton() {
    const button = document.createElement("div");
    button.id = "lgm-analise-economia-btn";
    button.className = "botao";
    button.style.cssText =
      `cursor: pointer; display: block; width: 100%; box-sizing: border-box; ` +
      `text-align: center; margin-top: ${ANALISE_BOTAO_GAP};`;
    button.textContent = "Análise de Economia";
    applySamvStyle(button);
    return button;
  }

  /**
   * Caption shown above the button once an analysis (auto or manual) has
   * run and found reorganização savings. Sits between "Finalizar Compra"
   * and the button itself -- its own margin-top carries the 10px gap from
   * "Finalizar Compra" while it has something to say, collapsing to 0 when
   * empty so the button (which keeps its own fixed 10px top margin
   * regardless) still lands the same 10px below "Finalizar Compra" either
   * way.
   */
  function buildIndicadorEconomia() {
    const indicador = document.createElement("div");
    indicador.id = "lgm-analise-economia-indicador";
    indicador.style.cssText =
      "text-align: center; font-size: 11px; margin: 0 auto; width: fit-content; font-weight: 600;";
    return indicador;
  }

  /**
   * The "up to R$X" figure shown on the button itself -- deliberately just
   * "Economia por reorganização", not "Economia de frete por remoção" too:
   * reorganização never drops a card from the purchase, so applying every
   * viable one is a strict improvement with nothing given up, safe to
   * headline before the user has even opened the modal. Remoção trades away
   * an actual card, which isn't something to imply is "available savings"
   * before the user sees what's being given up for it.
   *
   * This is `relatorio.economiaMaximaReorganizacao` -- the real maximum from
   * chaining every viable reorganização (see maximizarReorganizacoes) -- and
   * NOT a sum of each listed suggestion's own `economia`: two suggestions
   * can depend on the same relocation capacity, or on each other's store
   * staying open, so applying one can shrink or wipe out what another was
   * worth. Summing them naively overstates what's actually achievable.
   */
  function calcularEconomiaTotalDisponivel(relatorio) {
    return relatorio.economiaMaximaReorganizacao ?? 0;
  }

  /** Shows or clears the caption -- see buildIndicadorEconomia for its own margin handling. */
  function renderIndicadorEconomia(indicador, relatorio) {
    if (!indicador) return;
    const total = relatorio?.baseline != null ? calcularEconomiaTotalDisponivel(relatorio) : 0;
    const temEconomia = total > ANALISE_ECONOMIA_MINIMA;

    indicador.textContent = temEconomia ? `💰 Até R$ ${formatarMoeda(total)} de economia disponível` : "";
    indicador.style.color = "#1a7f37";
    indicador.style.marginTop = temEconomia ? ANALISE_BOTAO_GAP : "0";
  }

  /**
   * Computes (from cache when possible, so this never redoes work a manual
   * click or a previous auto-check already did for the same result) and
   * shows the savings caption -- entirely local, no LigaMagic request of any
   * kind beyond the same getListaResultado round-trip the button's own click
   * handler already uses.
   *
   * Returns whether it actually found a different result than the last one it
   * analyzed. initAnaliseReativa keys the modal rebuild off that: rebuilding
   * on every trigger would put the modal's own DOM churn back through the
   * observer that triggered it.
   */
  let ultimoHashIndicador = null;
  async function atualizarIndicadorEconomia(indicador) {
    if (freteAindaCalculando()) return false;
    const resultado = await sendMessage({ action: "getListaResultado" });
    if (!resultado || Object.keys(resultado).length === 0) return false;

    const hash = hashResultado(resultado);
    if (hash === ultimoHashIndicador) return false;

    const settings = await getSettings();
    if (settings?.addAnaliseEconomia === false) return false;
    const freteCaroLimiar = Number(settings?.freteCaroLimiar) || FRETE_CARO_LIMIAR_PADRAO;

    const cache = settings?.analiseEconomiaCache;
    const relatorio =
      cache?.hash === hash ? cache.relatorio : await runAndCache(resultado, hash, freteCaroLimiar);
    if (relatorio.baseline == null) return false; // frete de alguma loja ainda pendente -- não mostra nada ainda

    ultimoHashIndicador = hash;
    renderIndicadorEconomia(indicador, relatorio);
    return true;
  }

  /**
   * Re-runs the analysis whenever the list it describes changes -- a new
   * search, a card or a store leaving, a quantity edited -- so neither the
   * caption under the button nor an open modal can go on showing numbers for
   * a list that no longer exists. Nothing here is a manual action: there's no
   * "recalculate" button precisely because this covers it.
   *
   * Two independent triggers, because neither alone catches everything:
   * observarMudancasNaLista sees rows and quantities changing (see its own
   * doc comment), while the "Calculando frete..." indicator this also watches
   * is what marks the END of the site's own shipping recalculation -- until
   * that lands, the numbers are still in flux and atualizarIndicadorEconomia
   * deliberately bails out. Both funnel into the same debounced refresh, and
   * the result-hash check inside makes a redundant pass a no-op.
   */
  function initAnaliseReativa(indicador) {
    const atualizar = async () => {
      const mudou = await atualizarIndicadorEconomia(indicador);
      if (!mudou) return;
      // Só reabre a modal se ela já estiver na tela -- uma mudança na lista
      // nunca deve fazer a modal aparecer sozinha.
      if (!document.getElementById("lgm-analise-overlay")) return;
      const button = document.getElementById("lgm-analise-economia-btn");
      if (button) await handleAnaliseClick(button, false, indicador);
    };

    const agendar = observarMudancasNaLista(atualizar);

    const calculando = document.getElementById("main_calculando_fretes");
    if (calculando) {
      new MutationObserver(agendar).observe(calculando, { attributes: true, attributeFilter: ["class"] });
    } else {
      logNotShown("Análise de Economia (observer de frete)", "#main_calculando_fretes não encontrado");
    }

    atualizar();
  }

  function injectAnaliseButton() {
    if (document.getElementById("lgm-analise-economia-btn")) return true;
    const finalizarBtn = document.getElementById("btn-finalizar");
    if (!finalizarBtn) return false;

    const indicador = buildIndicadorEconomia();
    const button = buildAnaliseButton();
    // .after(), not appendChild -- lands right after "Finalizar Compra"
    // (above "Copiar Lista de Compras", which injects itself via
    // appendChild and so always ends up last) regardless of which of the
    // two content scripts happens to run first.
    finalizarBtn.after(indicador, button);
    button.addEventListener("click", () => handleAnaliseClick(button, false, indicador));
    initAnaliseReativa(indicador);

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

  function buildHeader() {
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

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "✕";
    closeBtn.style.cssText = "border: none; background: none; font-size: 16px; cursor: pointer; line-height: 1;";
    closeBtn.addEventListener("click", () => document.getElementById("lgm-analise-overlay")?.remove());
    controls.appendChild(closeBtn);

    titleRow.appendChild(controls);
    header.appendChild(titleRow);

    return header;
  }

  /**
   * One collapsible accordion row -- shared by both the "remoção" and
   * "reorganização" sections. `onAplicar`, when given, adds an "Aplicar
   * Economia" button to the expanded body that runs it (async) and shows a
   * busy state while it does; omit it to leave a row read-only.
   */
  function buildRow(item, tooltipEconomia, onAplicar) {
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
    economiaLabel.title = tooltipEconomia;
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

    if (onAplicar) {
      const aplicarBtn = document.createElement("button");
      aplicarBtn.type = "button";
      aplicarBtn.textContent = "Aplicar Economia";
      aplicarBtn.style.cssText =
        "margin-top: 10px; padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer; " +
        "font-weight: 700; font-family: inherit; font-size: 12px;";
      applySamvStyle(aplicarBtn);
      aplicarBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        aplicarBtn.disabled = true;
        aplicarBtn.textContent = "Aplicando...";
        try {
          await onAplicar();
          // On success the whole modal gets replaced by a freshly recomputed
          // one (see aplicarPlanoEconomia) -- this row won't survive that,
          // so there's nothing left to reset here.
        } catch (err) {
          analiseLog("Falha ao aplicar economia —", err.message);
          aplicarBtn.disabled = false;
          aplicarBtn.textContent = "Aplicar Economia";
        }
      });
      body.appendChild(aplicarBtn);
    }

    row.appendChild(body);

    head.addEventListener("click", () => {
      const aberto = body.style.display !== "none";
      body.style.display = aberto ? "none" : "block";
      caret.style.transform = aberto ? "rotate(0deg)" : "rotate(90deg)";
    });

    return row;
  }

  /**
   * The line explaining what the open tab's suggestions actually mean --
   * what used to be each section title's own subtitle back when all three
   * lists were stacked in one scrolling body. Tinted from SAMV_PURPLE (not a
   * separate hardcoded gray) so it reads clearly against the white panel --
   * ~4.9:1 contrast at 14% opacity, above the 4.5:1 WCAG AA floor -- and
   * ties visually to every other purple control this extension adds.
   */
  function buildAbaSubtitulo(texto) {
    const sub = document.createElement("div");
    sub.style.cssText =
      `padding: 10px 20px; background: rgba(109, 79, 196, 0.14); ` +
      `border-bottom: 1px solid rgba(109, 79, 196, 0.35); ` +
      `font-size: 11px; color: ${SAMV_PURPLE}; line-height: 1.4;`;
    sub.textContent = texto;
    return sub;
  }

  function buildEmptyMessage(text) {
    const vazio = document.createElement("div");
    vazio.style.cssText = "padding: 12px 20px 16px; color: #666; font-size: 12px;";
    vazio.textContent = text;
    return vazio;
  }

  /** A plain, non-collapsible row for one expensive-shipping store. */
  function buildAlertaFreteCaroRow(item) {
    const row = document.createElement("div");
    row.style.cssText =
      "display: flex; align-items: center; justify-content: space-between; gap: 12px; " +
      "padding: 8px 20px; border-bottom: 1px solid #f2f2f2; font-size: 13px;";

    const nome = document.createElement("span");
    nome.textContent = item.nome;
    nome.style.cssText = "overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    row.appendChild(nome);

    const valor = document.createElement("span");
    valor.style.cssText =
      `font-weight: 700; white-space: nowrap; flex-shrink: 0; padding: 1px 8px; border-radius: 4px; ` +
      `background: ${SAMV_FRETE_CARO_BG}; color: ${SAMV_FRETE_CARO_TEXT};`;
    valor.textContent = `R$ ${formatarMoeda(item.frete)}`;
    row.appendChild(valor);

    return row;
  }

  /**
   * The three kinds of suggestion, one per tab. Each `render` fills a fresh
   * panel on demand (only the open tab's rows exist in the DOM at a time),
   * and `contagem` drives both the count shown on the tab itself and which
   * tab opens first -- landing on an empty list when another one has
   * something to show would hide the very thing the modal was opened for.
   */
  let abaSelecionada = null;

  function definirAbas(relatorio) {
    const limiar = relatorio.freteCaroLimiar ?? FRETE_CARO_LIMIAR_PADRAO;

    return [
      {
        titulo: "Reorganização entre lojas",
        contagem: relatorio.reorganizacoes.length,
        subtitulo:
          "Nenhuma carta deixa de ser comprada — só muda a loja de origem, liberando o frete de uma loja inteira.",
        vazio:
          "Nenhuma loja pode ser totalmente esvaziada para as outras já presentes neste resultado sem " +
          "deixar de comprar nenhuma carta.",
        render: (painel) => {
          const tooltip =
            "Nenhuma carta é removida da compra -- ela só passa a ser comprada em outra loja já presente " +
            "neste resultado, liberando o frete desta.";
          relatorio.reorganizacoes.forEach((item) => {
            const onAplicar = item.plano ? () => aplicarPlanoEconomia(item.plano) : undefined;
            painel.appendChild(buildRow(item, tooltip, onAplicar));
          });
        },
      },
      {
        titulo: "Remoção de cartas",
        contagem: relatorio.resultados.length,
        subtitulo:
          'Deixar de comprar uma carta cara — "economiza" aqui não inclui o preço da própria carta, só o ' +
          "que sobra de fechar loja(s) e/ou realocar as outras cartas.",
        vazio:
          "Nenhuma economia por redistribuição encontrada: todas as lojas deste resultado continuam " +
          "necessárias mesmo sem as cartas mais caras da lista.",
        render: (painel) => {
          const tooltip =
            "Economia por redistribuição: não inclui o preço da própria carta, só o que sobra de fechar " +
            "loja(s) e/ou realocar as outras cartas para ofertas mais baratas.";
          relatorio.resultados.forEach((item) => {
            const onAplicar = item.plano ? () => aplicarPlanoEconomia(item.plano) : undefined;
            painel.appendChild(buildRow(item, tooltip, onAplicar));
          });
        },
      },
      {
        titulo: "Fretes acima da média",
        contagem: relatorio.alertasFreteCaro.length,
        subtitulo:
          `Lojas cujo frete sozinho já passa de R$ ${formatarMoeda(limiar)} (valor configurado no painel da ` +
          "extensão), mesmo sem nenhuma sugestão de economia envolvendo elas.",
        vazio: "Nenhuma loja com frete acima do valor configurado no painel da extensão.",
        render: (painel) => {
          relatorio.alertasFreteCaro.forEach((item) => painel.appendChild(buildAlertaFreteCaroRow(item)));
        },
      },
    ];
  }

  function estiloAba(ativa) {
    return (
      "flex: 1; padding: 8px 10px; font-size: 12px; font-family: inherit; cursor: pointer; line-height: 1.25; " +
      "border: 1px solid #ddd; border-bottom: none; border-radius: 6px 6px 0 0; margin-bottom: -1px; " +
      (ativa
        ? `background: #fff; color: ${SAMV_PURPLE}; font-weight: 700;`
        : "background: #f2f2f4; color: #666; font-weight: 600;")
    );
  }

  /**
   * The tab strip plus the panel below it. The active tab's own white
   * background sits on top of the strip's bottom border (margin-bottom:-1px)
   * so it reads as connected to the panel instead of floating above it.
   */
  function buildAbas(relatorio) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display: flex; flex-direction: column; flex: 1; min-height: 0;";

    const barra = document.createElement("div");
    barra.style.cssText =
      "display: flex; align-items: stretch; gap: 4px; padding: 10px 20px 0; border-bottom: 1px solid #ddd; flex-shrink: 0;";

    const painel = document.createElement("div");
    painel.style.cssText = "overflow-y: auto; flex: 1;";

    const abas = definirAbas(relatorio);
    const botoes = abas.map((aba) => {
      const botao = document.createElement("button");
      botao.type = "button";
      botao.textContent = aba.contagem > 0 ? `${aba.titulo} (${aba.contagem})` : aba.titulo;
      return botao;
    });

    const abrir = (indice) => {
      abaSelecionada = abas[indice].titulo;
      botoes.forEach((botao, i) => {
        botao.style.cssText = estiloAba(i === indice);
      });
      painel.textContent = "";
      painel.scrollTop = 0;
      const aba = abas[indice];
      painel.appendChild(buildAbaSubtitulo(aba.subtitulo));
      if (aba.contagem === 0) painel.appendChild(buildEmptyMessage(aba.vazio));
      else aba.render(painel);
    };

    botoes.forEach((botao, i) => {
      botao.addEventListener("click", () => abrir(i));
      barra.appendChild(botao);
    });

    // A modal é reconstruída sozinha toda vez que a lista muda, então a aba
    // que o usuário abriu precisa sobreviver a isso -- cair de volta na aba
    // padrão a cada alteração de quantidade jogaria fora a escolha dele.
    const lembrada = abas.findIndex((aba) => aba.titulo === abaSelecionada);
    const primeiraComConteudo = abas.findIndex((aba) => aba.contagem > 0);
    if (lembrada !== -1) abrir(lembrada);
    else abrir(primeiraComConteudo === -1 ? 0 : primeiraComConteudo);

    wrap.appendChild(barra);
    wrap.appendChild(painel);
    return wrap;
  }

  /**
   * The two action buttons, sitting right under the header (and under the
   * Super Pesquisa status, whenever there's a run to report): "Economizar
   * nessa compra", which applies every viable reorganização at once, and
   * "Super Pesquisa", which starts the wider-search flow (see
   * iniciarSuperPesquisa in super-pesquisa.js, a top-level function in that
   * file safe to call directly from here).
   *
   * The first one is always rendered, disabled with an explanatory caption
   * under it once nothing's left to apply -- so "no savings left" is
   * something the modal says out loud, not a button that quietly isn't
   * there.
   */
  function buildBotoesCentrais(relatorio) {
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "padding: 14px 20px; display: flex; justify-content: center; align-items: flex-start; gap: 28px; " +
      "flex-wrap: wrap; flex-shrink: 0;";

    const aplicarCol = document.createElement("div");
    aplicarCol.style.cssText = "display: flex; flex-direction: column; align-items: center; gap: 4px;";

    const economiaDisponivel = calcularEconomiaTotalDisponivel(relatorio);
    const temEconomia = economiaDisponivel > ANALISE_ECONOMIA_MINIMA;

    const aplicarTodasBtn = document.createElement("button");
    aplicarTodasBtn.type = "button";
    aplicarTodasBtn.textContent = "Economizar nessa compra";
    aplicarTodasBtn.disabled = !temEconomia;
    aplicarTodasBtn.style.cssText =
      "padding: 6px 14px; border: none; border-radius: 4px; font-weight: 700; font-family: inherit; font-size: 12px; " +
      (temEconomia ? "cursor: pointer;" : "cursor: not-allowed; opacity: 0.5;");
    applySamvStyle(aplicarTodasBtn);
    aplicarTodasBtn.addEventListener("click", async () => {
      aplicarTodasBtn.disabled = true;
      aplicarTodasBtn.textContent = "Aplicando...";
      try {
        await aplicarTodasReorganizacoes();
        const button = document.getElementById("lgm-analise-economia-btn");
        if (button) await handleAnaliseClick(button, true);
      } catch (err) {
        analiseLog("Falha ao aplicar todas as economias —", err.message);
        aplicarTodasBtn.disabled = false;
        aplicarTodasBtn.textContent = "Economizar nessa compra";
      }
    });
    aplicarCol.appendChild(aplicarTodasBtn);

    // Abaixo do botão, não acima: é o resultado de apertá-lo, não um rótulo.
    const aplicarCaption = document.createElement("div");
    aplicarCaption.style.cssText = temEconomia
      ? "font-size: 13px; font-weight: 700; color: #1a7f37; text-align: center;"
      : "font-size: 11px; color: #444; text-align: center;";
    aplicarCaption.textContent = temEconomia
      ? `-R$ ${formatarMoeda(economiaDisponivel)}`
      : "Economia máxima já alcançada nessa lista";
    aplicarCol.appendChild(aplicarCaption);
    wrap.appendChild(aplicarCol);

    const buscarBtn = document.createElement("button");
    buscarBtn.type = "button";
    buscarBtn.textContent = "Super Pesquisa";
    buscarBtn.style.cssText =
      "padding: 6px 14px; border: 1px solid #ccc; border-radius: 4px; background: #fff; cursor: pointer; " +
      "font-weight: 700; font-family: inherit; font-size: 12px;";
    buscarBtn.addEventListener("click", async () => {
      buscarBtn.disabled = true;
      try {
        await iniciarSuperPesquisa();
      } finally {
        buscarBtn.disabled = false;
      }
    });
    wrap.appendChild(buscarBtn);

    return wrap;
  }

  /**
   * Rendered by super-pesquisa.js's own top-level renderSuperPesquisaStatusSection
   * (that file keeps the actual Super Pesquisa run state -- see its own doc
   * comment on why this file's block-scoped code can call a top-level
   * function in another content script, but not the other way around).
   * Hidden entirely (display:none, set by that function itself) whenever
   * there's no run in progress or to report.
   */
  function buildSuperPesquisaStatusSection() {
    const section = document.createElement("div");
    section.id = "lgm-analise-super-pesquisa-status";
    section.style.cssText = "padding: 14px 20px; border-bottom: 1px solid #eee; display: none;";
    renderSuperPesquisaStatusSection(section);
    return section;
  }

  /**
   * Order matters: the Super Pesquisa status sits between the header and the
   * buttons, so a run's progress (or its result, waiting on a Sim/Não) is
   * the first thing read after the title -- and right above the very button
   * that started it.
   */
  function showModal(relatorio) {
    document.getElementById("lgm-analise-overlay")?.remove();
    const { overlay, modal } = buildModalShell();
    modal.appendChild(buildHeader());
    modal.appendChild(buildSuperPesquisaStatusSection());
    modal.appendChild(buildBotoesCentrais(relatorio));
    modal.appendChild(buildAbas(relatorio));
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

  async function runAndCache(resultado, hash, freteCaroLimiar) {
    const relatorio = await analisarEconomiaAsync(resultado, freteCaroLimiar);
    // Only cache a real result -- an incomplete one (missing frete) would
    // otherwise sit in the cache slot under a hash that's likely to be
    // superseded the moment shipping actually finishes calculating anyway.
    if (relatorio.baseline != null) {
      sendMessage({ action: "saveSettings", settings: { analiseEconomiaCache: { hash, relatorio } } });
    }
    return relatorio;
  }

  async function handleAnaliseClick(button, forcarRecalculo = false, indicador = null) {
    indicador ??= document.getElementById("lgm-analise-economia-indicador");
    const { abortado, resultado } = await aguardarFreteEObterResultado(button);
    if (abortado) return;
    if (!resultado || Object.keys(resultado).length === 0) {
      analiseLog("Nenhum resultado de busca encontrado.");
      return;
    }

    const hash = hashResultado(resultado);
    const settings = await getSettings();
    const freteCaroLimiar = Number(settings?.freteCaroLimiar) || FRETE_CARO_LIMIAR_PADRAO;

    if (!forcarRecalculo) {
      const cache = settings?.analiseEconomiaCache;
      if (cache && cache.hash === hash) {
        renderIndicadorEconomia(indicador, cache.relatorio);
        ultimoHashIndicador = hash;
        showModal(cache.relatorio);
        return;
      }
    }

    const originalLabel = button.textContent;
    button.textContent = "Calculando...";
    button.style.pointerEvents = "none";
    try {
      const relatorio = await runAndCache(resultado, hash, freteCaroLimiar);
      if (relatorio.lojasSemFrete?.length > 0) {
        mostrarAviso(
          "Frete pendente",
          `Selecione uma forma de envio para: ${relatorio.lojasSemFrete.join(", ")}. ` +
            "A análise precisa do frete de cada loja pra ser precisa.",
        );
        return;
      }
      renderIndicadorEconomia(indicador, relatorio);
      ultimoHashIndicador = hash;
      showModal(relatorio);
    } catch (err) {
      analiseLog("Falha ao calcular a análise —", err.message);
    } finally {
      button.textContent = originalLabel;
      button.style.pointerEvents = "";
    }
  }

  /**
   * Actually carries out a { incrementar, fecharLojas } plano (see
   * construirPlanoAplicacao) on the live results screen. Every row a card is
   * moved into already exists in the DOM -- LigaMagic renders a hidden,
   * fully interactive row for every card/store pairing it knows about, even
   * ones currently at 0 units (the "outras cartas disponíveis" list) -- so
   * this never creates anything, only drives the same controls a user
   * would: the same `.qty` input + blur the page's own onblur handler
   * listens for, to move a card, then each closing store's own "remover
   * todos os itens desta loja" icon (`CardsOrcamento.item.removeTodosItens`)
   * to actually drop it and its shipping.
   *
   * Moves first, closures after: closing a store removes its block outright
   * (unlike moving a card away from it one at a time), so there's nothing
   * left there afterward to read a "current quantity" from -- not that this
   * plano would ever ask to increment INTO a store it's also closing, but
   * ordering it this way keeps that impossible by construction rather than
   * by coincidence.
   */
  function aplicarPlanoNaTela(plano) {
    for (const { bloco, linha, qtd } of plano.incrementar) {
      const input = document.querySelector(`input.qty[data-bloco="${bloco}"][data-linha="${linha}"]`);
      if (!input) {
        logNotShown("Aplicar Economia (mover carta)", `input data-bloco=${bloco} data-linha=${linha} não encontrado`);
        continue;
      }
      const atual = parseInt(input.value, 10) || 0;
      input.value = String(atual + qtd);
      input.dispatchEvent(new FocusEvent("blur"));
    }
    for (const bloco of plano.fecharLojas) {
      const del = document.querySelector(`#bloco_${bloco} img.del[onclick*="removeTodosItens"]`);
      if (del) del.click();
      else logNotShown("Aplicar Economia (fechar loja)", `botão de remover loja #bloco_${bloco} não encontrado`);
    }
  }

  /**
   * Applies one suggestion's plano -- from either "Economia por
   * reorganização" or "Economia de frete por remoção", both produce the same
   * { incrementar, fecharLojas } shape -- then recomputes the whole analysis
   * from scratch: applying one suggestion can change what's left to suggest (a
   * card that just moved into a store may now make that store newly
   * closeable, or no longer closeable elsewhere) -- and reopens the modal
   * with the fresh result.
   */
  async function aplicarPlanoEconomia(plano) {
    aplicarPlanoNaTela(plano);
    // Gives the page's own onblur/onclick handlers (synchronous, but still
    // worth a tick) room to finish updating window.CardsOrcamento.item's
    // own state before it's read back below.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const button = document.getElementById("lgm-analise-economia-btn");
    if (button) await handleAnaliseClick(button, true);
  }

  /**
   * The "Aplicar Economia" footer button's real, DOM-driven counterpart to
   * maximizarReorganizacoes: repeatedly re-fetches the live resultado, finds
   * the best set of stores to close right now, and applies it for real --
   * never trusting a plan computed against an earlier state, since the live
   * page recalculates frete as stores close and quantities move, which can
   * change what's still worth doing. Same reasoning aplicarPlanoEconomia
   * already follows for a single real application; this just runs it in a
   * loop until nothing is left to apply.
   */
  async function aplicarTodasReorganizacoes() {
    while (true) {
      const resultado = await sendMessage({ action: "getListaResultado" });
      const consolidado = consolidarResultado(resultado);
      if (consolidado.lojasSemFrete.length > 0) break;
      const melhor = melhorFechamento(consolidado);
      if (!melhor) break;
      aplicarPlanoNaTela(construirPlanoAplicacaoReorganizacao(melhor));
      // Room for the page's own handlers to settle (and for a store closing
      // or a quantity moving to potentially retrigger frete recalculation)
      // before the next iteration reads the live resultado again.
      await new Promise((resolve) => setTimeout(resolve, 300));
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
