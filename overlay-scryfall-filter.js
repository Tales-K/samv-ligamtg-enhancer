/**
 * Adds a button to Scryfall's header that appends a saved default filter
 * (settings.scryfallDefaultFilter, e.g. "sort:edhrec") to whatever is already
 * in the search field, without submitting -- so the filter can be reused
 * across searches without retyping it.
 *
 * Depends on: overlay-utils.js (createLogger, applySamvButtonStyle,
 * observeAndRerun, hasAddedNodeMatching)
 */

const filterLog = createLogger("Scryfall Filter");

const SEL_HEADER_ROW = "div.header-control-row";
const SEL_FILTER_SEARCH_FIELD = "#header-search-field";
const FILTER_BUTTON_ID = "lm-ext-scryfall-filter-btn";

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

function buildFilterButton(filter) {
  const button = document.createElement("button");
  button.type = "button";
  button.id = FILTER_BUTTON_ID;
  button.textContent = "Filtro padrão";
  button.title = `Acrescenta "${filter}" à busca`;
  Object.assign(button.style, {
    marginLeft: "8px",
    padding: "5px 10px",
    border: "none",
    borderRadius: "4px",
    fontSize: "13px",
    fontWeight: "700",
    fontFamily: "inherit",
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: "0",
  });
  applySamvButtonStyle(button);

  button.addEventListener("click", () => {
    const field = document.querySelector(SEL_FILTER_SEARCH_FIELD);
    if (field) appendFilterTerms(field, filter);
  });
  return button;
}

function injectFilterButton(filter) {
  if (document.getElementById(FILTER_BUTTON_ID)) return;
  const row = document.querySelector(SEL_HEADER_ROW);
  if (!row || !document.querySelector(SEL_FILTER_SEARCH_FIELD)) return;

  row.appendChild(buildFilterButton(filter));
  filterLog("Injected default-filter button.");
}

function runFilterOverlay() {
  chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
    if (chrome.runtime.lastError) {
      filterLog("Could not read settings:", chrome.runtime.lastError.message);
      return;
    }
    if (settings?.addScryfallFilterButton === false) return;
    // With no filter saved the button would have nothing to add, so it isn't
    // shown at all rather than appearing as a dead control.
    const filter = (settings?.scryfallDefaultFilter ?? "").trim();
    if (!filter) return;
    injectFilterButton(filter);
  });
}

observeAndRerun((mutations) => hasAddedNodeMatching(mutations, SEL_HEADER_ROW), runFilterOverlay);
