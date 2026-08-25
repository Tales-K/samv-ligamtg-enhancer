/**
 * Adds LigaMagic's own Mín/Méd/Máx price trio underneath each card image in
 * the deck page's native "Grid" view (gated by the "addDeckGridPrices"
 * setting, on by default).
 *
 * That view's own <img> only carries price-min/price-max as attributes (no
 * avg at all — confirmed live) — so instead of reading those, this reads all
 * three straight from the Padrão view's own .deck-price rows
 * (#dk-val-1-<id>). The site pre-renders every native view up front as
 * sibling divs and only toggles which one is visible (see deck-view.js's own
 * file header), so that data is present and fully priced in the DOM
 * regardless of which tab the viewer currently has selected — matched to
 * each grid image here by card name.
 *
 * Depends on: content-utils.js (log, cardNameFromHref, waitForElement),
 * scraper-deck.js (isDeckPage)
 */

const GRID_PRICE_BLOCK_CLASS = "lm-ext-grid-price";

/** name -> { min, avg, max } (raw "5,24"-style text, exactly as LigaMagic's own .deck-price fonts already show it — no reparsing, so this can't drift from what a viewer would see toggling the native min/avg/max switch by hand). */
function buildDeckPriceMap(deckId) {
  const map = new Map();
  document.querySelectorAll(`#dk-val-1-${deckId} .deck-line`).forEach((line) => {
    const link = line.querySelector(".deck-card a");
    if (!link) return; // board/category header rows have no card link
    const name = cardNameFromHref(link.getAttribute("href"));
    if (!name || map.has(name)) return;

    const fonts = line.querySelector(".deck-price")?.querySelectorAll("font");
    if (!fonts || fonts.length < 3) return;
    map.set(name, {
      min: fonts[0].textContent.trim(),
      avg: fonts[1].textContent.trim(),
      max: fonts[2].textContent.trim(),
    });
  });
  return map;
}

/**
 * Min/avg/max side by side on one line, colored green/yellow/red so the
 * three stay tellable apart without needing a "Mín/Méd/Máx" label in front
 * of each one — same identity colors used for the card-hover price line
 * (card-hover-links.js's buildCardPriceParts).
 */
function buildPriceBlock(prices) {
  const block = document.createElement("div");
  block.className = GRID_PRICE_BLOCK_CLASS;
  Object.assign(block.style, {
    marginTop: "2px",
    padding: "2px 3px 0",
    borderTop: `1px solid ${SAMV_PURPLE}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "9.5px",
    lineHeight: "1.35",
    fontWeight: "700",
  });

  [
    [prices.min, SAMV_PRICE_MIN_COLOR],
    [prices.avg, SAMV_PRICE_AVG_COLOR],
    [prices.max, SAMV_PRICE_MAX_COLOR],
  ].forEach(([value, color], i) => {
    if (i > 0) {
      const spacer = document.createElement("span");
      spacer.textContent = "•";
      spacer.style.margin = "0 3px";
      spacer.style.color = "#999";
      block.appendChild(spacer);
    }
    const span = document.createElement("span");
    span.textContent = value ? `R$ ${value}` : "—";
    span.style.color = color;
    block.appendChild(span);
  });

  return block;
}

/**
 * Grid images are wrapped one-per-card in .image-container, but
 * .card-container-visual-grid itself is a whole CATEGORY's CSS grid (holding
 * every card in that category, not one card each — confirmed live: 23 cards
 * across only 5 .card-container-visual-grid elements) so the price block is
 * appended inside each .image-container specifically, keeping it aligned
 * with its own card's cell rather than becoming a stray extra grid item.
 */
function injectGridPrices(deckId) {
  const priceMap = buildDeckPriceMap(deckId);
  if (priceMap.size === 0) {
    logNotShown("Preços na visualização em grid", "nenhum preço encontrado na aba Padrão (#dk-val-1-<id> .deck-price)");
    return;
  }

  let injected = 0;
  document.querySelectorAll(".card-container-visual-grid .image-container").forEach((wrap) => {
    if (wrap.querySelector(`.${GRID_PRICE_BLOCK_CLASS}`)) return;

    const link = wrap.querySelector('a[href*="view=cards/card"]');
    const name = link && cardNameFromHref(link.getAttribute("href"));
    const prices = name && priceMap.get(name);
    if (!prices) return;

    wrap.appendChild(buildPriceBlock(prices));
    injected++;
  });

  if (injected > 0) log(`Grid view: ${injected} price block(s) added.`);
}

function initDeckGridPrices() {
  if (typeof isDeckPage !== "function" || !isDeckPage()) return;
  const deckId = new URLSearchParams(location.search).get("id");
  if (!deckId) return;

  const tryInit = () => {
    // Both the Padrão view (price source) and the Grid view (injection
    // target) need to be in the DOM — they're rendered together, but not
    // necessarily on the very first paint.
    if (!document.getElementById(`dk-val-1-${deckId}`)) return false;
    if (!document.querySelector(".card-container-visual-grid")) return false;

    chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
      if (settings?.addDeckGridPrices === false) {
        logNotShown("Preços na visualização em grid", "desabilitado nas configurações (addDeckGridPrices = false)");
        return;
      }
      injectGridPrices(deckId);
    });
    return true;
  };

  if (tryInit()) return;

  const observer = new MutationObserver(() => {
    if (tryInit()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Give up after 15 s to avoid leaking the observer.
  setTimeout(() => observer.disconnect(), 15_000);
}

initDeckGridPrices();
