/**
 * Adds controls to Scryfall's header for a saved default filter
 * (settings.scryfallDefaultFilter, e.g. "sort:edhrec"):
 *   - "Filtro padrão": appends the filter to whatever is already in the
 *     search field, without submitting -- so it can be reused across
 *     searches without retyping it.
 *   - A gear button next to it, opening a small floating panel to edit the
 *     filter value right from Scryfall instead of only via the extension
 *     popup.
 *
 * Both are rendered purely off the feature's own setting
 * (addScryfallFilterButton), never off whether a filter value happens to be
 * saved: the pair is a fixed part of the header row whenever the feature is
 * on, so it doesn't appear and disappear under the user as the value is set
 * or cleared. With no value saved yet, "Filtro padrão" has nothing to
 * append, so it opens the gear's own panel instead of silently doing
 * nothing (see buildFilterButton).
 *
 * Both controls live in one wrapper div, so overlay-scryfall.js's
 * "Carregar preços pendentes" button (see waitForFilterControls there) has a
 * single, deterministic anchor to mount after.
 *
 * Depends on: overlay-utils.js (createLogger, applySamvButtonStyle,
 * applySamvPurple constants, observeAndRerun, hasAddedNodeMatching)
 */

const filterLog = createLogger("Scryfall Filter");

const SEL_HEADER_ROW = "div.header-control-row";
const SEL_FILTER_SEARCH_FIELD = "#header-search-field";
const FILTER_WRAPPER_ID = "lm-ext-scryfall-filter-wrapper";
const FILTER_BUTTON_ID = "lm-ext-scryfall-filter-btn";
const FILTER_GEAR_BUTTON_ID = "lm-ext-scryfall-filter-gear-btn";
const FILTER_PANEL_ID = "lm-ext-scryfall-filter-panel";
const FILTER_PANEL_INPUT_ID = "lm-ext-scryfall-filter-panel-input";
// "Filtro padrão"'s own natural rendered height (5px 10px padding, 13px
// font, no line-height set) -- measured live. The gear button matches this
// explicitly instead of relying on its own padding/line-height to land on
// the same number by coincidence (see buildFilterButton/buildGearButton).
const FILTER_BUTTON_HEIGHT = "26px";

// Last known value of settings.scryfallDefaultFilter. Read by the "Filtro
// padrão" button's own click handler as a live closure over this variable
// (not a value baked in at button-creation time), so a value saved from the
// gear panel -- or pushed down from the popup via the settingsChanged
// listener below -- takes effect on the very next click, no page reload
// needed.
let currentFilter = "";

/**
 * Appends only the terms that aren't already in the field, so clicking twice
 * doesn't produce "sort:edhrec sort:edhrec". Comparison is whitespace-based
 * on whole terms -- Scryfall's own syntax is space-separated.
 */
function appendFilterTerms(field, filter) {
  const existing = field.value.trim().split(/\s+/).filter(Boolean);
  const missing = filter.split(/\s+/).filter((term) => term && !existing.includes(term));
  if (missing.length === 0) return false;

  field.value = [...existing, ...missing].join(" ");
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.focus();
  field.setSelectionRange(field.value.length, field.value.length);
  return true;
}

/** Tooltip for the "Filtro padrão" button, which also has to describe the
 * no-value-saved case now that the button renders in it too. */
function filterButtonTitle() {
  return currentFilter
    ? `Acrescenta "${currentFilter}" à busca`
    : "Nenhum filtro padrão definido — clique para configurar";
}

function buildFilterButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.id = FILTER_BUTTON_ID;
  button.textContent = "Filtro padrão";
  button.title = filterButtonTitle();
  Object.assign(button.style, {
    // border-box + an explicit height, matched below on the gear button, so
    // the pair renders the same height instead of the ~3px mismatch that
    // came from this button's natural (no line-height set) height differing
    // from the gear button's own line-height: 1.
    boxSizing: "border-box",
    height: FILTER_BUTTON_HEIGHT,
    display: "inline-flex",
    alignItems: "center",
    padding: "0 10px",
    border: "none",
    // Square on the right so it reads as one piece with the gear button
    // right after it (see buildWrapper's own comment) instead of two
    // separate buttons with a gap between them.
    borderRadius: "4px 0 0 4px",
    fontSize: "13px",
    fontWeight: "700",
    fontFamily: "inherit",
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: "0",
  });
  applySamvButtonStyle(button);

  button.addEventListener("click", () => {
    // Nothing configured to append yet — send the user straight to the
    // control that sets it, rather than having the click appear to do
    // nothing at all (appendFilterTerms with an empty filter is a no-op).
    if (!currentFilter) {
      const gearButton = document.getElementById(FILTER_GEAR_BUTTON_ID);
      if (gearButton) showFilterPanel(gearButton);
      return;
    }
    const field = document.querySelector(SEL_FILTER_SEARCH_FIELD);
    if (field) appendFilterTerms(field, currentFilter);
  });
  return button;
}

/**
 * Refreshes the "Filtro padrão" button's tooltip to match currentFilter --
 * called after any live update (gear panel save, or a settingsChanged push
 * from the popup). Only the tooltip needs refreshing: the button is a fixed
 * fixture whenever the feature is enabled, and its click handler reads
 * currentFilter fresh on every click rather than closing over the value it
 * was built with.
 */
function updateFilterButtonTitle() {
  const button = document.getElementById(FILTER_BUTTON_ID);
  if (button) button.title = filterButtonTitle();
}

// ── Gear button + floating settings panel ───────────────────────────────────
// Scryfall's own toolbar row (div.header-control-row) sets `overflow:
// hidden`, so a panel nested inside it -- even with a very high z-index --
// gets clipped and never paints; clipping isn't a stacking-order problem, so
// z-index can't fix it. The same issue and the same fix are already
// documented in overlay-utils.js for the pending-prices completion message
// (see createPendingPricesWrapper/getOrCreatePendingPricesMessage there):
// append the panel straight to <body>, position it "fixed", and compute its
// coordinates from the trigger button's own live getBoundingClientRect() at
// show time, instead of nesting it under the clipped ancestor at all.

function buildGearButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.id = FILTER_GEAR_BUTTON_ID;
  button.textContent = "⚙";
  button.title = "Configurar filtro padrão do Scryfall";
  Object.assign(button.style, {
    // Same height as the filter button (see FILTER_BUTTON_HEIGHT) instead of
    // this button's own padding/line-height landing on a different number —
    // that ~3px mismatch was the "sunken gear" look.
    boxSizing: "border-box",
    height: FILTER_BUTTON_HEIGHT,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0 8px",
    // Square on the left, against the filter button right before it — plus
    // an inner divider (below) — so the pair reads as one control split in
    // two, not two separate buttons.
    borderLeft: "1px solid rgba(255, 255, 255, 0.35)",
    borderTop: "none",
    borderRight: "none",
    borderBottom: "none",
    borderRadius: "0 4px 4px 0",
    fontSize: "13px",
    fontWeight: "700",
    fontFamily: "inherit",
    lineHeight: "1",
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: "0",
  });
  applySamvButtonStyle(button);
  // applySamvButtonStyle sets border-color (all four sides) with !important
  // on paint, on hover, and on mouseleave (see overlay-utils.js) — silently
  // overwriting the divider above with solid purple every time. Reasserted
  // with the same !important priority after each of those so it survives
  // both an initial paint and hovering either button.
  const keepDivider = () => button.style.setProperty("border-left-color", "rgba(255, 255, 255, 0.35)", "important");
  button.addEventListener("mouseenter", keepDivider);
  button.addEventListener("mouseleave", keepDivider);
  keepDivider();

  button.addEventListener("click", () => toggleFilterPanel(button));
  return button;
}

