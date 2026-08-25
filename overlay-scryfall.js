/**
 * Scryfall price overlay — adds a BRL price column from LigaMagic to the
 * prints table on search results (full view) and individual card pages.
 *
 * Works on:
 *   - https://scryfall.com/search?...&as=full  (multiple cards per page)
 *   - https://scryfall.com/card/...             (single card page)
 *
 * Flow:
 *   1. Collect all unique card names from every div.inner-flex on the page.
 *   2. Ask the background worker for locally cached prices (chrome.storage.local).
 *   3. For each card block, find the prints table with USD/EUR/TIX columns and
 *      inject a new "R$" header + one BRL cell per row (same price for all prints).
 *   4. Show a floating "Carregar preços pendentes" button when some cards came
 *      back with no cached price (see renderPendingPricesButton).
 *   5. On an individual card page, add a "Comprar no LigaMagic" entry to
 *      Scryfall's own "Buy This Card" panel (see injectBuyButton).
 *   6. Re-run automatically if new card blocks are injected into the DOM.
 *
 * Depends on: overlay-utils.js (log factory, priceColor, fmtBRL, logPriceMap,
 * queryPrices, observeAndRerun, hasAddedNodeMatching) — shared with the
 * Archidekt/Moxfield overlays. Does NOT depend on content-utils.js (different
 * host, separate injection).
 */

const log = createLogger("Scryfall");

// ── Constants ─────────────────────────────────────────────────────────────────
// Each card result (search page) or the card panel (card page) is wrapped in
// a div.card-profile > div.inner-flex. The card name lives inside
// .card-text-card-name. "inner-flex" alone isn't enough to scope to — it's a
// generic layout class Scryfall reuses for at least two unrelated sections on
// an individual card page (the Toolbox panel and the page footer), both of
// which also matched a bare "div.inner-flex" and were silently iterated as if
// they were card blocks (confirmed live via logNotShown firing for both,
// since neither has a div.prints inside) — scoping to the actual
// "card-profile" parent every real card block shares (and neither of those
// two sections do) excludes them structurally instead of relying on every
// downstream lookup's own null-check to no-op on the wrong element.
const SEL_CARD_BLOCK = "div.card-profile > div.inner-flex";
const SEL_CARD_NAME = ".card-text-card-name";
const SEL_PRINTS_TABLE = "table.prints-table";

// data-attribute set on card blocks we have already processed.
const PROCESSED_ATTR = "data-lm-scryfall-processed";
// MTG Arena's "Rebalanced for Alchemy" stamp — Scryfall renders it as this
// distinct element right next to (on a single card page) or inside (on a
// search-results block) the card's name. Excluded when reading the name (see
// cardNameOf) since Arena-rebalanced cards have no paper printing, so
// LigaMagic never carries one under a name that includes it.
const SEL_ARENA_STAMP = ".card-text-title-arena-stamp";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true if this prints-table is the prices table (has a USD column),
 * as opposed to the "Faces, Tokens & Other Parts" table.
 */
function isPriceTable(table) {
  return [...table.querySelectorAll("thead th")].some((th) =>
    th.textContent.includes("USD"),
  );
}

// ── Card extraction ───────────────────────────────────────────────────────────
/**
 * Reads a card block's name straight from its own name element, excluding
 * the Arena stamp (see SEL_ARENA_STAMP) if it happens to be nested inside
 * that element — confirmed live: on a search-results block it's a child of
 * .card-text-card-name (so plain textContent would include "A-"); on an
 * individual card page it's a sibling instead (so it was never in nameEl's
 * textContent to begin with). Cloning + removing it handles both cases
 * uniformly without guessing at the name's own text.
 */
function cardNameOf(nameEl) {
  if (!nameEl) return null;
  const clone = nameEl.cloneNode(true);
  clone.querySelectorAll(SEL_ARENA_STAMP).forEach((el) => el.remove());
  const name = clone.textContent.trim();
  return name || null;
}

function extractCardNames() {
  const names = new Set();
  document.querySelectorAll(SEL_CARD_BLOCK).forEach((block) => {
    if (block.hasAttribute(PROCESSED_ATTR)) return;
    const name = cardNameOf(block.querySelector(SEL_CARD_NAME));
    if (name) names.add(name);
  });
  return [...names];
}

