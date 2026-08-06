/**
 * Individual card page scraper — ?view=cards/card&card=...
 *
 * Depends on: content-utils.js (log, parsePrice, sendToBackground)
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
 * Dispatches hover events on a single edition icon and resolves with the
 * cheapest minimum price (Normal vs Foil) once the price panel updates.
 * Polls every 10 ms and gives up after 500 ms if no price appears.
 */
function hoverEditionAndWaitForPrice(icon) {
  return new Promise((resolve) => {
    const panel = document.getElementById("container-price-mkp-card");
    if (!panel) {
      resolve(null);
      return;
    }

    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      resolve(readCheapestMinFromPanel());
    };

    const observer = new MutationObserver(done);
    observer.observe(panel, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    icon.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    icon.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));

    // Poll every 10 ms; give up after 500 ms.
    const deadline = Date.now() + 500;
    (function poll() {
      if (settled) return;
      if (readCheapestMinFromPanel() != null) {
        done();
        return;
      }
      if (Date.now() >= deadline) {
        done();
        return;
      }
      setTimeout(poll, 10);
    })();
  });
}

// ── Scraper ───────────────────────────────────────────────────────────────────
/**
 * Hovers every edition icon for the current card, reads the minimum price
 * from the header price panel after each hover, and returns the cheapest
 * value found across all editions.
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

  // Early-exit if this card was already sent today.
  const today = new Date().toISOString().slice(0, 10);
  const { stats } = await chrome.storage.local.get("stats");
  if (stats?.todayDate === today && stats?.todayCards?.[name]) {
    log(`Card page: "${name}" already sent today — skipping.`);
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

  log(`Card page: scanning ${icons.length} edition(s) for cheapest price…`);

  let cheapest = null;
  let cheapestIcon = null;
  for (const icon of icons) {
    const price = await hoverEditionAndWaitForPrice(icon);
    if (price != null && (cheapest == null || price < cheapest)) {
      cheapest = price;
      cheapestIcon = icon;
    }
  }

  if (cheapest == null) {
    log("Card page: no price found across any edition.");
    return [];
  }

  // Re-hover the cheapest edition so it stays displayed on screen.
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
    // Hover all editions and pick the cheapest price.
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
