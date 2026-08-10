/**
 * Shared helpers for the three site-specific price overlays (Archidekt,
 * Moxfield, Scryfall). Each site's DOM/selectors are genuinely different
 * (that part stays in the site-specific file), but all three duplicated the
 * same price-formatting, background-messaging, and debounced-observer
 * boilerplate — this file is that shared half. Listed first in each
 * overlay's content_scripts entry in manifest.json, same pattern as
 * content-utils.js for the ligamagic.com.br bundle.
 */

const IS_LOCAL = false; // set to false in production builds

function createLogger(siteName) {
  return (...args) => {
    if (IS_LOCAL) console.log(`[LigaMagic Tracker | ${siteName}]`, ...args);
  };
}

const LIGAMAGIC_BASE = "https://www.ligamagic.com.br/?view=cards%2Fcard&card=";

function priceColor(updatedAt) {
  if (!updatedAt) return "#ef4444"; // red   — not in DB
  const age = Date.now() - new Date(updatedAt).getTime();
  const DAY = 86_400_000;
  if (age < 7 * DAY) return "#33ac5f"; // green  — < 1 week
  if (age < 30 * DAY) return "#cfad25"; // yellow — 1 week – 1 month
  return "#c73b3b"; // red    — older than 1 month
}

/**
 * `spaced` preserves each site's existing exact output rather than silently
 * unifying them: Archidekt has always shown "R$ 5,00" (spaced), Moxfield and
 * Scryfall "R$5,00" (not). The no-price case ("R$ —") is spaced everywhere.
 */
function fmtBRL(value, { spaced = false } = {}) {
  if (value == null) return "R$ —";
  const amount = value.toFixed(2).replace(".", ",");
  return spaced ? `R$ ${amount}` : `R$${amount}`;
}

function logPriceMap(log, priceMap, allNames) {
  if (!IS_LOCAL) return;
  allNames.forEach((name) => {
    const info = priceMap[name];
    if (info) {
      const date = new Date(info.updatedAt).toLocaleString("pt-BR");
      log(`  ${name}: R$ ${info.priceMin?.toFixed(2) ?? "—"} (atualizado em ${date})`);
    } else {
      log(`  ${name}: no price in DB`);
    }
  });
}

function queryPrices(log, names, callback) {
  chrome.runtime.sendMessage({ action: "queryPrices", cards: names }, (response) => {
    if (chrome.runtime.lastError) {
      log("Background error:", chrome.runtime.lastError.message);
      callback({});
      return;
    }
    callback(response?.prices ?? {});
  });
}

/** True if any mutation added an element matching (or containing) `selector`. */
function hasAddedNodeMatching(mutations, selector) {
  return mutations.some((m) =>
    [...m.addedNodes].some(
      (n) => n.nodeType === Node.ELEMENT_NODE && (n.matches?.(selector) || n.querySelector?.(selector)),
    ),
  );
}

/**
 * Wires up a MutationObserver on document.body: whenever `shouldRun(mutations)`
 * returns true, `runFn` fires once, 600ms after the last qualifying mutation
 * (bursts of DOM changes collapse into a single run). Also runs once
 * immediately for content already rendered when the script is injected.
 */
function observeAndRerun(shouldRun, runFn) {
  let debounceTimer = null;
  const scheduleRun = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runFn, 600);
  };

  new MutationObserver((mutations) => {
    if (shouldRun(mutations)) scheduleRun();
  }).observe(document.body, { childList: true, subtree: true });

  scheduleRun();
}
