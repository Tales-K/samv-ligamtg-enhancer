/**
 * Shared helpers for all LigaMagic content scripts.
 * Must be listed first in manifest.json so the globals are available
 * to scraper-deck.js, scraper-card.js, and content.js.
 */

const IS_LOCAL = false; // set to false in production builds

function log(...args) {
  if (IS_LOCAL) console.log("[LigaMagic Tracker]", ...args);
}

// ── DOM readiness ────────────────────────────────────────────────────────────
/**
 * Retries `tryFn()` (which should return true once it found what it needed
 * and did its job, false if the DOM isn't ready yet) via a MutationObserver,
 * giving up after `timeoutMs` so a page that never renders the expected
 * content doesn't leak an observer forever.
 */
function waitForElement(tryFn, timeoutMs = 15_000) {
  if (tryFn()) return;

  const observer = new MutationObserver(() => {
    if (tryFn()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  setTimeout(() => observer.disconnect(), timeoutMs);
}

// ── Button feedback ───────────────────────────────────────────────────────────
/**
 * Flashes `text` on `button` for a moment, then restores whatever label it
 * had before. Restarts its own timer on repeated clicks instead of stacking
 * them, and remembers the original label per-button so it's never lost.
 */
function showCopiedFeedback(button, text = "Copiado!") {
  if (button.dataset.originalLabel == null) {
    button.dataset.originalLabel = button.textContent;
  }
  button.textContent = text;
  clearTimeout(showCopiedFeedback.timers?.get(button));
  showCopiedFeedback.timers ??= new Map();
  showCopiedFeedback.timers.set(
    button,
    setTimeout(() => {
      button.textContent = button.dataset.originalLabel;
    }, 1500),
  );
}

// ── Price parsing ─────────────────────────────────────────────────────────────
function parsePrice(text) {
  if (!text) return null;
  // Brazilian format uses '.' as thousands separator and ',' as decimal separator.
  // e.g. "1.439,99" → strip dots → "1439,99" → swap comma → "1439.99"
  const num = parseFloat(text.trim().replace(/\./g, "").replace(",", "."));
  return isNaN(num) ? null : num;
}

// ── Card name decoding ────────────────────────────────────────────────────────
/**
 * Derives the canonical (always-English) card name from the href's `card` param.
 *
 * LigaMagic displays card names in the user's chosen language (PT/EN), so
 * reading textContent would store duplicates. The `card` query param always
 * contains the English name in a URL+HTML-encoded form:
 *
 *   L%26oacute%3Brien+Revealed  →  Lórien Revealed
 *   Picklock+Prankster+%2F%2F+Free+the+Fae  →  Picklock Prankster // Free the Fae
 *   Nymris%2C+Oona%27s+Trickster  →  Nymris, Oona's Trickster
 *
 * Decoding steps:
 *   1. Extract the raw `card` param string.
 *   2. Replace `+` with space (application/x-www-form-urlencoded convention).
 *   3. decodeURIComponent — handles %2F, %2C, %27, %26, %3B, etc.
 *   4. HTML-entity decode via a throwaway <textarea> — handles &oacute;, &amp;, etc.
 */
const _htmlDecoder = document.createElement("textarea");
function htmlDecode(str) {
  _htmlDecoder.innerHTML = str;
  return _htmlDecoder.value;
}

function cardNameFromHref(href) {
  try {
    const url = new URL(href, location.href);
    const raw = url.searchParams.get("card");
    if (!raw) return null;
    return htmlDecode(raw.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

// ── Background delegation ─────────────────────────────────────────────────────
/**
 * Promise-wrapped `chrome.runtime.sendMessage` — resolves with the response,
 * or `{ error }` if the background worker couldn't be reached.
 */
function sendMessage(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response);
    });
  });
}

/** Shorthand for the common `{ action: "getSettings" }` round-trip. */
const getSettings = () => sendMessage({ action: "getSettings" });

/**
 * Sends a scraped card list to the background service worker.
 * @param {object[]} cards
 * @param {string} logLabel  Human-readable description for log output.
 */
function sendToBackground(cards, logLabel) {
  log(`Forwarding ${logLabel} to background worker…`);
  chrome.runtime.sendMessage({ action: "sendPrices", cards }, (response) => {
    if (chrome.runtime.lastError) {
      log("Background error:", chrome.runtime.lastError.message);
      return;
    }
    if (response?.skipped) {
      log("Already sent today — skipping.");
    } else if (response?.noPrice) {
      log("No price available — skipping.");
    } else if (response?.error) {
      log("Error from background:", response.error);
    } else {
      log(`Done — ${response?.message}`);
    }
  });
}
