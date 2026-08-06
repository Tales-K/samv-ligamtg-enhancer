/**
 * Archidekt price overlay — replaces USD price links with BRL prices from LigaMagic.
 *
 * Flow:
 *   1. Collect all unique card names from the current view.
 *   2. Ask the background worker for locally cached prices (chrome.storage.local).
 *   3. Replace each USD price link with a coloured BRL price that links to LigaMagic.
 *   4. Re-run automatically when the SPA re-renders the card list.
 *
 * Depends on: overlay-utils.js (log factory, priceColor, fmtBRL, logPriceMap,
 * queryPrices, observeAndRerun, hasAddedNodeMatching) — shared with the
 * Moxfield/Scryfall overlays. Does NOT depend on content-utils.js (different
 * host, separate injection).
 */

const log = createLogger("Archidekt");

// ── Constants ─────────────────────────────────────────────────────────────────
// Archidekt uses CSS Modules — class names have hash suffixes that can change
// between deploys. We match on the stable semantic prefix with [class*=...].
const SEL_CARD_BUTTON = '[class*="textViewCard_button"]';
const SEL_PRICE_LINK = '[class*="textViewCard_shoppingUrl"]';
const SEL_CARD_ROW = '[class*="textViewCard_card"]';

// data-attribute set on price elements we have already processed.
const PROCESSED_ATTR = "data-lm-processed";

// ── Card extraction ───────────────────────────────────────────────────────────
function extractCardNames() {
  const names = new Set();
  document.querySelectorAll(SEL_CARD_BUTTON).forEach((btn) => {
    const name = btn.getAttribute("title")?.trim();
    if (name) names.add(name);
  });
  return [...names];
}

// ── Price overlay ─────────────────────────────────────────────────────────────
/**
 * @param {Record<string, {priceMin: number|null, updatedAt: string}>} priceMap
 *   Keyed by card name.
 */
function applyPrices(priceMap, openLigaMagicOnClick = true) {
  let replaced = 0;
  document.querySelectorAll(SEL_PRICE_LINK).forEach((linkEl) => {
    // Skip already-processed elements (handles partial re-renders).
    if (linkEl.hasAttribute(PROCESSED_ATTR)) return;

    // Walk up to the card row to find the card name.
    const row = linkEl.closest(SEL_CARD_ROW);
    if (!row) return;

    const btn = row.querySelector(SEL_CARD_BUTTON);
    const name = btn?.getAttribute("title")?.trim();
    if (!name) return;

    const info = priceMap[name] ?? null;

    const url = LIGAMAGIC_BASE + encodeURIComponent(name);
    linkEl.setAttribute(PROCESSED_ATTR, "1");

    if (info?.priceMin != null) {
      // ── Has a LigaMagic price → replace the original price label ──────────
      const color = priceColor(info.updatedAt);
      const label = fmtBRL(info.priceMin, { spaced: true });
      const tooltip = `LigaMagic — atualizado em ${new Date(info.updatedAt).toLocaleDateString("pt-BR")}`;

      if (openLigaMagicOnClick) {
        linkEl.href = url;
        linkEl.target = "_blank";
        linkEl.rel = "noopener noreferrer";
      } else {
        linkEl.removeAttribute("href");
        linkEl.removeAttribute("target");
        linkEl.removeAttribute("rel");
      }
      linkEl.title = tooltip;
      linkEl.textContent = label;
      linkEl.style.cssText = [
        `color: ${color}`,
        "font-weight: 600",
        "text-decoration: none",
        openLigaMagicOnClick ? "cursor: pointer" : "cursor: default",
        "transition: opacity 0.15s",
      ].join("; ");
      linkEl.onmouseenter = () => {
        linkEl.style.opacity = "0.75";
      };
      linkEl.onmouseleave = () => {
        linkEl.style.opacity = "1";
      };
    } else if (openLigaMagicOnClick) {
      // ── No LigaMagic price → only redirect to LigaMagic, keep original style
      linkEl.href = url;
      linkEl.title =
        "Sem preço no LigaMagic — clique para abrir a página do card";
    }

    replaced++;
  });

  if (replaced > 0) log(`Replaced ${replaced} price label(s).`);
}

// ── Group total update ─────────────────────────────────────────────────────────
/**
 * For each card group (stack), sums qty × priceMin for every card found in
 * priceMap and updates the group header total in-place.
 *
 * Structure targeted:
 *   <div class="stackHeader_meta...">
 *     <span>Qty: 2</span>
 *     <span>Price: <span title="$5.98">$5.98</span></span>
 *   </div>
 */
