/**
 * Turns Scryfall's own header search field into a two-way navigable control.
 *
 * The field's left-hand magnifying-glass icon is native to Scryfall, but
 * confirmed live it's purely a `background-image` set on the `<input>`
 * itself (`.header-search-field { background-image: url(...); padding-left:
 * 32px }`) -- decorative, not a separate clickable element. This file turns
 * off that native background image and paints a real `<a href>` in its
 * place, same spot, with a purple SAMV background (applySamvButtonStyle)
 * instead of the plain grey icon.
 *
 * Being a real link rather than a JS-driven button click means ctrl-click
 * and middle-click already open the search in a new tab for free, with no
 * JS of our own needed for that part -- the `href` just always has to be
 * kept current. It's recomputed from every field in the form (`new
 * FormData(form)`), not just the visible `q` text, since a real Enter/
 * submit on this form also sends whatever the form's own hidden fields
 * (`unique`, `as`, `order`, ...) currently hold -- confirmed live these
 * vary by page (e.g. `as=grid` vs `as=full`). Recomputed on every `input`
 * event on the field, which also fires (via `dispatchEvent(new
 * Event("input", { bubbles: true }))`) whenever something else edits the
 * field programmatically -- appendFilterTerms's "Filtro padrão" button in
 * overlay-scryfall-filter.js, or the color-identity pips in
 * overlay-scryfall-color-pips.js -- so this file needs no direct coupling
 * to either of them to stay in sync.
 *
 * Confirmed live that plain left-click navigation through this `<a href>`
 * lands on the exact same URL a real Enter-triggered form submit does (the
 * form is a plain `method="get"` with no Turbo/JS interception -- confirmed
 * live: `window.Turbo` is undefined and `document.documentElement` carries
 * no `data-turbo` attribute), so no click handler beyond the href itself is
 * needed.
 *
 * There used to also be a second, separate button on the right edge of the
 * field (a plain `<button type="button">`, not a link, with no dynamic
 * href) -- removed entirely in favor of this one, since a single real link
 * covers everything that button did (triggering the search) plus what it
 * couldn't (opening in a new tab).
 *
 * Runs on every page with that field (not gated behind any of the other
 * Scryfall settings) since it's a plain navigation affordance, not tied to
 * price data.
 *
 * Depends on: overlay-utils.js (createLogger, logNotShown, applySamvButtonStyle,
 * observeAndRerun, hasAddedNodeMatching)
 */

const searchLog = createLogger("Scryfall Search");

const SEL_SEARCH_FORM = "form.header-search";
const SEL_SEARCH_FIELD = "#header-search-field";
const SEARCH_ICON_LINK_ID = "lm-ext-scryfall-search-icon";
// Matches the 26px height already used elsewhere in this row (see
// FILTER_BUTTON_HEIGHT in overlay-scryfall-filter.js) so every SAMV control
// added to this header reads as the same family of controls.
const SEARCH_ICON_SIZE = "26px";
// left offset (6px) + icon width (26px) + a small gap before typed text
// (6px) -- replaces the native field's own 32px (sized for a plain 16px
// decorative icon, no gap requirement since nothing was ever clickable
// there).
const SEARCH_ICON_FIELD_PADDING_LEFT = "38px";

/** Builds the absolute URL a real Enter/submit on `form` would navigate to right now, from every one of its fields (not just the visible text) -- same construction the browser itself does for a method="get" form submit. */
function computeSearchHref(form) {
  const params = new URLSearchParams(new FormData(form));
  return `${form.action}?${params.toString()}`;
}

function injectSearchIcon() {
  if (document.getElementById(SEARCH_ICON_LINK_ID)) return;

  const form = document.querySelector(SEL_SEARCH_FORM);
  const field = document.querySelector(SEL_SEARCH_FIELD);
  if (!form || !field) {
    logNotShown(
      "Scryfall Search",
      "Ícone de busca no campo de pesquisa",
      !form ? `elemento "${SEL_SEARCH_FORM}" não encontrado` : `elemento "${SEL_SEARCH_FIELD}" não encontrado`,
    );
    return;
  }

  // Turns off the native decorative icon so it doesn't render underneath
  // ours, then reserves a left-hand gutter sized for OUR icon instead of
  // the native one's. Also drops the old right-edge button's own reserved
  // padding (see the file header) -- nothing sits there any more.
  field.style.backgroundImage = "none";
  field.style.paddingLeft = SEARCH_ICON_FIELD_PADDING_LEFT;
  field.style.removeProperty("padding-right");

  const link = document.createElement("a");
  link.id = SEARCH_ICON_LINK_ID;
  link.setAttribute("aria-label", "Buscar");
  link.title = "Buscar — ctrl+clique ou clique do meio abre em nova aba";
  link.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';
  Object.assign(link.style, {
    // form.header-search is `position: relative` natively (confirmed live),
    // so this positions relative to the form/field box exactly like the
    // removed right-edge button used to, just mirrored to the left edge at
    // the native icon's own offset.
    position: "absolute",
    left: "6px",
    top: "50%",
    transform: "translateY(-50%)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: SEARCH_ICON_SIZE,
    height: SEARCH_ICON_SIZE,
    boxSizing: "border-box",
    borderRadius: "6px",
    textDecoration: "none",
    cursor: "pointer",
  });
  applySamvButtonStyle(link);

  const refreshHref = () => {
    link.href = computeSearchHref(form);
  };
  refreshHref();
  field.addEventListener("input", refreshHref);

  // Absolutely positioned, so where it lands in the form's own flex flow
  // doesn't matter (see the file header on position:relative/absolute).
  form.appendChild(link);
  searchLog("Injected clickable search icon (left edge, real link with dynamic href).");
}

observeAndRerun((mutations) => hasAddedNodeMatching(mutations, SEL_SEARCH_FORM), injectSearchIcon);
