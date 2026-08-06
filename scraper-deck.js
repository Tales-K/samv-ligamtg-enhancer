/**
 * Deck page scraper — ?view=dks/deck&id=...
 *
 * Depends on: content-utils.js (log, parsePrice, cardNameFromHref, sendToBackground)
 */

// ── Page detection ────────────────────────────────────────────────────────────
function isDeckPage() {
  const params = new URLSearchParams(window.location.search);
  return params.get("view") === "dks/deck" && params.has("id");
}

// ── Scraper ───────────────────────────────────────────────────────────────────
/**
 * Scrapes card names and prices from a deck page.
 *
 * The deck widget renders the same cards in multiple view modes (by type, by colour,
 * by CMC, etc.) each assigned an id like "dk-val-1-X", "dk-val-2-X"…
 * We read only from "dk-val-1-*" to avoid counting the same card multiple times.
 */
function scrapeCardsDeck() {
  const cards = [];
  const seen = new Set();

  const cardLinks = document.querySelectorAll('[id^="dk-val-1-"] .deck-card a');

  cardLinks.forEach((link) => {
    const name = cardNameFromHref(link.getAttribute("href"));
    if (!name || seen.has(name)) return;
    seen.add(name);

    const deckLine = link.closest(".deck-line");
    if (!deckLine) return;

    const priceDiv = deckLine.querySelector(".deck-price");
    if (!priceDiv) return;

    const fonts = /** @type {NodeListOf<HTMLElement>} */ (
      priceDiv.querySelectorAll("font")
    );
    const priceMin = parsePrice(fonts[0]?.textContent);
    const priceAvg = parsePrice(fonts[1]?.textContent);
    const priceMax = parsePrice(fonts[2]?.textContent);

    const qtyEl = link.closest(".deck-box-left")?.querySelector(".deck-qty");
    const qty = parseInt(qtyEl?.textContent?.trim()) || 1;

    cards.push({ name, priceMin, priceAvg, priceMax, qty });
  });

  return cards;
}

// ── DOM readiness ─────────────────────────────────────────────────────────────
/**
 * Waits for deck card links to appear in the DOM (the deck list may render
 * after the initial HTML is parsed), then calls callback once.
 */
function waitForDeckContent(callback) {
  if (document.querySelector('[id^="dk-val-1-"] .deck-card a')) {
    callback();
    return;
  }

  const observer = new MutationObserver(() => {
    if (document.querySelector('[id^="dk-val-1-"] .deck-card a')) {
      observer.disconnect();
      callback();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Give up after 15 s to avoid leaking the observer.
  setTimeout(() => observer.disconnect(), 15_000);
}

// ── Auto-scrape ───────────────────────────────────────────────────────────────
function autoScrapeDeck() {
  log("Deck page detected — waiting for content…");

  waitForDeckContent(() => {
    const cards = scrapeCardsDeck();
    log(`Scraped ${cards.length} card(s).`);
    if (cards.length === 0) return;
    sendToBackground(cards, `${cards.length} card(s)`);
  });
}
