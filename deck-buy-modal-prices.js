/**
 * Adds each card's price and price-band grouping to the "Comprar Deck" modal
 * on a LigaMagic deck page (`#popupBuyDeck`, filled asynchronously via
 * viewdeck.buy() with a POST to /ajax/decks/decks.php), gated by the
 * "addBuyModalPriceGrouping" setting.
 *
 * The modal groups its cards into one or more `.buy-cards` boxes under
 * `#buy-data` — confirmed live: a deck with only a Mainboard renders a single
 * box, a deck with a Sideboard renders a second one right after it, each with
 * its own `.cards-head` "select all" checkbox (`buydeck.selAll(this, N)`) and
 * its own `card-group-N` class on every checkbox inside it. Since that native
 * grouping already marks Mainboard/Sideboard as functionally distinct
 * selection groups, this sorts and bands each `.buy-cards` box on its own —
 * never merging cards from different groups into the same price ordering.
 *
 * Price comes entirely from the same page's own Padrão view
 * (#dk-val-1-<id>), already read by deck-view.js's getDeckBoards() — the
 * exact same technique deck-grid-prices.js uses for the native Grid view.
 * This never triggers a new price fetch: a card missing from that map (never
 * scraped) just renders with no price, in a trailing "Sem preço" band.
 *
 * DOM-manipulation constraint: each `.cards-item`'s inline `onclick`/`onblur`
 * handlers (buydeck.minus/plus/qty/sel) reference the site's own `buydeck`
 * object by a numeric index baked into the row at render time, not by DOM
 * position. Reordering therefore MOVES the existing row nodes
 * (group.appendChild(existingNode)) — never clones/rebuilds them, or those
 * handlers would break.
 *
 * Depends on: content-utils.js (log, logNotShown, cardNameFromHref,
 * parsePrice, waitForElement, getSettings, SAMV_PURPLE),
 * deck-view.js (getDeckBoards), scraper-deck.js (isDeckPage)
 */

const BUY_PRICE_BADGE_CLASS = "lm-ext-buy-price";
const BUY_BAND_DIVIDER_CLASS = "lm-ext-buy-band";

// Upper bound (exclusive) of each finite price band, in R$. Two more bands
// are handled separately below: an open-ended "1000+" band for anything at
// or above the last bound here, and a trailing "Sem preço" band for cards
// with no price data at all.
const BUY_PRICE_BAND_UPPER_BOUNDS = [5, 10, 15, 20, 30, 50, 100, 150, 200, 300, 400, 500, 800, 1000];
const BUY_PRICE_OPEN_BAND_INDEX = BUY_PRICE_BAND_UPPER_BOUNDS.length;
const BUY_PRICE_NO_PRICE_BAND_INDEX = BUY_PRICE_OPEN_BAND_INDEX + 1;

/**
 * Plain colored text, not a filled pill: SAMV_PURPLE on the buy modal's own
 * white background (#popupBuyDeck, confirmed live via getComputedStyle)
 * measures a 5.9:1 contrast ratio against that white, comfortably clearing
 * the 4.5:1 WCAG AA threshold for normal-size text — no need for the filled
 * pill treatment paintSamv()/applySamvStyle() use elsewhere for injected
 * controls sitting on a less predictable background.
 */
