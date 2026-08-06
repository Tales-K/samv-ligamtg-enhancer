/**
 * Adds a "Preço" (Price) visualization tab to LigaMagic deck pages (unless
 * disabled via the "addPriceView" setting), and applies the user's
 * preferred default deck view (extension setting).
 *
 * The site pre-renders every native view (Padrão, Cor, Custo, Raridade,
 * Visual, Grid, CMC) as sibling #dk-val-N-<id> divs under #deck-view and
 * toggles their visibility via viewdeck.view() — there's no server-side
 * "sort by price" view. This builds one client-side instead: it clones the
 * card rows already present in the Padrão view (#dk-val-1-<id>), which
 * cleanly separates Mainboard / Sideboard / Maybeboard, and sorts each
 * board's cards by price (highest first) without ever mixing boards
 * together.
 *
 * Depends on: content-utils.js (log, parsePrice, waitForElement), scraper-deck.js (isDeckPage)
 */

const DECK_VIEW_TAB_IDS = [1, 2, 3, 4, 5, 6, 8]; // native LigaMagic view ids

/**
 * Reads the board sections (Mainboard / Sideboard / Maybeboard) from the
 * Padrão view (#dk-val-1-<id>), the only view that keeps them cleanly
 * separated. Returns [{ label, el }], in DOM order. Used both to build the
 * "Preço" tab and by deck-copy-button.js to build the copyable card list.
 */
function getDeckBoards(deckId) {
  const source = document.getElementById(`dk-val-1-${deckId}`);
  if (!source) return [];

  const boards = [];
  const mainBlock = source.querySelector(":scope > .pdeck-block");
  if (mainBlock) boards.push({ label: "Mainboard", el: mainBlock });

  source.querySelectorAll(":scope > hr.pdeck-maybe").forEach((hr) => {
    const boardEl = hr.nextElementSibling;
    if (!boardEl) return;
    // Only the header's own direct text node (e.g. "Maybeboard") — element
    // children like the card-count <i> or an info tooltip icon are skipped,
    // since their text (e.g. a disclaimer) isn't part of the board's name.
    const typeEl = boardEl.querySelector(".deck-type");
    const textNode = [...(typeEl?.childNodes ?? [])].find(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim(),
    );
    const label = textNode?.textContent.trim() || "Board";
    boards.push({ label, el: boardEl });
  });

  return boards;
}

/**
 * Clones the board sections (Mainboard / Sideboard / Maybeboard) from the
 * Padrão view and rebuilds them with their card rows sorted by minimum
 * price, descending. Boards are kept in separate sections — never merged.
 */
function buildPriceView(deckId) {
  const boards = getDeckBoards(deckId);
  if (boards.length === 0) return null;

  const container = document.createElement("div");
  container.id = `dk-val-price-${deckId}`;
  container.style.display = "none";

  boards.forEach((board, i) => {
    const cardRows = [...board.el.querySelectorAll(":scope > .deck-line")].filter((row) =>
      row.querySelector(".deck-box-left"),
    );
    if (cardRows.length === 0) return;

    // Sort by the minimum-price column (pdeck_preco_2_*) — the site's
    // default price metric — regardless of which price type is currently
    // toggled on screen. Cards with no price sink to the bottom.
    const priceOf = (row) => {
      const font = row.querySelector('.deck-price font[class*="pdeck_preco_2_"]');
      return parsePrice(font?.textContent);
    };
    const sorted = [...cardRows].sort((a, b) => {
      const pa = priceOf(a);
      const pb = priceOf(b);
      if (pa == null && pb == null) return 0;
      if (pa == null) return 1;
      if (pb == null) return -1;
      return pb - pa;
    });

    if (i > 0) {
      const hr = document.createElement("hr");
      hr.className = "pdeck-maybe";
      container.appendChild(hr);
    }

    const wrap = document.createElement("div");
    if (i === 0) wrap.className = "pdeck-block";

    const headerRow = document.createElement("div");
    headerRow.className = "deck-line";
    const headerType = document.createElement("div");
    headerType.className = "deck-type deck-type-first";
    headerType.textContent = `${board.label} (${sorted.length})`;
    headerRow.appendChild(headerType);
    wrap.appendChild(headerRow);

    sorted.forEach((row) => wrap.appendChild(row.cloneNode(true)));
    container.appendChild(wrap);
  });

  return container;
}

function selectPriceView(deckId) {
  DECK_VIEW_TAB_IDS.forEach((i) => {
    document.getElementById(`dk-val-${i}-${deckId}`)?.style.setProperty("display", "none");
    document.getElementById(`dk-tab-${i}-${deckId}`)?.classList.remove("tab-selected");
  });
  const view = document.getElementById(`dk-val-price-${deckId}`);
  const tab = document.getElementById(`dk-tab-price-${deckId}`);
  if (view) view.style.display = "";
  tab?.classList.add("tab-selected");
}

