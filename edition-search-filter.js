/**
 * On an individual card page (?view=cards/card&card=...), adds a small
 * purple magnifying-glass badge over whichever edition icon in the
 * "versões" list (#slider-editions-icons) is currently hovered.
 *
 * Clicking it checks that edition's own checkbox in the "Edições" filter of
 * the "Comprar no Marketplace" tab further down the same page, narrowing the
 * "Lojas Vendendo" list to just that edition -- sparing a scroll through a
 * checkbox list that can have 100+ entries on a heavily-reprinted card.
 *
 * Depends on: content-utils.js (log, logNotShown, waitForElement,
 * SAMV_PURPLE, SAMV_PURPLE_HOVER, SAMV_PURPLE_TEXT)
 */

const SEL_EDITION_SLIDER = "#slider-editions-icons";
const SEL_EDITION_ICON = ".edition-icon";
const SEL_EDITION_FILTER_CHECKBOX = 'input[filter="2"]';
const EDITION_SEARCH_BADGE_CLASS = "lm-ext-edition-search-badge";

/**
 * The edition icon's own image carries "#<printNumber> - <editionName>" as
 * its title (e.g. "#212 - Marvel Super Heroes Commander") -- confirmed live
 * against Sol Ring's icons. Only the edition-name half is used: the
 * "Edições" filter in Comprar no Marketplace groups listings by edition/set
 * only (its own separate "Numeração do Card" filter covers print number),
 * so the print number in the title isn't needed for this match.
 */
function parseEditionName(icon) {
  const title = icon.querySelector("img")?.getAttribute("title");
  const match = title?.match(/^#\S+\s*-\s*(.+)$/);
  return match ? match[1].trim() : null;
}

/**
 * Checks the "Edições" filter checkbox matching this icon's edition, so the
 * "Lojas Vendendo" list below narrows to just that edition. Confirmed live
 * (via screenfilter's own source) that this filtering runs entirely
 * client-side against data already loaded on the page -- checking a
 * checkbox fires no network request.
 *
 * Any other edition already checked in that same group is unchecked first:
 * this is a "show me just this edition" action, not an additive multi-select.
 */
function applyEditionToFilters(icon) {
  const editionName = parseEditionName(icon);
  if (!editionName) {
    logNotShown("Filtrar por edição (Comprar no Marketplace)", "nome da edição não encontrado no ícone (título da imagem ausente/inesperado)");
    return;
  }

  const target = [...document.querySelectorAll(SEL_EDITION_FILTER_CHECKBOX)].find(
    (cb) => cb.closest("label")?.querySelector(".filter-infos")?.getAttribute("title") === editionName,
  );
  if (!target) {
    logNotShown("Filtrar por edição (Comprar no Marketplace)", `checkbox de edição "${editionName}" não encontrado nos filtros`);
    return;
  }

  document.querySelectorAll(`${SEL_EDITION_FILTER_CHECKBOX}:checked`).forEach((cb) => {
    // Clicking the native checkbox (rather than just setting .checked) fires
    // its own onclick, which is how the page's screenfilter script learns a
    // selection changed and re-applies the filter -- same technique as
    // everywhere else this extension drives an existing LigaMagic control.
    if (cb !== target) cb.click();
  });
  if (!target.checked) target.click();

  log(`Filtro de edição aplicado em Comprar no Marketplace: ${editionName}`);
}

function buildEditionSearchBadge(icon) {
  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = EDITION_SEARCH_BADGE_CLASS;
  badge.title = "Filtrar Lojas Vendendo por esta edição";
  badge.innerHTML =
    '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';
  Object.assign(badge.style, {
    position: "absolute",
    right: "1px",
    bottom: "1px",
    display: "none",
    alignItems: "center",
    justifyContent: "center",
    width: "13px",
    height: "13px",
    padding: "0",
    border: "1px solid #16213e",
    borderRadius: "50%",
    background: SAMV_PURPLE,
    color: SAMV_PURPLE_TEXT,
    cursor: "pointer",
    zIndex: "2",
  });
  badge.addEventListener("mouseenter", () => (badge.style.background = SAMV_PURPLE_HOVER));
  badge.addEventListener("mouseleave", () => (badge.style.background = SAMV_PURPLE));
  // The icon itself is an <a href="...jpg"> (opens the full-size image) --
  // without these, a click on the badge would also follow that link.
  badge.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    applyEditionToFilters(icon);
  });
  return badge;
}

/**
 * Kept as a real child of the icon it belongs to, positioned within the
 * icon's own box (not poking outside it) rather than tracked in viewport
 * coordinates -- the slider clips both axes (overflow-x: hidden, overflow-y:
 * auto), so ordinary page/slider scrolling moves and clips the badge exactly
 * like the rest of the icon for free, with no scroll listener needed.
 */
function ensureEditionSearchBadge(icon) {
  let badge = icon.querySelector(`.${EDITION_SEARCH_BADGE_CLASS}`);
  if (badge) return badge;

  if (getComputedStyle(icon).position === "static") icon.style.position = "relative";
  badge = buildEditionSearchBadge(icon);
  icon.appendChild(badge);
  return badge;
}

function wireEditionIcon(icon) {
  if (icon.dataset.samvEditionSearchWired) return;
  icon.dataset.samvEditionSearchWired = "1";
  icon.addEventListener("mouseenter", () => {
    ensureEditionSearchBadge(icon).style.display = "flex";
  });
  icon.addEventListener("mouseleave", () => {
    icon.querySelector(`.${EDITION_SEARCH_BADGE_CLASS}`)?.style.setProperty("display", "none");
  });
}

function initEditionSearchButton() {
  const slider = document.querySelector(SEL_EDITION_SLIDER);
  if (!slider) return false;
  if (slider.dataset.samvEditionSearchInit) return true;
  slider.dataset.samvEditionSearchInit = "1";

  const wireAll = () => slider.querySelectorAll(SEL_EDITION_ICON).forEach(wireEditionIcon);
  wireAll();
  // Wires up any icon the slider loads in later, if it ever turns out to
  // paginate/lazy-load on a card with even more prints than tested. Every
  // .edition-icon is a direct child of the slider (confirmed live), so
  // watching childList here is enough -- NOT subtree: with subtree:true,
  // this badge's own insertion into an icon (a mutation *inside* one of the
  // slider's children, appended on every hover) re-triggered this same
  // callback, which rescanned all ~130 icons on every hover. Scoped to just
  // the slider's own childList, only an icon actually being added/removed
  // fires it.
  new MutationObserver(wireAll).observe(slider, { childList: true });

  return true;
}

function initEditionSearchFilter() {
  if (new URLSearchParams(location.search).get("view") !== "cards/card") return;

  getSettings().then((settings) => {
    if (settings?.addEditionSearchButton === false) {
      logNotShown("Buscar edição (lupa nas versões)", "desabilitado nas configurações (addEditionSearchButton = false)");
      return;
    }
    waitForElement(initEditionSearchButton);
  });
}

initEditionSearchFilter();
