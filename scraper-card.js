/**
 * Individual card page scraper — ?view=cards/card&card=...
 *
 * Depends on: content-utils.js (log, parsePrice, sendToBackground, sendMessage)
 */

// ── Page detection ────────────────────────────────────────────────────────────
function isCardPage() {
  const params = new URLSearchParams(window.location.search);
  // URLSearchParams auto-decodes %2F → /, so the check is simply "cards/card"
  return params.get("view") === "cards/card" && params.has("card");
}

// ── Filter detection ─────────────────────────────────────────────────────────
/**
 * Returns true when a marketplace filter is currently active.
 * The element is always present in the DOM; it's hidden with display:none
 * when no filter is applied.
 */
function isFilterActive() {
  const el = document.getElementById("marketplace-filters-count");
  if (!el) return false;
  return el.style.display !== "none";
}

// ── Price panel helpers ───────────────────────────────────────────────────────
/**
 * Reads ALL min prices from the price panel (Normal + Foil sections)
 * and returns the lowest value found.
 * Target: #container-price-mkp-card .price-mkp .min .price
 */
function readCheapestMinFromPanel() {
  let best = null;
  document
    .querySelectorAll("#container-price-mkp-card .price-mkp .min .price")
    .forEach((el) => {
      const price = parsePrice(el.textContent.replace("R$", "").trim());
      if (price != null && (best == null || price < best)) best = price;
    });
  return best;
}

/**
 * Cheapest "p" (preço mínimo) across every quality tier in one edition's
 * price entry.
 *
 * Shape varies: a single-tier edition has `price` as a flat {p,m,g} object;
 * a multi-tier one has it keyed by quality index ("0" Normal, "2" Foil, …),
 * each either {p,m,g} or [] when that tier has no stock. Field mapping
 * (p=min, m=médio/avg, g=geral/máximo) confirmed live against the rendered
 * panel for a known edition.
 */
function cheapestFromEditionPrice(priceEntry) {
  if (!priceEntry) return null;
  const tiers = priceEntry.p !== undefined ? [priceEntry] : Object.values(priceEntry);
  let min = null;
  tiers.forEach((tier) => {
    if (!tier || Array.isArray(tier)) return; // [] = no offers at that quality
    const p = parseFloat(tier.p);
    if (!isNaN(p) && (min == null || p < min)) min = p;
  });
  return min;
}

// ── Scraper ───────────────────────────────────────────────────────────────────
/**
 * Reads the minimum price across every printing of the current card,
 * straight from editionsCard.jsonEditions (see handleGetCardEditionsPrices
 * in background.js) — the same per-edition price data the page's own hover
 * handler reads, already loaded with the page rather than fetched per
 * edition. No simulated hovering or waiting needed to find the cheapest one;
 * a single hover at the end just re-selects it on screen for the user.
 *
 * Skips entirely if any marketplace filter is active.
 *
 * Returns a single-element array, or an empty array if scraping should be skipped.
 */
async function scrapeCardPage() {
  // Bail out when a marketplace filter is active.
  if (isFilterActive()) {
    log("Card page: filter active — skipping.");
    return [];
  }

  const nameEl =
    document.querySelector(".item-name-en") ??
    document.querySelector(".item-name");
  const name = nameEl?.textContent?.trim();
  if (!name) {
    log("Card page: could not find card name — skipping.");
    return [];
  }

  // Skip reading every printing's price below when this card's price is
  // still current. The background's price cache only ever holds entries
  // scraped today — it prunes older ones as it loads — so a hit here means
  // there is nothing to refresh.
  const cached = await sendMessage({ action: "queryPrices", cards: [name] });
  if (cached?.prices?.[name]) {
    log(`Card page: "${name}" already scraped today — skipping.`);
    return [];
  }

  const icons = [
    ...document.querySelectorAll("#slider-editions-icons .edition-icon"),
  ];

  // Single-edition card: no icon slider rendered — read panel directly.
  if (icons.length === 0) {
    log("Card page: single edition — reading panel directly.");
    const price = readCheapestMinFromPanel();
    if (price == null) {
      log("Card page: no price found in panel.");
      return [];
    }
    log(`Card page: price — R$ ${price.toFixed(2).replace(".", ",")}`);
    return [{ name, priceMin: price, priceAvg: null, priceMax: null }];
  }

  log(`Card page: reading ${icons.length} edition(s) from page data…`);

  const editionsData = await sendMessage({ action: "getCardEditionsPrices" });
  if (!Array.isArray(editionsData)) {
    log("Card page: edition price data unavailable — skipping.");
    return [];
  }

  let cheapest = null;
  let cheapestIdkey = null;
  editionsData.forEach(({ idkey, price }) => {
    const min = cheapestFromEditionPrice(price);
    if (min != null && (cheapest == null || min < cheapest)) {
      cheapest = min;
      cheapestIdkey = idkey;
    }
  });

  if (cheapest == null) {
    log("Card page: no price found across any edition.");
    return [];
  }

  // Hover the cheapest edition so it stays displayed on screen.
  const cheapestIcon = icons.find((icon) => icon.dataset.editionKey === cheapestIdkey);
  if (cheapestIcon) {
    cheapestIcon.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    cheapestIcon.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  }

  log(
    `Card page: cheapest price — R$ ${cheapest.toFixed(2).replace(".", ",")}`,
  );
  return [{ name, priceMin: cheapest, priceAvg: null, priceMax: null }];
}

// ── DOM readiness ─────────────────────────────────────────────────────────────
/**
 * Waits for the price panel to have at least one rendered price.
 * This works for both single-edition cards (no icon slider) and
 * multi-edition cards (icon slider also present).
 */
function waitForCardPageContent(callback) {
  const ready = () =>
    document.querySelector("#container-price-mkp-card .price-mkp .min .price");

  if (ready()) {
    callback();
    return;
  }

  const observer = new MutationObserver(() => {
    if (ready()) {
      observer.disconnect();
      callback();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Give up after 15 s to avoid leaking the observer.
  setTimeout(() => observer.disconnect(), 15_000);
}

// ── Auto-scrape ───────────────────────────────────────────────────────────────
function autoScrapeCardPage() {
  log("Card page detected — waiting for price panel…");

  waitForCardPageContent(async () => {
    const cards = await scrapeCardPage();
    if (cards.length > 0) {
      sendToBackground(cards, `card "${cards[0].name}"`);
    }

    // Watch the filter element's style attribute for changes.
    // When the user removes a filter (display flips to "none"), re-scrape.
    // When a filter is applied (display becomes visible), log and wait.
    const filterEl = document.getElementById("marketplace-filters-count");
    if (!filterEl) return;

    const filterObserver = new MutationObserver(async () => {
      if (isFilterActive()) {
        log("Card page: filter applied — will scrape when removed.");
      } else {
        log("Card page: filter removed — re-scraping…");
        const updated = await scrapeCardPage();
        if (updated.length > 0) {
          sendToBackground(updated, `card "${updated[0].name}"`);
        }
      }
    });

    filterObserver.observe(filterEl, {
      attributes: true,
      attributeFilter: ["style"],
    });
  });
}
