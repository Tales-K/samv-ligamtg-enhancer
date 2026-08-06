/**
 * Content script entry point — page detection and message handling.
 *
 * Load order (declared in manifest.json):
 *   1. content-utils.js    — shared helpers (log, parsePrice, cardNameFromHref, sendToBackground)
 *   2. nav-menu.js         — customizes the main menu (adds "Meus Decks", removes "Leilões")
 *   3. scraper-deck.js     — deck page scraper
 *   4. deck-view.js        — adds the "Preço" deck visualization tab
 *   5. deck-copy-button.js — replaces "Gerar Imagem" with "Copiar Deck"
 *   6. lista-defaults.js   — applies default filters on the "Compra por Lista" page
 *   7. scraper-card.js     — individual card page scraper
 *   8. content.js          — this file
 *
 * The background service worker owns all storage reads/writes.
 */

// ── Message listener (popup → content script) ─────────────────────────────────
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === "scrapeCards") {
    sendResponse({ cards: isDeckPage() ? scrapeCardsDeck() : [] });
  }
  return true;
});

// ── Init ──────────────────────────────────────────────────────────────────────
if (isDeckPage()) {
  autoScrapeDeck();
} else if (isCardPage()) {
  autoScrapeCardPage();
}
