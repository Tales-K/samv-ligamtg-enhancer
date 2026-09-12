/**
 * Adds each card's price and price-band grouping to the "Comprar Deck" modal
 * on a LigaMagic deck page (`#popupBuyDeck`, filled asynchronously via
 * viewdeck.buy() with a POST to /ajax/decks/decks.php), gated by the
 * "addBuyModalPriceGrouping" setting. Also adds a running total of the
 * currently selected (checked) cards above the shared "Pesquisar" button,
 * and a checkbox on each band's own divider that checks/unchecks every
 * card in that band at once.
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
const BUY_BAND_CHECKBOX_CLASS = "lm-ext-buy-band-check";
const BUY_TOTAL_ID = "lm-ext-buy-total";

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

/**
 * Same border-top divider style deck-grid-prices.js's buildPriceBlock
 * already uses, plus a checkbox that checks/unchecks every row in this band
 * at once -- driven the same way the native "select all" header checkbox
 * drives buydeck.selAll(): calling .click() on each row's real checkbox
 * (never setting .checked directly), so the site's own buydeck.sel() runs
 * exactly as if the user had clicked each one, keeping the item-sel/
 * item-notsel class and quantity handling in sync with the native code.
 *
 * `rows` is kept on the checkbox itself (not a closure array copy) so
 * recomputeBuyModalTotal() can later read it back to sync this checkbox's
 * own checked/indeterminate state from the rows' current state.
 */
function buildBandDivider(label, rows) {
  const wrapper = document.createElement("label");
  wrapper.className = BUY_BAND_DIVIDER_CLASS;
  Object.assign(wrapper.style, {
    margin: "6px 0 4px",
    paddingTop: "4px",
    borderTop: `1px solid ${SAMV_PURPLE}`,
    fontSize: "11px",
    fontWeight: "700",
    color: SAMV_PURPLE,
    display: "flex",
    alignItems: "center",
    gap: "6px",
    cursor: "pointer",
  });

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = BUY_BAND_CHECKBOX_CLASS;
  checkbox.lmBandRows = rows;
  const rowCheckboxes = () => rows.map((row) => row.querySelector('input[type="checkbox"]')).filter(Boolean);
  checkbox.checked = rowCheckboxes().every((cb) => cb.checked);
  checkbox.addEventListener("click", () => {
    const desired = checkbox.checked; // already toggled by the click's default action
    rowCheckboxes().forEach((cb) => {
      if (cb.checked !== desired) cb.click();
    });
  });
  wrapper.appendChild(checkbox);

  const text = document.createElement("span");
  text.textContent = label;
  wrapper.appendChild(text);

  return wrapper;
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
    // Read back by recomputeBuyModalTotal() -- avoids re-deriving the name/
    // price lookup on every checkbox click or keystroke.
    row.dataset.lmPrice = price != null ? String(price) : "";
    return { row, price };
  });

  // Cards with no price (price === null) sort last, exactly where the
  // trailing "Sem preço" band belongs. Sorting by price (not band) also
  // keeps cards within the same band in ascending order, and since band
  // index is monotonic with price, every band still comes out contiguous.
  rowInfos.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));

  // Chunk into contiguous same-band runs (rowInfos is already sorted by
  // band, so a band can never split into two separate runs) so each band's
  // own divider checkbox knows exactly which rows belong to it.
  const chunks = [];
  rowInfos.forEach(({ row, price }) => {
    const band = buyPriceBandIndex(price);
    const chunk = chunks.at(-1);
    if (!chunk || chunk.band !== band) {
      chunks.push({ band, rows: [row] });
    } else {
      chunk.rows.push(row);
    }
  });

  chunks.forEach(({ band, rows: bandRows }) => {
    group.appendChild(buildBandDivider(buyPriceBandLabel(band), bandRows));
    bandRows.forEach((row) => group.appendChild(row));
  });

  return true;
}

/**
 * A running total of every selected (checked) row's price × quantity,
 * shown once above the shared "Pesquisar" button -- one figure covering
 * every group (Mainboard + Sideboard alike), since a single click on that
 * button submits the whole selection across all of them.
 */