// ── Price overlay ─────────────────────────────────────────────────────────────
/**
 * For each unprocessed card block finds the prints-table with USD column and
 * injects an extra "R$" header + one BRL cell per tbody row.
 *
 * The same LigaMagic price is shown on every print row because we look up by
 * card name only (not per-print version).
 *
 * @param {Record<string, {priceMin: number|null, updatedAt: string}>} priceMap
 * @param {boolean} [openLigaMagicOnClick]
 * @param {Iterable<Element>} [blocks] card blocks to process — defaults to
 *   every unprocessed block on the page (the normal automatic run). Pass an
 *   explicit subset (e.g. a single block) for an on-demand, per-card fetch
 *   (see loadPriceForBlock) so it doesn't also stamp every other still-
 *   unprocessed block on the page as "no price" for a name it was never
 *   actually queried for.
 */
function applyPrices(priceMap, openLigaMagicOnClick = true, blocks = document.querySelectorAll(SEL_CARD_BLOCK)) {
  let processed = 0;

  blocks.forEach((block) => {
    if (block.hasAttribute(PROCESSED_ATTR)) return;

    const name = cardNameOf(block.querySelector(SEL_CARD_NAME));
    if (!name) return;

    const info = priceMap[name] ?? null;

    // Find the prints table that has USD/EUR/TIX price columns.
    let priceTable = null;
    for (const t of block.querySelectorAll(SEL_PRINTS_TABLE)) {
      if (isPriceTable(t)) {
        priceTable = t;
        break;
      }
    }
    if (!priceTable) return;

    const label = fmtBRL(info?.priceMin ?? null);
    const url = LIGAMAGIC_BASE + encodeURIComponent(name);
    const tooltip = info
      ? `LigaMagic — atualizado em ${new Date(info.updatedAt).toLocaleDateString("pt-BR")}`
      : "Price not found in LigaMagic DB";

    // ── Add R$ header column ──────────────────────────────────────────────────
    // Purple background with white text — brand-identity treatment, same
    // purple as the rest of the extension's injected UI (SAMV_PURPLE). The
    // !important pair is required: Scryfall's own prints-table CSS applies
    // striping/hover backgrounds and a text color to th/td that would
    // otherwise win the cascade over a plain inline style.
    const headerRow = priceTable.querySelector("thead tr");
    if (headerRow) {
      const th = document.createElement("th");
      th.style.setProperty("background-color", SAMV_PURPLE, "important");
      th.style.setProperty("color", "#ffffff", "important");
      const span = document.createElement("span");
      span.textContent = "R$";
      span.style.setProperty("color", "#ffffff", "important");
      th.appendChild(span);
      headerRow.appendChild(th);
    }

    // ── Add R$ cell to each body row ──────────────────────────────────────────
    priceTable.querySelectorAll("tbody tr").forEach((row) => {
      // "View all prints →" row uses a single td[colspan] — expand it instead
      // of adding an extra cell so the row still spans correctly.
      const colspanTd = row.querySelector("td[colspan]");
      if (colspanTd) {
        const current = parseInt(colspanTd.getAttribute("colspan") || "1", 10);
        colspanTd.setAttribute("colspan", String(current + 1));
        return;
      }

      const td = document.createElement("td");
      // Same purple-background treatment as the header — !important so
      // Scryfall's own row striping/hover CSS can't win. The link text
      // used to be colored by priceColor() (green/yellow/red for price
      // freshness); against this purple, all three of those read at very
      // low contrast (~1.2–2.7:1, checked against WCAG contrast math —
      // well under the 4.5:1 floor for normal text), so freshness is no
      // longer encoded in color here. It's still available on hover via
      // the tooltip below.
      td.style.setProperty("background-color", SAMV_PURPLE, "important");
      td.style.setProperty("color", SAMV_PURPLE_TEXT, "important");

      if (info?.priceMin != null) {
        const a = document.createElement("a");
        if (openLigaMagicOnClick) {
          a.href = url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
        }
        a.title = tooltip;
        a.textContent = label;
        a.style.cssText = [
          `color: ${SAMV_PURPLE_TEXT} !important`,
          "text-decoration: none",
          openLigaMagicOnClick ? "cursor: pointer" : "cursor: default",
          "transition: opacity 0.15s",
        ].join("; ");
        a.onmouseenter = () => {
          a.style.opacity = "0.75";
        };
        a.onmouseleave = () => {
          a.style.opacity = "1";
        };
        td.appendChild(a);
      } else {
        const a = document.createElement("a");
        if (openLigaMagicOnClick) {
          a.href = url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.title = "Sem preço no LigaMagic — clique para abrir a página do card";
        } else {
          a.title = "Sem preço no LigaMagic";
        }
        a.textContent = label;
        a.style.cssText = [
          `color: ${SAMV_PURPLE_TEXT} !important`,
          "text-decoration: none",
          openLigaMagicOnClick ? "cursor: pointer" : "cursor: default",
          "transition: opacity 0.15s",
        ].join("; ");
        a.onmouseenter = () => {
          a.style.opacity = "0.75";
        };
        a.onmouseleave = () => {
          a.style.opacity = "1";
        };
        td.appendChild(a);
      }

      row.appendChild(td);
    });

    block.setAttribute(PROCESSED_ATTR, "1");
    processed++;
  });

  if (processed > 0) log(`Processed ${processed} card block(s).`);
}

