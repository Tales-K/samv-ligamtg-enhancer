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
 *   4. Re-run automatically if new card blocks are injected into the DOM.
 *
 * Depends on: overlay-utils.js (log factory, priceColor, fmtBRL, logPriceMap,
 * queryPrices, observeAndRerun, hasAddedNodeMatching) — shared with the
 * Archidekt/Moxfield overlays. Does NOT depend on content-utils.js (different
 * host, separate injection).
 */

const log = createLogger("Scryfall");

// ── Constants ─────────────────────────────────────────────────────────────────
// Each card result (search page) or the card panel (card page) is wrapped in
// a div.inner-flex.  The card name lives inside .card-text-card-name.
const SEL_CARD_BLOCK = "div.inner-flex";
const SEL_CARD_NAME = ".card-text-card-name";
const SEL_PRINTS_TABLE = "table.prints-table";

// data-attribute set on card blocks we have already processed.
const PROCESSED_ATTR = "data-lm-scryfall-processed";

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
function extractCardNames() {
  const names = new Set();
  document.querySelectorAll(SEL_CARD_BLOCK).forEach((block) => {
    if (block.hasAttribute(PROCESSED_ATTR)) return;
    const nameEl = block.querySelector(SEL_CARD_NAME);
    const name = nameEl?.textContent?.trim();
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
 */
function applyPrices(priceMap, openLigaMagicOnClick = true) {
  let processed = 0;

  document.querySelectorAll(SEL_CARD_BLOCK).forEach((block) => {
    if (block.hasAttribute(PROCESSED_ATTR)) return;

    const nameEl = block.querySelector(SEL_CARD_NAME);
    const name = nameEl?.textContent?.trim();
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

    const color = priceColor(info?.updatedAt);
    const label = fmtBRL(info?.priceMin ?? null);
    const url = LIGAMAGIC_BASE + encodeURIComponent(name);
    const tooltip = info
      ? `LigaMagic — atualizado em ${new Date(info.updatedAt).toLocaleDateString("pt-BR")}`
      : "Price not found in LigaMagic DB";

    // ── Add R$ header column ──────────────────────────────────────────────────
    const headerRow = priceTable.querySelector("thead tr");
    if (headerRow) {
      const th = document.createElement("th");
      const span = document.createElement("span");
      span.textContent = "R$";
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
          `color: ${color}`,
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
          `color: ${color}`,
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
// ── Main run ──────────────────────────────────────────────────────────────────
function run() {
  chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
    if (chrome.runtime.lastError) {
      log("Could not read settings:", chrome.runtime.lastError.message);
      return;
    }
    if (settings?.overlayScryfall === false) {
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
    });
  });
}

// ── Observer ──────────────────────────────────────────────────────────────────
// Scryfall is largely server-rendered; observe for any dynamically injected
// card blocks (e.g. tooltip previews or lazy-loaded results).
observeAndRerun((mutations) => hasAddedNodeMatching(mutations, SEL_CARD_BLOCK), run);