function buildTotalDisplay() {
  const div = document.createElement("div");
  div.id = BUY_TOTAL_ID;
  Object.assign(div.style, {
    textAlign: "center",
    fontSize: "13px",
    fontWeight: "700",
    color: SAMV_PURPLE,
    padding: "6px 0",
  });
  return div;
}

/**
 * The "Pesquisar" button's own wrapper (`.box.p10`) is #buy-data's last
 * child, appended once after every `.buy-cards` group -- confirmed live.
 * Inserting right before it, rather than just appending to #buy-data, is
 * what puts the total right above that button regardless of how many
 * groups (Mainboard/Sideboard) came before it.
 */
function ensureTotalDisplay(buyData) {
  let el = document.getElementById(BUY_TOTAL_ID);
  if (el) return el;

  el = buildTotalDisplay();
  const pesquisarWrapper = [...buyData.children].find((child) => child.querySelector('input[onclick*="buydeck.go"]'));
  if (pesquisarWrapper) {
    pesquisarWrapper.insertAdjacentElement("beforebegin", el);
  } else {
    // "Pesquisar" hasn't rendered yet (or its markup changed) -- still show
    // the total somewhere rather than silently dropping it.
    logNotShown(
      "Total selecionado (posição)",
      'botão "Pesquisar" (input[onclick*=buydeck.go]) não encontrado em #buy-data',
    );
    buyData.appendChild(el);
  }
  return el;
}

/**
 * Recomputes the selected-cards total and keeps every band checkbox in
 * sync with its own rows' current checked state -- runs on every click
 * (row checkbox, +/-, band checkbox, native "select all") or keystroke
 * (typing a quantity) inside #buy-data, via one delegated, debounced
 * listener (see wireBuyModalInteractions) instead of one listener per row.
 */
function recomputeBuyModalTotal(buyData) {
  let total = 0;
  let algumSemPreco = false;

  buyData.querySelectorAll(".cards-item").forEach((row) => {
    const checkbox = row.querySelector('input[type="checkbox"]');
    if (!checkbox?.checked) return;
    if (row.dataset.lmPrice === "") {
      algumSemPreco = true;
      return;
    }
    const qty = parseInt(row.querySelector(".c-qty")?.value, 10) || 0;
    total += Number(row.dataset.lmPrice) * qty;
  });

  const el = ensureTotalDisplay(buyData);
  el.textContent =
    `Total selecionado: ${fmtBuyPrice(total)}` + (algumSemPreco ? " (não inclui cartas sem preço)" : "");

  buyData.querySelectorAll(`.${BUY_BAND_CHECKBOX_CLASS}`).forEach((bandCheckbox) => {
    const rowCheckboxes = (bandCheckbox.lmBandRows ?? [])
      .map((row) => row.querySelector('input[type="checkbox"]'))
      .filter(Boolean);
    if (rowCheckboxes.length === 0) return;
    const allChecked = rowCheckboxes.every((cb) => cb.checked);
    const noneChecked = rowCheckboxes.every((cb) => !cb.checked);
    bandCheckbox.checked = allChecked;
    bandCheckbox.indeterminate = !allChecked && !noneChecked;
  });
}

/**
 * One delegated, debounced listener for the whole modal instead of one per
 * row: "click" catches every checkbox/+/-/band-checkbox/"select all"
 * interaction (each of those already ran its own native handler by the
 * time this fires, since delegation only sees the bubbling phase), "input"
 * catches a quantity typed directly into a `.c-qty` field. Debounced
 * (via a zero-delay timeout, just enough to coalesce synchronous follow-up
 * clicks into one macrotask) because a band checkbox click synchronously
 * clicks every row checkbox in that band in a single pass (see
 * buildBandDivider) -- without this, one band toggle would recompute once
 * per row it touched instead of once overall.
 */
function wireBuyModalInteractions(buyData) {
  if (buyData.dataset.lmTotalWired === "1") return;
  buyData.dataset.lmTotalWired = "1";

  let debounceTimer = null;
  const scheduleRecompute = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => recomputeBuyModalTotal(buyData), 0);
  };

  buyData.addEventListener("click", scheduleRecompute);
  buyData.addEventListener("input", scheduleRecompute);
  recomputeBuyModalTotal(buyData);
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

  wireBuyModalInteractions(buyData);
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
