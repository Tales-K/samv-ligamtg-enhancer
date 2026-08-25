/**
 * Adds a visible "buscar" icon inside Scryfall's own header search field.
 * Today the only way to trigger that search is pressing Enter -- the form's
 * own submit button exists in the DOM but is visually hidden
 * (<button class="vh" type="submit">Find Cards</button>, "vh" = visually
 * hidden), with nothing clickable in its place.
 *
 * Runs on every page with that field (not gated behind any of the other
 * Scryfall settings) since it's a plain navigation affordance, not tied to
 * price data.
 *
 * Depends on: overlay-utils.js (createLogger, logNotShown, observeAndRerun,
 * hasAddedNodeMatching)
 */

const searchLog = createLogger("Scryfall Search");

const SEL_SEARCH_FORM = "form.header-search";
const SEL_SEARCH_FIELD = "#header-search-field";
const SEARCH_GO_BUTTON_ID = "lm-ext-scryfall-search-go-btn";

function injectSearchGoButton() {
  if (document.getElementById(SEARCH_GO_BUTTON_ID)) return;

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

  // Room on the right so typed text never runs under the icon (the field's
  // own right padding is just 3px, confirmed live).
  field.style.paddingRight = "30px";

  const button = document.createElement("button");
  // Never "submit" -- the click handler below triggers the form's own
  // existing submit path instead of adding a second, competing one.
  button.type = "button";
  button.id = SEARCH_GO_BUTTON_ID;
  button.setAttribute("aria-label", "Buscar");
  button.title = "Buscar";
  button.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';
  Object.assign(button.style, {
    position: "absolute",
    right: "8px",
    top: "50%",
    transform: "translateY(-50%)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "22px",
    height: "22px",
    padding: "0",
    border: "none",
    background: "transparent",
    color: "#8a8a99",
    cursor: "pointer",
  });
  button.addEventListener("mouseenter", () => (button.style.color = "#a78bfa"));
  button.addEventListener("mouseleave", () => (button.style.color = "#8a8a99"));

  // Reuses Scryfall's own submit path rather than reimplementing the search
  // -- requestSubmit() runs the form's native validation/submit exactly like
  // pressing Enter in the field already does; the fallback covers a browser
  // old enough to lack it by clicking the form's own hidden submit button.
  button.addEventListener("click", () => {
    if (form.requestSubmit) form.requestSubmit();
    else form.querySelector('button.vh[type="submit"]')?.click();
  });

  form.appendChild(button);
  searchLog("Injected search field go button.");
}

observeAndRerun((mutations) => hasAddedNodeMatching(mutations, SEL_SEARCH_FORM), injectSearchGoButton);
