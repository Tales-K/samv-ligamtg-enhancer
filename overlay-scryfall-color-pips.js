/**
 * Adds 5 clickable color-identity pips (W/U/B/R/G) right after Scryfall's
 * own header search bar, each toggling a `ci:<letter>` term in the search
 * field -- e.g. clicking the green pip adds "ci:g" if it isn't already
 * there, or removes it if it is.
 *
 * Each pip renders Scryfall's own native mana symbol markup (confirmed live
 * on both /advanced and a search-results page: `<abbr class="card-symbol
 * card-symbol-G" title="...">{G}</abbr>`, styled by Scryfall's own
 * site-wide stylesheet via a background-image on the abbr itself -- no
 * extra markup or classes needed to get the real icon), inside a button
 * this file styles itself (dim + no ring when the term isn't in the field,
 * full opacity + a SAMV_PURPLE ring when it is).
 *
 * Mounted as a flex sibling of `form.header-search` inside
 * `div.header-control-row` (right after the form, so it's the first thing
 * to the right of the search bar) -- not injected *into* the native form --
 * matching how overlay-scryfall-filter.js's own controls are added directly
 * to the row rather than reaching into Scryfall's own markup.
 *
 * Depends on: overlay-utils.js (createLogger, logNotShown, SAMV_PURPLE,
 * observeAndRerun, hasAddedNodeMatching)
 */

const colorPipsLog = createLogger("Scryfall Color Pips");

const SEL_COLOR_PIPS_FORM = "form.header-search";
const SEL_COLOR_PIPS_FIELD = "#header-search-field";
const COLOR_PIPS_WRAPPER_ID = "lm-ext-scryfall-color-pips";
const COLOR_PIP_BTN_ID_PREFIX = "lm-ext-scryfall-color-pip-";

const COLOR_PIPS = [
  { letter: "w", label: "Branco" },
  { letter: "u", label: "Azul" },
  { letter: "b", label: "Preto" },
  { letter: "r", label: "Vermelho" },
  { letter: "g", label: "Verde" },
];

function colorPipToken(letter) {
  return `ci:${letter}`;
}

/** Same whitespace tokenization appendFilterTerms uses (overlay-scryfall-filter.js), compared case-insensitively so a manually-typed "CI:G" is recognized too -- appendFilterTerms itself isn't reused directly since it only ever adds a term and compares case-sensitively, neither of which fits a toggle. */
function fieldHasColorToken(field, letter) {
  const target = colorPipToken(letter);
  return field.value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .some((term) => term.toLowerCase() === target);
}

/** Adds ci:<letter> if it's missing, removes it (whatever its original casing) if it's already there. Dispatches a bubbling `input` event afterward -- picked up both by this file's own field-wide listener (recalculating every pip's state) and by overlay-scryfall-search.js's own listener (recomputing the clickable search icon's href), with no direct coupling between the two files needed. */
function toggleColorToken(field, letter) {
  const target = colorPipToken(letter);
  const tokens = field.value.trim().split(/\s+/).filter(Boolean);
  const idx = tokens.findIndex((term) => term.toLowerCase() === target);
  if (idx >= 0) tokens.splice(idx, 1);
  else tokens.push(target);
  field.value = tokens.join(" ");
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function setColorPipActive(btn, active) {
  btn.dataset.active = active ? "1" : "0";
  btn.style.opacity = active ? "1" : "0.42";
  btn.style.boxShadow = active ? `0 0 0 2px ${SAMV_PURPLE}` : "0 0 0 2px transparent";
  // Same purple as SAMV_PURPLE, at low alpha -- applySamvButtonStyle isn't
  // used here since it paints a solid background meant for a text button;
  // these pips need to keep showing the mana symbol's own real colors, just
  // tinted to read as "on".
  btn.style.background = active ? "rgba(109, 79, 196, 0.18)" : "transparent";
}

/** Re-reads the field and updates every pip's on/off state -- called once at mount (in case the field already came in pre-filled from the URL) and on every `input` event after that (this file's own toggle clicks included, via the bubbling event, and any manual typing/pasting into the field). */
function syncColorPips(field) {
  COLOR_PIPS.forEach(({ letter }) => {
    const btn = document.getElementById(COLOR_PIP_BTN_ID_PREFIX + letter);
    if (btn) setColorPipActive(btn, fieldHasColorToken(field, letter));
  });
}

function buildColorPip({ letter, label }) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = COLOR_PIP_BTN_ID_PREFIX + letter;
  btn.title = `Alternar "${colorPipToken(letter)}" na busca (identidade de cor: ${label})`;
  Object.assign(btn.style, {
    boxSizing: "border-box",
    width: "26px",
    height: "26px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    background: "transparent",
    flexShrink: "0",
    transition: "opacity .15s ease, box-shadow .15s ease, background-color .15s ease",
  });

  // Scryfall's own native mana-symbol markup (see the file header) -- no
  // "title" of its own here (that would fight this button's own title for
  // which tooltip actually shows on hover, since the abbr sits directly
  // under the cursor).
  const symbol = document.createElement("abbr");
  symbol.className = `card-symbol card-symbol-${letter.toUpperCase()}`;
  symbol.textContent = `{${letter.toUpperCase()}}`;
  btn.appendChild(symbol);

  btn.addEventListener("mouseenter", () => {
    if (btn.dataset.active !== "1") btn.style.opacity = "0.75";
  });
  btn.addEventListener("mouseleave", () => {
    if (btn.dataset.active !== "1") btn.style.opacity = "0.42";
  });
  btn.addEventListener("click", () => {
    const field = document.querySelector(SEL_COLOR_PIPS_FIELD);
    if (field) toggleColorToken(field, letter);
  });

  setColorPipActive(btn, false);
  return btn;
}

function buildColorPipsWrapper() {
  const wrapper = document.createElement("div");
  wrapper.id = COLOR_PIPS_WRAPPER_ID;
  Object.assign(wrapper.style, {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    marginLeft: "10px",
    // Fixed size regardless of how much extra width the row/search field
    // absorb (see updateHeaderRowMaxWidth in overlay-scryfall-filter.js) --
    // this group never grows or shrinks.
    flexShrink: "0",
  });
  COLOR_PIPS.forEach((color) => wrapper.appendChild(buildColorPip(color)));
  return wrapper;
}

function injectColorPips() {
  if (document.getElementById(COLOR_PIPS_WRAPPER_ID)) return;

  const form = document.querySelector(SEL_COLOR_PIPS_FORM);
  const field = document.querySelector(SEL_COLOR_PIPS_FIELD);
  if (!form || !field) {
    logNotShown(
      "Scryfall Color Pips",
      "Pipetas de identidade de cor",
      !form ? `elemento "${SEL_COLOR_PIPS_FORM}" não encontrado` : `elemento "${SEL_COLOR_PIPS_FIELD}" não encontrado`,
    );
    return;
  }

  const wrapper = buildColorPipsWrapper();
  // Sibling of the form inside the row, not a child of the form itself --
  // see the file header.
  form.insertAdjacentElement("afterend", wrapper);
  syncColorPips(field);
  field.addEventListener("input", () => syncColorPips(field));

  colorPipsLog("Injected color-identity pips.");
}

observeAndRerun((mutations) => hasAddedNodeMatching(mutations, SEL_COLOR_PIPS_FORM), injectColorPips);
