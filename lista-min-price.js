/**
 * Adds a "Preço Mínimo" column to the "Compra por Lista" results screen
 * (?view=cards/lista, after a search), between the native "Comprar" and
 * "R$ Unit." columns of every store's own card table. Shows, one above the
 * other: the cheapest price this extension has ever locally cached for that
 * exact card (see handleSendPrices/handleQueryPrices in background.js — the
 * same cache Archidekt/Moxfield/Scryfall's own BRL-price overlays read from,
 * populated just by browsing a card anywhere those overlays run, plus
 * whatever this file itself backfills via "Carregar valores mínimos"), and
 * this specific offer's own price with how far above that minimum it is.
 *
 * This is purely a LOCAL comparison against whatever this browser has
 * already scraped -- there is no live "cheapest price across all of
 * LigaMagic" endpoint to call. A card this extension has never seen priced
 * anywhere shows a dash instead of a guess; "Carregar valores mínimos"
 * (mounted between "Análise de Economia" and "Copiar Lista de Compras",
 * shown only while something's missing) backfills those via the exact same
 * batched, rate-limit-safe managed-deck mechanism "Carregar preços
 * pendentes" already uses elsewhere in this extension (handleLoadPendingPrices)
 * -- never one request per card.
 *
 * Column layout: the native row is a 12-unit flex grid (Card=5, Estoque=2,
 * Comprar=1, R$ Unit.=2, R$ Total=2). This column borrows the 1 unit
 * "Estoque" gives up (col-lg-2/col-md-2[/col-sm-2 on data rows] -> col-lg-1/
 * col-md-1[/col-sm-1]) -- picked because its own content ("N unid.") is the
 * shortest and least likely to need the room. Hidden entirely at the "xs"
 * (phone) breakpoint via `hidden-xs`, matching the header row's own existing
 * hidden-xs convention, so no phone-specific stacking math has to be solved.
 *
 * The tooltip explaining these values is a small custom hover box, not a
 * native `title` attribute -- a native tooltip can't be recolored into
 * SAMV_PURPLE, which this feature was explicitly asked to use.
 *
 * Depends on: content-utils.js (log, logNotShown, sendMessage, getSettings,
 * applySamvStyle, SAMV_PURPLE), lista-defaults.js (isListaCardsPage),
 * analise-economia.js (formatarMoeda -- a genuinely top-level declaration in
 * that file, safe to call directly; see super-pesquisa.js's own doc comment
 * for why that's true only for top-level, non-block-scoped declarations).
 */

const listaMinPriceLog = (...args) => log("[Preço Mínimo]", ...args);

const MIN_PRICE_MINIMA = 0.01; // floor to swallow floating-point noise, not a real threshold
const MIN_PRICE_CELL_CLASS = "lgm-min-price-cell";
const MIN_PRICE_BTN_WRAP_ID = "lgm-min-price-btn-wrap";

const MIN_PRICE_TOOLTIP_TEXT = "Valor mínimo\nDiferença mínimo → atual\nDiferença %";

const MIN_PRICE_SUMMARY_TOOLTIP_TEXT =
  "Soma do menor preço já registrado (ver coluna Preço Mínimo) de cada carta desta compra, multiplicado " +
  "pela quantidade comprada de cada uma, e quanto o total atual está acima dessa soma. Fica em branco " +
  "(traço) enquanto qualquer carta da compra ainda não tiver um preço mínimo salvo.";

// ── Custom tooltip (a native `title` can't be recolored) ─────────────────────
const MIN_PRICE_TOOLTIP_ID = "lgm-min-price-tooltip";
const MIN_PRICE_TOOLTIP_DELAY_MS = 450; // roughly matches how long a native browser tooltip waits before showing

let minPriceTooltipShowTimer = null;

function getOrCreateMinPriceTooltip() {
  let tip = document.getElementById(MIN_PRICE_TOOLTIP_ID);
  if (tip) return tip;
  tip = document.createElement("div");
  tip.id = MIN_PRICE_TOOLTIP_ID;
  tip.style.cssText =
    "position: fixed; z-index: 10000; display: none; max-width: 260px; padding: 8px 10px; " +
    `background: #fff; color: ${SAMV_PURPLE}; border: 1px solid ${SAMV_PURPLE}; border-radius: 6px; ` +
    "box-shadow: 0 4px 14px rgba(0,0,0,0.2); font-size: 12px; line-height: 1.4; font-weight: 600; " +
    "font-family: inherit; pointer-events: none; white-space: pre-line;";
  document.body.appendChild(tip);
  return tip;
}

function hideMinPriceTooltip() {
  clearTimeout(minPriceTooltipShowTimer);
  const tip = document.getElementById(MIN_PRICE_TOOLTIP_ID);
  if (tip) tip.style.display = "none";
}