/** Singleton, same pattern as getOrCreatePendingPricesMessage in overlay-utils.js: created once on first use and reused across re-renders instead of piling up detached copies under <body>. */
function getOrCreateFilterPanel() {
  let panel = document.getElementById(FILTER_PANEL_ID);
  if (panel) return panel;

  panel = document.createElement("div");
  panel.id = FILTER_PANEL_ID;
  Object.assign(panel.style, {
    display: "none",
    position: "fixed",
    zIndex: "999999",
    background: "#1a1a2e",
    border: "1px solid #2d2d4e",
    boxShadow: "0 2px 10px rgba(0, 0, 0, 0.35)",
    borderRadius: "8px",
    padding: "10px 12px",
    fontFamily: "inherit",
    minWidth: "220px",
  });

  const label = document.createElement("label");
  label.htmlFor = FILTER_PANEL_INPUT_ID;
  label.textContent = "Filtro padrão do Scryfall";
  Object.assign(label.style, {
    display: "block",
    fontSize: "11px",
    fontWeight: "700",
    color: "#c4b5fd",
    marginBottom: "6px",
  });
  panel.appendChild(label);

  const input = document.createElement("input");
  input.type = "text";
  input.id = FILTER_PANEL_INPUT_ID;
  input.placeholder = "sort:edhrec";
  input.spellcheck = false;
  Object.assign(input.style, {
    display: "block",
    width: "100%",
    boxSizing: "border-box",
    background: "#0f1830",
    color: "#e0e0e0",
    border: "1px solid #2d2d4e",
    borderRadius: "6px",
    padding: "5px 8px",
    fontSize: "12px",
    fontFamily: "inherit",
    marginBottom: "8px",
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveFilterPanel(input.value);
    } else if (event.key === "Escape") {
      hideFilterPanel();
    }
  });
  panel.appendChild(input);

  const actionsRow = document.createElement("div");
  Object.assign(actionsRow.style, { display: "flex", justifyContent: "flex-end" });

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.textContent = "Salvar";
  Object.assign(saveButton.style, {
    padding: "5px 12px",
    border: "none",
    borderRadius: "4px",
    fontSize: "12px",
    fontWeight: "700",
    fontFamily: "inherit",
    cursor: "pointer",
  });
  applySamvButtonStyle(saveButton);
  saveButton.addEventListener("click", () => saveFilterPanel(input.value));
  actionsRow.appendChild(saveButton);
  panel.appendChild(actionsRow);

  document.body.appendChild(panel);

  // Dismiss on click-away, mirroring the same guard on
  // getOrCreatePendingPricesMessage in overlay-utils.js: ignores clicks on
  // the panel itself and on either control that can open it, so this
  // listener doesn't immediately close a panel the same click just opened.
  //
  // That last part is not theoretical: this listener is registered lazily,
  // the first time the panel is built, which happens *during* the click
  // that opens it -- and a listener added to document while an event is
  // still bubbling toward it does receive that event. So the opening click
  // reaches this handler every time on first use. Both openers therefore
  // have to be exempt, not just the gear: with only the gear listed,
  // opening the panel from the "Filtro padrão" button (which it does when
  // no filter is configured yet, see buildFilterButton) showed the panel
  // and hid it again within the same click, leaving it measurably 0x0.
  document.addEventListener("click", (event) => {
    if (panel.style.display === "none") return;
    if (event.target === panel || panel.contains(event.target)) return;
    if (event.target.id === FILTER_GEAR_BUTTON_ID || event.target.id === FILTER_BUTTON_ID) return;
    hideFilterPanel();
  });

  return panel;
}

/** Positions the (viewport-fixed) panel right under the gear button, right-aligned to it -- same math as positionPendingPricesMessage in overlay-utils.js. */
function positionFilterPanel(panel, gearButton) {
  const rect = gearButton.getBoundingClientRect();
  panel.style.top = `${rect.bottom + 4}px`;
  panel.style.right = `${window.innerWidth - rect.right}px`;
  panel.style.left = "auto";
}

function showFilterPanel(gearButton) {
  const panel = getOrCreateFilterPanel();
  const input = document.getElementById(FILTER_PANEL_INPUT_ID);
  input.value = currentFilter;
  positionFilterPanel(panel, gearButton);
  panel.style.display = "block";
  input.focus();
  input.select();
}

