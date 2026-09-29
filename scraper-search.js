/**
 * Search-grid scraper — ?view=cards/search
 *
 * An edition or group listing renders a grid where each card already carries
 * its min and max price ("div.card-prices"), the same data the individual
 * card page's scraper caches. Browsing one of those listings therefore fills
 * the price cache for a couple of dozen cards at once, and costs nothing:
 * every value read here is already in the page, so this adds no request of
 * its own to the site.
 *
 * Not every "cards/search" variant carries those prices. Confirmed live:
 *   - "card=group=<id>" (group listing) — 24 items, all priced, visible label
 *     in English;
 *   - "card=ed=<sigla>" (edition listing) — 24 items, all priced, visible
 *     label in PORTUGUESE;
 *   - "card=<nome>" (plain name search) — same ".card-item" grid, no price
 *     block at all, so there is simply nothing to read.
 * The last case is why the absence of prices logs instead of failing quietly:
 * it's an expected variant, not a broken selector, and a future third shape
 * should be distinguishable from it in the console.
 *
 * Because the visible label is Portuguese on one of those variants and
 * English on another, the name comes from the card link's own "card" query
 * parameter, which is the English name on both (confirmed live) — and the
 * English name is what the price cache is keyed on.
 *
 * The grid lists one tile per printing, so the same card can appear several
 * times at different prices (confirmed live: an edition listing scrolled to
 * the end renders many more tiles than its own item count). The cache holds
 * one price per name, so the tiles are folded by name, keeping the cheapest —
 * not whichever tile happens to come first.
 *
 * Depends on: content-utils.js (log, logNotShown, parsePrice,
 * cardNameFromHref, sendToBackground)
 */

// ── Page detection ────────────────────────────────────────────────────────────
function isCardsSearchPage() {
  const params = new URLSearchParams(window.location.search);
  return params.get("view") === "cards/search";
}

const SEL_SEARCH_ITEM = ".card-item";
const SEL_SEARCH_LINK = "a.main-link-card";
const SEL_SEARCH_PRICES = ".card-prices";
const SEL_SEARCH_MIN = ".avgp-minprc";
const SEL_SEARCH_MAX = ".avgp-maxprc";
const SEARCH_SCRAPE_TIMEOUT_MS = 10_000;

// ── Scraper ───────────────────────────────────────────────────────────────────
/** Price text on this grid is rendered as "R$ 155,89". */
function searchGridPrice(item, selector) {
  const raw = item.querySelector(selector)?.textContent;
  if (raw == null) return null;
  return parsePrice(raw.replace("R$", "").trim());
}

/**
 * One entry per card name, carrying the cheapest price found for it across
 * every printing in the grid.
 *
 * A tile priced R$ 0,00 is ignored entirely: on this site that means the
 * printing has no price registered yet, not that it costs nothing, so it
 * neither counts as a price nor is allowed to win the cheapest comparison
 * (the same rule handleSendPrices enforces on the storage side). A card whose
 * every printing reads 0 therefore contributes nothing, which is the intended
 * outcome — its price is unknown.
 */
function scrapeCardsSearchGrid() {
  const porNome = new Map();

  document.querySelectorAll(SEL_SEARCH_ITEM).forEach((item) => {
    const name = cardNameFromHref(item.querySelector(SEL_SEARCH_LINK)?.getAttribute("href") ?? "");
    if (!name) return;

    const priceMin = searchGridPrice(item, SEL_SEARCH_MIN);
    if (priceMin == null || priceMin <= 0) return;

    const atual = porNome.get(name);
    if (atual && atual.priceMin <= priceMin) return;
    porNome.set(name, {
      name,
      priceMin,
      // This grid shows only the two ends of the range, no average.
      priceAvg: null,
      // Read off the same tile as the winning minimum, so the pair describes
      // one printing rather than mixing two.
      priceMax: searchGridPrice(item, SEL_SEARCH_MAX),
    });
  });

  return [...porNome.values()];
}

// ── Auto-scrape ───────────────────────────────────────────────────────────────
function autoScrapeCardsSearch() {
  log("Search grid detected — waiting for priced cards…");
  let enviado = false;

  // Keeps waiting while the grid has items but no prices yet, rather than
  // concluding on the first pass that this variant has none.
  waitForElement(() => {
    if (enviado) return true;
    const cards = scrapeCardsSearchGrid();
    if (cards.length === 0) return false;
    enviado = true;
    log(`Scraped ${cards.length} card(s) from the search grid.`);
    sendToBackground(cards, `${cards.length} card(s) da grade de busca`);
    return true;
  }, SEARCH_SCRAPE_TIMEOUT_MS);

  // waitForElement has no timeout callback of its own, so without this a
  // variant that never renders a price block would leave no trace at all --
  // exactly the silent gap this project has been bitten by before.
  setTimeout(() => {
    if (enviado) return;
    const total = document.querySelectorAll(SEL_SEARCH_ITEM).length;
    logNotShown(
      "Scraper da grade de busca",
      total === 0
        ? `nenhum elemento "${SEL_SEARCH_ITEM}" na página`
        : `${total} card(s) na grade, nenhum com preço em "${SEL_SEARCH_PRICES}" (esperado numa busca por nome)`,
    );
  }, SEARCH_SCRAPE_TIMEOUT_MS + 500);
}