/** True once the R$ price column has been added to this card block (see applyPrices). */
function hasPriceColumn(block) {
  return block.hasAttribute(PROCESSED_ATTR);
}

/**
 * Fetches and applies the R$ price for a single card block on demand —
 * called by the "Carregar Preço" button (overlay-scryfall-tags.js) shown
 * next to "Carregar Tags" for blocks the automatic run() below hasn't
 * populated yet (most commonly because the price-column setting is off, or
 * for a layout the automatic pass hasn't reached). Reuses the same
 * queryPrices/applyPrices path run() itself uses, just scoped to one block
 * so it doesn't also mark every other still-unprocessed block on the page
 * as "no price" for a name that was never actually queried for them.
 *
 * @param {Element} block
 * @param {(ok: boolean) => void} [onDone]
 */
function loadPriceForBlock(block, onDone) {
  const name = cardNameOf(block.querySelector(SEL_CARD_NAME));
  if (!name) {
    onDone?.(false);
    return;
  }

  chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
    if (chrome.runtime.lastError) {
      log("Could not read settings:", chrome.runtime.lastError.message);
      onDone?.(false);
      return;
    }
    const openLigaMagicOnClick = settings?.openLigaMagicOnClick ?? true;
    queryPrices(log, [name], (priceMap) => {
      applyPrices(priceMap, openLigaMagicOnClick, [block]);
      onDone?.(true);
    });
  });
}

// ── "Buy This Card" panel button ────────────────────────────────────────────
// Scryfall's own panel of purchase links (TCGplayer/Cardmarket/Cardhoarder),
// present only on an individual card page — a search-results page lists many
// cards and this panel's id wouldn't be unique per card, so Scryfall only
// renders it there. Confirmed live: absent entirely on ?as=full results.
const SEL_STORES_LIST = "#stores ul.toolbox-links";
const BUY_LIGAMAGIC_ID = "lm-ext-buy-ligamagic";

/**
 * Adds a "Comprar no LigaMagic" entry to that panel, styled purple like
 * every other control this extension injects (so it still reads as ours
 * sitting among Scryfall's own native buy buttons) but structured as the
 * same <li><a class="button-n"><i>label</i></a></li> those use, so it takes
 * the list's own spacing/layout rather than needing its own.
 */
function injectBuyButton(name) {
  if (document.getElementById(BUY_LIGAMAGIC_ID)) return;
  const list = document.querySelector(SEL_STORES_LIST);
  if (!list) {
    // The caller already checked this exists right before calling in — a
    // miss here means it disappeared between that check and now, not the
    // routine "no Buy This Card panel on this page" case, so it's worth a
    // trace.
    logNotShown("Scryfall", "Comprar no LigaMagic", `elemento "${SEL_STORES_LIST}" não encontrado`);
    return;
  }

  const a = document.createElement("a");
  a.id = BUY_LIGAMAGIC_ID;
  a.className = "button-n";
  a.href = LIGAMAGIC_BASE + encodeURIComponent(name);
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  const label = document.createElement("i");
  label.textContent = "Comprar no LigaMagic";
  a.appendChild(label);
  applySamvButtonStyle(a);

  const li = document.createElement("li");
  li.appendChild(a);
  list.insertBefore(li, list.firstChild);
}