function hideFilterPanel() {
  const panel = document.getElementById(FILTER_PANEL_ID);
  if (panel) panel.style.display = "none";
}

function toggleFilterPanel(gearButton) {
  const panel = document.getElementById(FILTER_PANEL_ID);
  if (panel && panel.style.display !== "none") {
    hideFilterPanel();
  } else {
    showFilterPanel(gearButton);
  }
}

function saveFilterPanel(rawValue) {
  const value = rawValue.trim();
  chrome.runtime.sendMessage({ action: "saveSettings", settings: { scryfallDefaultFilter: value } }, () => {
    if (chrome.runtime.lastError) {
      filterLog("Could not save default filter:", chrome.runtime.lastError.message);
      return;
    }
    currentFilter = value;
    updateFilterButtonTitle();
    hideFilterPanel();
  });
}

// Applies a value change pushed from the popup live -- see saveSettings in
// background.js, which always includes the account's current showDebugLogs
// alongside scryfallDefaultFilter whenever either changes (never just the
// latter alone), so this listener firing never has to guess at a value it
// wasn't told. Keeps this page in sync with a popup edit without needing a
// reload, the same way a gear-panel save already does locally.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action !== "settingsChanged" || !("scryfallDefaultFilter" in msg)) return;
  currentFilter = (msg.scryfallDefaultFilter ?? "").trim();
  updateFilterButtonTitle();
});

// ── Injection ────────────────────────────────────────────────────────────────
function buildWrapper() {
  const wrapper = document.createElement("div");
  wrapper.id = FILTER_WRAPPER_ID;
  Object.assign(wrapper.style, {
    display: "flex",
    alignItems: "center",
    // No gap between the two buttons -- they're meant to read as one split
    // control (see buildFilterButton/buildGearButton's own border-radius/
    // divider). marginLeft spaces the whole pair from whatever native
    // content sits before it in the header row.
    marginLeft: "8px",
    flexShrink: "0",
  });
  return wrapper;
}

/**
 * Scryfall's own .header-control-row is `width: 100%; max-width: 1000px;
 * margin: 0 auto; overflow: hidden` -- a fluid-but-capped container, so by
 * default it renders as a compact, centered ~1000px bar rather than
 * spanning the header's own full width. This extension wants the opposite
 * now: the row filling however much width `.header` actually has (its own
 * padding already gives good left/right breathing room -- confirmed live as
 * `padding: 0px 42.5469px`, so nothing extra needs adding here), with the
 * search field -- and *only* the search field -- absorbing the extra space,
 * everything else (logo, nav links, this extension's own button/pip groups)
 * keeping its natural size.
 *
 * That split happens for free once the native 1000px cap is lifted:
 * confirmed live that `form.header-search` and its own
 * `#header-search-field` already carry `flex: 1 1 0%` from Scryfall's own
 * stylesheet -- the field's old ~266px rendered width was purely the row's
 * capped width leaving it nothing to grow into, not a fixed width set on
 * the field itself. Every other row child has flex-grow 0 (the logo is
 * `flex: 0 0 34px`, `.header-links` is `flex: 0 1 auto`, this extension's
 * own wrapper divs only ever set flex-shrink), so none of them stretch.
 *
 * A `<style>` override doesn't work here -- confirmed live (still true)
 * that a `<style>` element inserted into <head> on this page ends up with
 * `sheet: null`, never actually applied (most likely this page's CSP allows
 * inline `style="..."` attributes but blocks injected stylesheets/style
 * elements). Setting the properties directly on the row's own style, the
 * same way every other control this extension adds to a page is styled, is
 * what actually takes effect.
 */