/**
 * The card-name hover tooltip (image preview) is powered by the page's own
 * `stickytooltip` library, which only binds to `[data-tooltip]` elements
 * that existed when it was last (re-)initialized. The site itself re-runs
 * this after AJAX-loading a view; our cloned rows need the same treatment,
 * since cloneNode() never carries over the original's event bindings.
 *
 * Content scripts run in an isolated JS world and can't call the page's
 * `stickytooltip`/`viewdeck` globals directly. Injecting a literal <script>
 * tag from here to bridge into the page's world proved unreliable in
 * testing (the DOM showed the tag present but its code never actually ran),
 * so this instead asks the background service worker to run it via
 * chrome.scripting.executeScript({ world: "MAIN" }) — the supported API for
 * this, but one only the background worker is privileged to call.
 */
function reinitPageTooltips() {
  chrome.runtime.sendMessage({ action: "reinitTooltips" });
}

/**
 * Builds the price view + tab and inserts them next to the native ones.
 * Returns true once the tab is present (injected now or already there),
 * false if the page isn't ready yet.
 */
function injectPriceTab(deckId) {
  if (document.getElementById(`dk-tab-price-${deckId}`)) return true;

  const tabBar = document.getElementById("deck-tab");
  const viewContainer = document.getElementById("deck-view");
  if (!tabBar || !viewContainer) return false;

  const view = buildPriceView(deckId);
  if (!view) return false;

  // Insert right after the last native dk-val-N div, in DOM order, rather
  // than appending at the very end of #deck-view — some boards (e.g.
  // Maybeboard) have their own trailing native disclaimer/footnote content
  // that lives after all the dk-val-N divs; appending at the very end would
  // push our view after that footnote, making it appear to "jump" above our
  // card list instead of staying below it like it does in the native views.
  const nativeViews = [...viewContainer.querySelectorAll('[id^="dk-val-"]')].filter((el) =>
    el.id.endsWith(`-${deckId}`),
  );
  const lastNativeView = nativeViews[nativeViews.length - 1];
  if (lastNativeView) lastNativeView.insertAdjacentElement("afterend", view);
  else viewContainer.appendChild(view);

  reinitPageTooltips();

  const tab = document.createElement("div");
  tab.id = `dk-tab-price-${deckId}`;
  tab.textContent = "Preço";
  tab.addEventListener("click", () => selectPriceView(deckId));

  // Listed right after Padrão, before Cor.
  const padraoTab = document.getElementById(`dk-tab-1-${deckId}`);
  const buyBtn = tabBar.querySelector(".tab-comprar");
  if (padraoTab) padraoTab.insertAdjacentElement("afterend", tab);
  else if (buyBtn) buyBtn.insertAdjacentElement("beforebegin", tab);
  else tabBar.appendChild(tab);

  // Native tabs know nothing about our custom view — make sure clicking
  // any of them hides it too, so the two never show up at the same time.
  DECK_VIEW_TAB_IDS.forEach((i) => {
    document.getElementById(`dk-tab-${i}-${deckId}`)?.addEventListener("click", () => {
      document.getElementById(`dk-val-price-${deckId}`)?.style.setProperty("display", "none");
      tab.classList.remove("tab-selected");
    });
  });

  log('Injected "Preço" tab into deck view.');
  return true;
}

/**
 * Applies the extension's "default deck view" setting, if configured.
 * An empty value means "don't override — keep LigaMagic's own default".
 */
function applyDefaultDeckView(deckId, view) {
  if (!view) return;
  if (view === "price") {
    if (!document.getElementById(`dk-tab-price-${deckId}`)?.classList.contains("tab-selected")) {
      selectPriceView(deckId);
    }
    return;
  }
  const tab = document.getElementById(`dk-tab-${view}-${deckId}`);
  if (tab && !tab.classList.contains("tab-selected")) tab.click();
}

function initDeckView() {
  if (typeof isDeckPage !== "function" || !isDeckPage()) return;
  const deckId = new URLSearchParams(location.search).get("id");
  if (!deckId) return;

  waitForElement(() => {
    if (!document.getElementById(`dk-val-1-${deckId}`)) return false;
    if (!document.getElementById("deck-tab") || !document.getElementById("deck-view")) return false;

    chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
      if (settings?.addPriceView !== false) injectPriceTab(deckId);
      applyDefaultDeckView(deckId, settings?.defaultDeckView);
    });
    return true;
  });
}

initDeckView();