function positionMinPriceTooltip(tip, anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  tip.style.display = "block";
  const top = rect.bottom + 6;
  let left = rect.left + rect.width / 2 - tip.offsetWidth / 2;
  left = Math.max(6, Math.min(left, window.innerWidth - tip.offsetWidth - 6));
  tip.style.top = `${top}px`;
  tip.style.left = `${left}px`;
}

/** Hover-and-hold, like a native title tooltip -- shows after a short delay, not instantly, and disappears the moment the pointer leaves. */
function attachMinPriceTooltip(el, text) {
  el.addEventListener("mouseenter", () => {
    clearTimeout(minPriceTooltipShowTimer);
    minPriceTooltipShowTimer = setTimeout(() => {
      const tip = getOrCreateMinPriceTooltip();
      tip.textContent = text;
      positionMinPriceTooltip(tip, el);
    }, MIN_PRICE_TOOLTIP_DELAY_MS);
  });
  el.addEventListener("mouseleave", hideMinPriceTooltip);
}

// ── Reading the current result ────────────────────────────────────────────────
/**
 * Flattens `resultado` into one entry per real DOM row -- both the
 * "comprada" rows and the collapsed "outras lojas" alternatives use the same
 * (bloco, linha) addressing as `#item_<bloco>_<linha>`, so this covers every
 * visible price row on the page regardless of which section it's in.
 * `nomeInglesSA` is the English name LigaMagic itself has on file for the
 * card -- the same name space the price cache is keyed by (see
 * priceCacheKey in background.js), so no separate name translation is
 * needed here.
 */
async function getMinPriceRowData() {
  const resultado = await sendMessage({ action: "getListaResultado" });
  const rows = [];
  for (const bloco of Object.values(resultado ?? {})) {
    if (!bloco) continue;
    for (const carta of bloco.cartas ?? []) {
      // Removing a card (CardsOrcamento.item.removeItem) leaves a `null` hole
      // at that index instead of splicing the array -- every read of
      // bloco.cartas elsewhere in this extension already skips it the same way.
      if (!carta) continue;
      const nome = (carta.nomeInglesSA || "").trim();
      if (!nome || carta.preco == null) continue;
      rows.push({
        bloco: bloco.posicaoBloco,
        linha: carta.line,
        nome,
        precoUnit: carta.preco,
        qtd: carta.quantidade,
      });
    }
  }
  return rows;
}

// ── Header cell (one per store block) ─────────────────────────────────────────
function buildMinPriceHeaderCell() {
  const cell = document.createElement("div");
  cell.className = "col-lg-1 col-md-1 hidden-xs";
  cell.dataset.lgmMinPriceHeader = "1";
  cell.style.cssText = `font-size: 11px; line-height: 1.2; text-align: center; cursor: help; color: ${SAMV_PURPLE}; font-weight: 700;`;
  cell.textContent = "Preço Mínimo";
  attachMinPriceTooltip(cell, MIN_PRICE_TOOLTIP_TEXT);
  return cell;
}

function ensureMinPriceHeader(headerRow) {
  if (headerRow.querySelector("[data-lgm-min-price-header]")) return;
  const estoqueCell = headerRow.children[1];
  const comprarCell = headerRow.children[2];
  if (!estoqueCell || !comprarCell) {
    logNotShown("Coluna Preço Mínimo (cabeçalho)", "estrutura de colunas do cabeçalho da loja não reconhecida");
    return;
  }
  estoqueCell.classList.remove("col-lg-2", "col-md-2");
  estoqueCell.classList.add("col-lg-1", "col-md-1");
  comprarCell.after(buildMinPriceHeaderCell());
}

// ── Data cell (one per card row) ──────────────────────────────────────────────
function buildMinPriceCellContent(cell, minPrice, precoUnit) {
  cell.textContent = "";

  if (minPrice == null) {
    const dash = document.createElement("div");
    dash.textContent = "—";
    dash.style.color = "#999";
    cell.appendChild(dash);
    attachMinPriceTooltip(cell, MIN_PRICE_TOOLTIP_TEXT);
    return;
  }

  const minLine = document.createElement("div");
  minLine.textContent = `R$ ${formatarMoeda(minPrice)}`;
  minLine.style.cssText = "color: #1a7f37; font-weight: 700;";
  cell.appendChild(minLine);

  const diff = precoUnit - minPrice;
  const diffLine = document.createElement("div");
  if (diff > MIN_PRICE_MINIMA) {
    // minPrice pode ser 0 (terrenos básicos têm um mínimo sintético de R$0,00,
    // ver basicLandPriceEntry em background.js) -- percentual não é definido
    // nesse caso, então a linha mostra só a diferença em R$.
    diffLine.textContent =
      minPrice > MIN_PRICE_MINIMA
        ? `R$ ${formatarMoeda(diff)} (+${Math.round((diff / minPrice) * 100)}%)`
        : `R$ ${formatarMoeda(diff)}`;
    diffLine.style.color = "#c0392b";
  } else {
    diffLine.textContent = "Menor preço";
    diffLine.style.cssText = "color: #1a7f37; font-style: italic;";
  }
  cell.appendChild(diffLine);
  attachMinPriceTooltip(cell, MIN_PRICE_TOOLTIP_TEXT);
}