function fmtBuyPrice(value) {
  return `R$ ${value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Cards with no price sink past the open-ended band into their own "Sem preço" one. */
function buyPriceBandIndex(price) {
  if (price == null) return BUY_PRICE_NO_PRICE_BAND_INDEX;
  const idx = BUY_PRICE_BAND_UPPER_BOUNDS.findIndex((upper) => price < upper);
  return idx === -1 ? BUY_PRICE_OPEN_BAND_INDEX : idx;
}

function buyPriceBandLabel(bandIndex) {
  if (bandIndex === BUY_PRICE_NO_PRICE_BAND_INDEX) return "Sem preço";
  if (bandIndex === BUY_PRICE_OPEN_BAND_INDEX) {
    const lower = BUY_PRICE_BAND_UPPER_BOUNDS[BUY_PRICE_BAND_UPPER_BOUNDS.length - 1];
    return `Acima de ${fmtBuyPrice(lower)}`;
  }
  const upper = BUY_PRICE_BAND_UPPER_BOUNDS[bandIndex];
  const lower = bandIndex === 0 ? 0 : BUY_PRICE_BAND_UPPER_BOUNDS[bandIndex - 1];
  return `${fmtBuyPrice(lower)} – ${fmtBuyPrice(upper)}`;
}

function buildPriceBadge(price) {
  const span = document.createElement("span");
  span.className = BUY_PRICE_BADGE_CLASS;
  span.textContent = price != null ? fmtBuyPrice(price) : "Sem preço";
  Object.assign(span.style, {
    marginLeft: "8px",
    fontWeight: "700",
    fontSize: "12px",
    color: price != null ? SAMV_PURPLE : "#999",
  });
  return span;
}

/** Same border-top divider style deck-grid-prices.js's buildPriceBlock already uses. */
function buildBandDivider(label) {
  const div = document.createElement("div");
  div.className = BUY_BAND_DIVIDER_CLASS;
  div.textContent = label;
  Object.assign(div.style, {
    margin: "6px 0 4px",
    paddingTop: "4px",
    borderTop: `1px solid ${SAMV_PURPLE}`,
    fontSize: "11px",
    fontWeight: "700",
    color: SAMV_PURPLE,
  });
  return div;
}

/**
 * name -> price (R$, number) | null, read straight from the Padrão view's
 * own rows across every board (Mainboard/Sideboard/Maybeboard) — a card's
 * price doesn't depend on which board it's in, so a single flat map (matched
 * by name) is enough regardless of which buy-modal group the card sits in.
 * Exactly deck-grid-prices.js's buildDeckPriceMap technique, but keyed to a
 * parsed number (for sorting/banding) instead of the raw display text.
 */
function buildBuyModalPriceIndex(deckId) {
  const map = new Map();
  getDeckBoards(deckId).forEach((board) => {
    board.el.querySelectorAll(":scope > .deck-line").forEach((row) => {
      const link = row.querySelector(".deck-card a");
      if (!link) return; // board/category header rows have no card link
      const name = cardNameFromHref(link.getAttribute("href"));
      if (!name || map.has(name)) return;
      const font = row.querySelector('.deck-price font[class*="pdeck_preco_2_"]');
      map.set(name, parsePrice(font?.textContent));
    });
  });
  return map;
}

/**
 * Sorts and bands one `.buy-cards` group in place: appends a price badge
 * next to each card link, then MOVES (never clones) each `.cards-item` row
 * back into the group in ascending-price order, inserting a band-divider
 * header immediately before the first row of each band actually reached —
 * so a band with zero cards in it never gets an empty header.
 *
 * Returns false if the group had no card rows to process (nothing to flag as
 * done, so a later mutation on #buy-data — e.g. the trailing "Pesquisar"
 * button being appended — is free to try it again).
 */
function applyPriceGroupingToGroup(group, priceMap) {
  const rows = [...group.querySelectorAll(":scope > .cards-item")];
  if (rows.length === 0) return false;

  const rowInfos = rows.map((row) => {
    const link = row.querySelector('a[href*="view=cards/card"]');
    const name = link && cardNameFromHref(link.getAttribute("href"));
    const price = name ? (priceMap.get(name) ?? null) : null;
    if (link) link.insertAdjacentElement("afterend", buildPriceBadge(price));
    return { row, price };
  });

  // Cards with no price (price === null) sort last, exactly where the
  // trailing "Sem preço" band belongs.
  rowInfos.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));

  let lastBand = null;
  rowInfos.forEach(({ row, price }) => {
    const band = buyPriceBandIndex(price);
    if (band !== lastBand) {
      group.appendChild(buildBandDivider(buyPriceBandLabel(band)));
      lastBand = band;
    }
    group.appendChild(row);
  });

  return true;
}

/**
 * Runs (debounced) whenever #buy-data's own direct children change — i.e.
 * every time viewdeck.buy() (re)populates the modal. Only #buy-data itself
 * is observed, with no `subtree`, so the divider/badge elements this
 * function inserts *inside* each `.buy-cards` group (one level deeper) can
 * never re-trigger this same observer — no self-feedback loop by
 * construction, not by a mutation filter bolted on afterwards.
 */
function processBuyModalGroups(buyData, deckId) {
  const groups = [...buyData.querySelectorAll(":scope > .buy-cards")];
  if (groups.length === 0) return;

  const priceMap = buildBuyModalPriceIndex(deckId);
  if (priceMap.size === 0) {
    logNotShown("Preço no modal de compra", "nenhum preço encontrado na aba Padrão (#dk-val-1-<id> .deck-price)");
  }

  let processed = 0;
  groups.forEach((group) => {
    if (group.dataset.lmPriceGrouped === "1") return; // already sorted, cheap no-op
    if (applyPriceGroupingToGroup(group, priceMap)) {
      group.dataset.lmPriceGrouped = "1";
      processed++;
    }
  });
  if (processed > 0) log(`Modal de compra: ${processed} grupo(s) de cards ordenado(s) por preço.`);
}

function attachBuyModalObserver(buyData, deckId) {
  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => processBuyModalGroups(buyData, deckId), 50);
  });
  observer.observe(buyData, { childList: true });
}

/**
 * Settings are only pushed live to an already-open tab for the two cases
 * background.js's saveSettings() special-cases (showDebugLogs,
 * scryfallDefaultFilter) — every other setting, this one included, follows
 * the same convention addPriceView/addDeckGridPrices already use: read once
 * via getSettings() and take effect from the next page load/reload on. No
 * "settingsChanged" listener here since one would never actually receive
 * this key.
 */
function initBuyModalPriceGrouping() {
  if (typeof isDeckPage !== "function" || !isDeckPage()) return;
  const deckId = new URLSearchParams(location.search).get("id");
  if (!deckId) return;

  waitForElement(() => {
    // #buy-data is part of the deck page's own initial markup (confirmed
    // live: present, empty, display:none, before "Comprar Deck" is ever
    // clicked) — this normally resolves on the very first check below,
    // without ever needing the fallback MutationObserver waitForElement
    // sets up on a false return.
    const buyData = document.getElementById("buy-data");
    if (!buyData) return false;

    getSettings().then((settings) => {
      if (settings?.addBuyModalPriceGrouping === false) {
        logNotShown("Preço no modal de compra", "desabilitado nas configurações (addBuyModalPriceGrouping = false)");
        return;
      }
      attachBuyModalObserver(buyData, deckId);
    });
    return true;
  });
}

initBuyModalPriceGrouping();