/**
 * Waits briefly for Scryfall's own filter-controls wrapper — injected by
 * overlay-scryfall-filter.js off its own independent getSettings round trip,
 * and holding both the "Filtro padrão" button and the gear button that
 * configures it — so the pending-prices button can anchor right after it in
 * the header row instead of racing it into the floating fallback. Without
 * this wait, run() below (scheduled first per manifest order, same 600ms
 * debounce) fires reliably *before* that wrapper exists on a fresh load, and
 * the wrapper's mount point is decided once and never moved afterward.
 *
 * Anchoring to the wrapper as a whole (rather than to either button inside
 * it) keeps the header row's order deterministic — Filtro padrão →
 * engrenagem → Carregar preços pendentes — and keeps this independent of
 * how overlay-scryfall-filter.js lays that pair out internally.
 *
 * Falls back to floating (mountAfter: null) if the wrapper never shows up
 * (feature disabled), same as before this existed.
 */
function waitForFilterControls(callback, deadline = Date.now() + 2000) {
  const existing = typeof FILTER_WRAPPER_ID !== "undefined" ? document.getElementById(FILTER_WRAPPER_ID) : null;
  if (existing || Date.now() >= deadline) {
    callback(existing);
    return;
  }
  setTimeout(() => waitForFilterControls(callback, deadline), 100);
}

// ── Main run ──────────────────────────────────────────────────────────────────
function run() {
  chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
    if (chrome.runtime.lastError) {
      logNotShown("Scryfall", "coluna R$ / Carregar preços pendentes / Comprar no LigaMagic", `erro ao ler configurações — ${chrome.runtime.lastError.message}`);
      return;
    }
    if (settings?.overlayScryfall === false) {
      logNotShown("Scryfall", "coluna R$ / Carregar preços pendentes / Comprar no LigaMagic", "desabilitado nas configurações (overlayScryfall = false)");
      return;
    }
    const openLigaMagicOnClick = settings?.openLigaMagicOnClick ?? true;

    // Independent of the missing-price flow below (and of extractCardNames'
    // PROCESSED_ATTR filtering) so it still runs on a later debounced re-run
    // even once the page's one card block is already processed.
    if (document.querySelector(SEL_STORES_LIST)) {
      const name = cardNameOf(document.querySelector(SEL_CARD_BLOCK)?.querySelector(SEL_CARD_NAME));
      if (name) {
        injectBuyButton(name);
      } else {
        logNotShown("Scryfall", "Comprar no LigaMagic", "não foi possível extrair o nome da carta (cardNameOf retornou vazio)");
      }
    }

    const names = extractCardNames();
    if (names.length === 0) return;
    log(`Found ${names.length} unique card(s) — querying BRL prices…`);

    queryPrices(log, names, (priceMap) => {
      const found = Object.keys(priceMap).length;
      log(`Prices received: ${found}/${names.length}`);
      logPriceMap(log, priceMap, names);
      applyPrices(priceMap, openLigaMagicOnClick);

      const missingNames = names.filter((n) => !priceMap[n]);
      waitForFilterControls((filterControls) => {
        renderPendingPricesButton({
          missingNames,
          onDone: () => {
            // applyPrices() marks every block PROCESSED_ATTR regardless of
            // whether a price was found, so a plain re-run would skip these
            // blocks and never pick up the price the backfill just cached —
            // clear the marker on exactly the ones that were missing.
            document.querySelectorAll(SEL_CARD_BLOCK).forEach((block) => {
              const name = cardNameOf(block.querySelector(SEL_CARD_NAME));
              if (name && missingNames.includes(name)) block.removeAttribute(PROCESSED_ATTR);
            });
            run();
          },
          log,
          siteName: "Scryfall",
          mountAfter: filterControls,
          // Same 8px the filter controls wrapper uses for its own left
          // margin — reads as one more control in that row rather than a
          // mismatched extra.
          toolbarGap: "8px",
          // Filtro padrão uses 5px vertical padding (26px tall); matching
          // that here instead of this button's own default 8px keeps both
          // controls the same height in the same row.
          btnPadding: "5px 14px",
          // Same 4px Filtro padrão uses — this button's own default (6px)
          // read as a visibly different control sitting right next to it.
          btnBorderRadius: "4px",
        });
      });
    });
  });
}

// ── Observer ──────────────────────────────────────────────────────────────────
// Scryfall is largely server-rendered; observe for any dynamically injected
// card blocks (e.g. tooltip previews or lazy-loaded results).
observeAndRerun((mutations) => hasAddedNodeMatching(mutations, SEL_CARD_BLOCK), run);