function ensureMinPriceCell(row) {
  let cell = row.querySelector(`.${MIN_PRICE_CELL_CLASS}`);
  if (cell) return cell;

  const qtyCell = row.children[2];
  const estoqueCell = row.children[1];
  if (!qtyCell || !estoqueCell) {
    logNotShown("Coluna Preço Mínimo (linha)", "estrutura de colunas da linha não reconhecida");
    return null;
  }

  estoqueCell.classList.remove("col-lg-2", "col-md-2", "col-sm-2");
  estoqueCell.classList.add("col-lg-1", "col-md-1", "col-sm-1");

  cell = document.createElement("div");
  cell.className = `col-lg-1 col-md-1 col-sm-1 hidden-xs ${MIN_PRICE_CELL_CLASS}`;
  cell.style.cssText =
    "display: flex; flex-direction: column; justify-content: center; align-items: center; " +
    "font-size: 10px; line-height: 1.3; text-align: center; gap: 1px;";
  qtyCell.after(cell);
  return cell;
}

// ── "Carregar valores mínimos" button ─────────────────────────────────────────
function buildMinPriceButton() {
  const wrap = document.createElement("div");
  wrap.id = MIN_PRICE_BTN_WRAP_ID;
  wrap.style.cssText = "margin-top: 10px;";

  const btn = document.createElement("div");
  btn.id = "lgm-min-price-load-btn";
  btn.className = "botao";
  btn.style.cssText = "cursor: pointer; display: block; width: 100%; box-sizing: border-box; text-align: center;";
  applySamvStyle(btn);

  wrap.appendChild(btn);
  return wrap;
}

function handleLoadMinPricesClick(btn, missingNames) {
  btn.dataset.loading = "1";
  btn.style.pointerEvents = "none";
  btn.textContent = `Carregando... (0/${missingNames.length})`;
  listaMinPriceLog(`"Carregar valores mínimos" clicado -- ${missingNames.length} carta(s): ${missingNames.join(", ")}`);

  const listener = (m) => {
    if (m.action !== "pendingPricesProgress") return;
    btn.textContent = `Carregando... (${m.done}/${m.total})`;
    if (m.done < m.total) return;
    chrome.runtime.onMessage.removeListener(listener);
    delete btn.dataset.loading;
    btn.style.pointerEvents = "";
    const foundCount = m.total - (m.failedNames?.length ?? 0);
    listaMinPriceLog(`Carregamento concluído: ${foundCount}/${m.total} carta(s) com preço encontrado.`);
    refreshMinPriceColumn();
  };
  chrome.runtime.onMessage.addListener(listener);
  sendMessage({ action: "loadPendingPrices", cards: missingNames });
}

/** Mounted between "Análise de Economia" and "Copiar Lista de Compras" regardless of which of those two has already rendered -- see analise-economia.js/lista-copy-button.js's own anchoring comments for why order can't be assumed. Removed entirely once nothing is missing. */
function ensureMinPriceButton(missingNames) {
  let wrap = document.getElementById(MIN_PRICE_BTN_WRAP_ID);

  if (missingNames.length === 0) {
    wrap?.remove();
    return;
  }

  if (!wrap) {
    const analiseBtn = document.getElementById("lgm-analise-economia-btn");
    if (!analiseBtn) return;
    wrap = buildMinPriceButton();
    const copyWrap = document.getElementById("lgm-copy-lista-wrap");
    if (copyWrap) copyWrap.before(wrap);
    else analiseBtn.after(wrap);
  }

  const btn = wrap.querySelector("#lgm-min-price-load-btn");
  if (btn.dataset.loading === "1") return; // a backfill is already running -- don't clobber its progress text
  btn.textContent = `Carregar valores mínimos (${missingNames.length})`;
  btn.onclick = () => handleLoadMinPricesClick(btn, missingNames);
}