function updateGroupTotals(priceMap) {
  const SEL_STACK = '[class*="stackWrapper_container"]';

  document.querySelectorAll(SEL_STACK).forEach((stack) => {
    let total = 0;
    let hasAnyPrice = false;

    stack.querySelectorAll(SEL_CARD_ROW).forEach((row) => {
      const btn = row.querySelector(SEL_CARD_BUTTON);
      if (!btn) return;

      const name = btn.getAttribute("title")?.trim();
      if (!name) return;

      // Quantity is the first text node of the button (before the card name span).
      const qtyText = btn.childNodes[0]?.textContent?.trim();
      const qty = parseInt(qtyText) || 1;

      const info = priceMap[name];
      if (info?.priceMin != null) {
        total += qty * info.priceMin;
        hasAnyPrice = true;
      }
    });

    if (!hasAnyPrice) return;

    // The price total lives in the inner <span title="..."> inside stackHeader_meta.
    const totalSpan = stack.querySelector(
      '[class*="stackHeader_meta"] span[title]',
    );
    if (!totalSpan) return;

    const formatted = `R$ ${total.toFixed(2).replace(".", ",")}`;
    const originalGroupTitle =
      totalSpan.getAttribute("data-lm-original") ??
      totalSpan.textContent.trim();
    totalSpan.setAttribute("data-lm-original", originalGroupTitle);
    totalSpan.textContent = `${originalGroupTitle}  ·  ${formatted}`;
    totalSpan.title = `${originalGroupTitle}  ·  ${formatted}`;
  });

  log("Group totals updated.");
}

// ── Deck header total ─────────────────────────────────────────────────────────
/**
 * Sums qty × priceMin for every card in the entire deck (all groups except
 * "Maybeboard") and updates the deck header estimated cost span in-place.
 *
 * Target: <span class="deckPrice_orange__...">$281.98</span>
 */
function updateDeckTotal(priceMap) {
  const SEL_STACK = '[class*="stackWrapper_container"]';
  const SEL_STACK_TITLE = '[class*="stackHeader_title"]';

  let total = 0;
  let hasAnyPrice = false;

  document.querySelectorAll(SEL_STACK).forEach((stack) => {
    const titleEl = stack.querySelector(SEL_STACK_TITLE);
    if (titleEl?.textContent?.trim() === "Maybeboard") return;

    stack.querySelectorAll(SEL_CARD_BUTTON).forEach((btn) => {
      const name = btn.getAttribute("title")?.trim();
      if (!name) return;

      const qtyText = btn.childNodes[0]?.textContent?.trim();
      const qty = parseInt(qtyText) || 1;

      const info = priceMap[name];
      if (info?.priceMin != null) {
        total += qty * info.priceMin;
        hasAnyPrice = true;
      }
    });
  });

  if (!hasAnyPrice) return;

  const priceSpan = document.querySelector('[class*="deckPrice_orange"]');
  if (!priceSpan) return;

  const brlDeckTotal = `R$ ${total.toFixed(2).replace(".", ",")}`;
  const originalDeckText =
    priceSpan.getAttribute("data-lm-original") ?? priceSpan.textContent.trim();
  priceSpan.setAttribute("data-lm-original", originalDeckText);
  priceSpan.textContent = `${originalDeckText}  ·  ${brlDeckTotal}`;
  log(`Deck total updated: R$ ${total.toFixed(2)}`);
}
// ── Main run ──────────────────────────────────────────────────────────────────
function run() {
  chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
    if (chrome.runtime.lastError) {
      log("Could not read settings:", chrome.runtime.lastError.message);
      return;
    }
    if (settings?.overlayArchidekt === false) {
      log("Overlay disabled via settings.");
      return;
    }
    const openLigaMagicOnClick = settings?.openLigaMagicOnClick ?? true;
    const names = extractCardNames();
    if (names.length === 0) return;
    log(`Found ${names.length} unique card(s) — querying BRL prices…`);

    queryPrices(log, names, (priceMap) => {
      const found = Object.keys(priceMap).length;
      log(`Prices received: ${found}/${names.length}`);
      logPriceMap(log, priceMap, names);
      applyPrices(priceMap, openLigaMagicOnClick);
      updateGroupTotals(priceMap);
      updateDeckTotal(priceMap);
    });
  });
}

// ── SPA observer ──────────────────────────────────────────────────────────────
// Archidekt is a React SPA. Card rows are added/removed as the user switches
// deck views. observeAndRerun debounces mutations so a burst of DOM changes
// triggers one run, and does the initial run for content already rendered.
observeAndRerun((mutations) => hasAddedNodeMatching(mutations, SEL_CARD_ROW), run);