function updateHeaderRowMaxWidth(row) {
  // "none" rather than a measured number (an earlier version of this
  // function shrink-wrapped the row to its content's natural width instead
  // of stretching it -- see git history if that behavior is ever needed
  // again). Nothing here depends on the current content's size any more, so
  // -- unlike the old shrink-wrap version -- this never needs
  // re-measuring after content changes (a button's text getting longer, a
  // pip group being added): flexbox alone keeps redistributing the row's
  // already-fixed available width on every reflow.
  row.style.setProperty("max-width", "none", "important");
  row.style.setProperty("overflow", "visible", "important");
  // Safety net for a header narrower than this row's own fixed-size content
  // (logo + nav links + this extension's button/pip groups, none of which
  // shrink) -- lets the excess drop to a second line instead of overflowing
  // the row's own box sideways, which -- confirmed live, still true under
  // this new stretch-to-fill behavior -- would otherwise give the whole
  // page a horizontal scrollbar it never had before (`flex-wrap: nowrap` is
  // the site's own default). Re-confirmed live at a re-tested narrow
  // (1024px) width with the wider row and the new color pips both present.
  row.style.setProperty("flex-wrap", "wrap", "important");
  row.style.setProperty("row-gap", "6px", "important");
}

/**
 * Re-applies updateHeaderRowMaxWidth whenever the row's own children change
 * after the initial injection (e.g. the color-pips group or the pending-
 * prices button mounting later than this file's own controls). Under the
 * current stretch-to-fill behavior this is no longer about keeping a
 * measured number current -- there isn't one any more -- it's just a cheap,
 * idempotent safety net in case anything else ever touches the row's own
 * inline style after the first pass. Watches text/child changes only (not
 * attributes), so this doesn't re-trigger itself off its own max-width/
 * overflow/flex-wrap writes on the row, or off applySamvButtonStyle
 * repainting a button's border-color on hover.
 */
function watchHeaderRowWidth(row) {
  if (row.dataset.samvWidthWatcher) return;
  row.dataset.samvWidthWatcher = "1";

  let debounceTimer = null;
  const recalc = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => updateHeaderRowMaxWidth(row), 100);
  };

  new MutationObserver(recalc).observe(row, { childList: true, subtree: true, characterData: true });
  updateHeaderRowMaxWidth(row);
}

function injectFilterControls(filter) {
  currentFilter = filter;

  // Already injected on a previous run (or a previous debounced pass of the
  // observer below) -- just refresh the tooltip against the value this run
  // read, instead of re-creating anything.
  if (document.getElementById(FILTER_WRAPPER_ID)) {
    updateFilterButtonTitle();
    return;
  }

  const row = document.querySelector(SEL_HEADER_ROW);
  const searchField = document.querySelector(SEL_FILTER_SEARCH_FIELD);
  if (!row || !searchField) {
    logNotShown(
      "Scryfall Filter",
      "Filtro padrão / engrenagem",
      !row
        ? `elemento "${SEL_HEADER_ROW}" não encontrado na página`
        : `campo de busca "${SEL_FILTER_SEARCH_FIELD}" não encontrado na página`,
    );
    return;
  }

  watchHeaderRowWidth(row);

  const wrapper = buildWrapper();
  // Both controls render whenever the feature is enabled, independently of
  // whether a filter value is currently saved -- see the file header.
  wrapper.appendChild(buildFilterButton());
  wrapper.appendChild(buildGearButton());
  row.appendChild(wrapper);
  filterLog("Injected default-filter controls.");
}

function runFilterOverlay() {
  chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
    if (chrome.runtime.lastError) {
      logNotShown("Scryfall Filter", "Filtro padrão / engrenagem", `erro ao ler configurações — ${chrome.runtime.lastError.message}`);
      return;
    }
    if (settings?.addScryfallFilterButton === false) {
      logNotShown("Scryfall Filter", "Filtro padrão / engrenagem", "desabilitado nas configurações (addScryfallFilterButton = false)");
      return;
    }
    injectFilterControls((settings?.scryfallDefaultFilter ?? "").trim());
  });
}

observeAndRerun((mutations) => hasAddedNodeMatching(mutations, SEL_HEADER_ROW), runFilterOverlay);
