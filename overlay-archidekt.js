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

/**
 * Anchor for the pending-prices button: right after the "More" button in the
 * deck's top toolbar. Archidekt's CSS-module classes there are hashed and
 * change between deploys, and which button sits before "More" varies with
 * viewer permissions ("Import cards" for the owner, "Clone deck" otherwise)
 * — so this matches on the "More" button's own text instead of any class,
 * then walks up to whichever ancestor is a direct child of the toolbar row,
 * which is the actual flex sibling to insert after.
 */
function findToolbarAnchor() {
  const container = document.querySelector('[class*="primaryActions"]');
  if (!container) return null;
  const moreBtn = [...container.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === "More",
  );
  if (!moreBtn) return null;
  let node = moreBtn;
  while (node.parentElement && node.parentElement !== container) node = node.parentElement;
  return node.parentElement === container ? node : null;
}

const ARCHIDEKT_PRICE_COLUMN_HELP =
  'Habilite clicando na engrenagem em "View as" → "Enabled columns" e marcando "Price".';

/**
 * Whether Archidekt is currently rendering its Price column at all — a
 * per-viewer display toggle (View as → gear → Enabled columns → Price),
 * independent from whether LigaMagic actually has a price for any given
 * card. Read straight off the rendered rows rather than the toggle itself,
 * since that live control only exists in the DOM while its own flyout menu
 * is open.
 */
function isPriceColumnEnabled() {
  const cards = document.querySelectorAll(SEL_CARD_BUTTON);
  return cards.length === 0 || document.querySelectorAll(SEL_PRICE_LINK).length > 0;
}

// ── Card extraction ───────────────────────────────────────────────────────────
/**
 * Reads a card button's name, stripping MTG Arena's "A-" rebalance prefix
 * (see stripArenaAlchemyPrefix) — Archidekt's title attribute carries it as
 * plain text (e.g. "A-Dungeon Descent"), which would otherwise get queried
 * against LigaMagic verbatim, and LigaMagic (paper-only) never carries a
 * card under that Arena-only name.
 */
function cardNameOf(btn) {
  const raw = btn?.getAttribute("title")?.trim();
  return raw ? stripArenaAlchemyPrefix(raw) : null;
}

function extractCardNames() {
  const names = new Set();
  document.querySelectorAll(SEL_CARD_BUTTON).forEach((btn) => {
    const name = cardNameOf(btn);
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
    const name = cardNameOf(btn);
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

      const name = cardNameOf(btn);
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
    // Tooltip stays plain text (title attributes can't carry markup); the
    // visible text gets the BRL part as its own coloured span instead of
    // plain text inheriting the row's default colour.
    totalSpan.title = `${originalGroupTitle}  ·  ${formatted}`;
    totalSpan.textContent = `${originalGroupTitle}  ·  `;
    const brlSpan = document.createElement("span");
    brlSpan.style.color = "#33ac5f";
    brlSpan.textContent = formatted;
    totalSpan.appendChild(brlSpan);
  });

  log("Group totals updated.");
}

// ── Deck header total ─────────────────────────────────────────────────────────
// The "Est cost: $231,48" trigger button in the deck header — CSS-module
// class hash changes between deploys same as the card-row selectors above,
// so this matches on the stable semantic prefix. Confirmed live 2026-08-21:
// Archidekt has since redesigned this from a plain price span into a
// tooltip-trigger button ("deckPrice_trigger__...", not "deckPrice_orange__..."
// as before), which is why the old selector stopped matching anything.
const SEL_DECK_EST_COST = '[class*="deckPrice_trigger"]';
const DECK_TOTAL_BRL_CLASS = "lm-ext-deck-total-brl";

/**
 * Sums qty × priceMin for every card in the entire deck (all groups except
 * "Maybeboard") and shows it as its own green span next to Archidekt's own
 * "Est cost: $X" trigger button, the same way updateGroupTotals adds one per
 * group — appended alongside the existing content rather than overwriting
 * it, so Archidekt's own price and label stay exactly as they are.
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
      const name = cardNameOf(btn);
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

  const estCostButton = document.querySelector(SEL_DECK_EST_COST);
  if (!estCostButton) return;

  const brlDeckTotal = `R$ ${total.toFixed(2).replace(".", ",")}`;
  let brlSpan = estCostButton.querySelector(`.${DECK_TOTAL_BRL_CLASS}`);
  if (!brlSpan) {
    brlSpan = document.createElement("span");
    brlSpan.className = DECK_TOTAL_BRL_CLASS;
    Object.assign(brlSpan.style, { color: "#33ac5f", marginLeft: "6px" });
    estCostButton.appendChild(brlSpan);
  }
  brlSpan.textContent = `· ${brlDeckTotal}`;
  log(`Deck total updated: ${brlDeckTotal}`);
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

      const missingNames = names.filter((n) => !priceMap[n]);
      renderPendingPricesButton({
        missingNames,
        onDone: () => {
          // applyPrices() marks every price link PROCESSED_ATTR regardless
          // of whether a price was found, so a plain re-run would skip them
          // and never pick up the price the backfill just cached — clear
          // the marker on exactly the links whose card was missing.
          document.querySelectorAll(SEL_PRICE_LINK).forEach((linkEl) => {
            const row = linkEl.closest(SEL_CARD_ROW);
            const name = cardNameOf(row?.querySelector(SEL_CARD_BUTTON));
            if (name && missingNames.includes(name)) linkEl.removeAttribute(PROCESSED_ATTR);
          });
          run();
        },
        log,
        contextName: getViewedDeckName(),
        mountAfter: findToolbarAnchor(),
        // The toolbar row already spaces its own children with a flexbox
        // "gap" (7px, measured live) rather than per-item margins like
        // Moxfield — nothing extra to add here, it applies automatically to
        // this button too once inserted as a sibling.
        toolbarGap: "0px",
        // Matches the "More" button's own rendered height (measured live:
        // 39px) — its padding/font-size don't line up with ours closely
        // enough for padding alone to land on the same height.
        btnHeight: "39px",
        checkPriceColumnEnabled: isPriceColumnEnabled,
        priceColumnHelp: ARCHIDEKT_PRICE_COLUMN_HELP,
      });
    });
  });
}

// ── SPA observer ──────────────────────────────────────────────────────────────
// Archidekt is a React SPA. Card rows are added/removed as the user switches
// deck views. observeAndRerun debounces mutations so a burst of DOM changes
// triggers one run, and does the initial run for content already rendered.
observeAndRerun((mutations) => hasAddedNodeMatching(mutations, SEL_CARD_ROW), run);