// ── Summary rows ("Sumário Geral", right below "X Itens") ────────────────────
function ensureMinPriceSummaryRows() {
  if (document.getElementById("lgm-min-price-summary-total-value")) return;
  const itensLabel = document.getElementById("main_itens");
  const itensValue = document.getElementById("main_preco");
  if (!itensLabel || !itensValue) {
    logNotShown("Sumário de Preço Mínimo", "#main_itens/#main_preco não encontrados");
    return;
  }

  const totalLabel = document.createElement("p");
  totalLabel.id = "lgm-min-price-summary-total-label";
  totalLabel.style.cssText = `color: ${SAMV_PURPLE}; font-weight: 600; cursor: help;`;
  totalLabel.textContent = "Preço Mínimo Total:";
  itensLabel.after(totalLabel);

  const diffLabel = document.createElement("p");
  diffLabel.id = "lgm-min-price-summary-diff-label";
  diffLabel.style.cssText = `color: ${SAMV_PURPLE}; font-weight: 600; cursor: help;`;
  diffLabel.textContent = "Diferença:";
  totalLabel.after(diffLabel);

  const totalValue = document.createElement("p");
  totalValue.id = "lgm-min-price-summary-total-value";
  totalValue.style.cssText = `color: ${SAMV_PURPLE}; font-weight: 600;`;
  totalValue.textContent = "—";
  itensValue.after(totalValue);

  const diffValue = document.createElement("p");
  diffValue.id = "lgm-min-price-summary-diff-value";
  diffValue.style.cssText = `color: ${SAMV_PURPLE}; font-weight: 600;`;
  diffValue.textContent = "—";
  totalValue.after(diffValue);

  [totalLabel, diffLabel, totalValue, diffValue].forEach((el) => attachMinPriceTooltip(el, MIN_PRICE_SUMMARY_TOOLTIP_TEXT));
}

/** Only counts rows actually being bought (qtd > 0) -- an "outras lojas" alternative has no quantity to weight a total by. Shows a dash on BOTH totals, rather than a partial sum, the moment any purchased card is still missing a cached minimum -- a partial total silently excluding some cards would look like a real total while understating it. */
function renderMinPriceSummary(rows, priceMap) {
  ensureMinPriceSummaryRows();
  const totalValueEl = document.getElementById("lgm-min-price-summary-total-value");
  const diffValueEl = document.getElementById("lgm-min-price-summary-diff-value");
  if (!totalValueEl || !diffValueEl) return;

  let totalAtual = 0;
  let totalMin = 0;
  let anyMissing = false;
  for (const r of rows) {
    if (r.qtd <= 0) continue;
    const min = priceMap[r.nome]?.priceMin;
    if (min == null) {
      anyMissing = true;
      continue;
    }
    totalAtual += r.precoUnit * r.qtd;
    totalMin += min * r.qtd;
  }

  if (anyMissing || totalMin === 0) {
    totalValueEl.textContent = "—";
    diffValueEl.textContent = "—";
    return;
  }

  totalValueEl.textContent = `R$ ${formatarMoeda(totalMin)}`;
  const diff = totalAtual - totalMin;
  diffValueEl.textContent =
    diff > MIN_PRICE_MINIMA ? `R$ ${formatarMoeda(diff)} (+${Math.round((diff / totalMin) * 100)}%)` : "R$ 0,00";
}

// ── Driver ─────────────────────────────────────────────────────────────────────
let minPriceRefreshInFlight = false;

async function refreshMinPriceColumn() {
  if (minPriceRefreshInFlight) return;
  minPriceRefreshInFlight = true;
  try {
    const rows = await getMinPriceRowData();
    if (rows.length === 0) return;

    const distinctNames = [...new Set(rows.map((r) => r.nome))];
    const { prices } = await sendMessage({ action: "queryPrices", cards: distinctNames });

    document.querySelectorAll(".row.header").forEach(ensureMinPriceHeader);

    for (const r of rows) {
      const row = document.getElementById(`item_${r.bloco}_${r.linha}`);
      if (!row) continue;
      const cell = ensureMinPriceCell(row);
      if (!cell) continue;
      buildMinPriceCellContent(cell, prices[r.nome]?.priceMin ?? null, r.precoUnit);
    }

    const missingNames = distinctNames.filter((n) => prices[n]?.priceMin == null);
    ensureMinPriceButton(missingNames);
    renderMinPriceSummary(rows, prices);

    listaMinPriceLog(
      `Coluna atualizada: ${rows.length} linha(s), ${distinctNames.length} carta(s) distinta(s), ` +
        `${missingNames.length} sem preço mínimo salvo.`,
    );
  } catch (err) {
    listaMinPriceLog("Falha ao atualizar a coluna —", err.message);
  } finally {
    minPriceRefreshInFlight = false;
  }
}

const MIN_PRICE_DEBOUNCE_MS = 600;

function initListaMinPrice() {
  if (!isListaCardsPage()) return;

  getSettings().then((settings) => {
    if (settings?.addMinPriceColumn === false) return;

    refreshMinPriceColumn();
    observarMudancasNaLista(refreshMinPriceColumn, MIN_PRICE_DEBOUNCE_MS);
  });
}

initListaMinPrice();
