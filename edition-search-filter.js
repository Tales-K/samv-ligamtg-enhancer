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
const SEL_CARD_NUMBER_FILTER_CHECKBOX = 'input[filter="3"]';
const EDITION_SEARCH_BADGE_CLASS = "lm-ext-edition-search-badge";

/**
 * The edition icon's own image carries "#<printNumber> - <editionName>" as
 * its title (e.g. "#212 - Marvel Super Heroes Commander") -- confirmed live
 * against Sol Ring's icons. Both halves are used: the name for the primary
 * match against the "Edições" filter, the print number as a fallback (see
 * applyEditionToFilters).
 */
function parseIconTitle(icon) {
  const title = icon.querySelector("img")?.getAttribute("title");
  const match = title?.match(/^#(\S+)\s*-\s*(.+)$/);
  return match ? { number: match[1], name: match[2].trim() } : null;
}

/**
 * Checks `target` in its filter group and unchecks any other box already
 * checked in that same group: this is a "show me just this edition/number"
 * action, not an additive multi-select.
 */
function checkOnlyThisFilter(target, groupSelector) {
  document.querySelectorAll(`${groupSelector}:checked`).forEach((cb) => {
    // Clicking the native checkbox (rather than just setting .checked) fires
    // its own onclick, which is how the page's screenfilter script learns a
    // selection changed and re-applies the filter -- same technique as
    // everywhere else this extension drives an existing LigaMagic control.
    if (cb !== target) cb.click();
  });
  if (!target.checked) target.click();
}

/**
 * Checks the "Edições" filter checkbox matching this icon's edition, so the
 * "Lojas Vendendo" list below narrows to just that edition. Confirmed live
 * (via screenfilter's own source) that this filtering runs entirely
 * client-side against data already loaded on the page -- checking a
 * checkbox fires no network request.
 *
 * Some editions (e.g. Bonus Sheet / Source Material crossover sets --
 * confirmed live on "Tangle") are rendered with the name order swapped in
 * this specific filter versus everywhere else on the page ("Marvel's
 * Spider-Man (Source Material)" on the icon/dropdown, "Source Material -
 * Marvel's Spider-Man" in this filter's own title), so the exact-name match
 * can legitimately miss. When that happens, this falls back to the
 * "Numeração do Card" filter (its own separate group), matching on the
 * print number already parsed from the icon's title. That number isn't
 * always unique to one edition (a Bonus Sheet reprint can share its base
 * set's collector number), so it's only a fallback, not the primary match.
 */
function applyEditionToFilters(icon) {
  const parsed = parseIconTitle(icon);
  if (!parsed) {
    logNotShown("Filtrar por edição (Comprar no Marketplace)", "nome/número da edição não encontrado no ícone (título da imagem ausente/inesperado)");
    return;
  }

  const byName = [...document.querySelectorAll(SEL_EDITION_FILTER_CHECKBOX)].find(
    (cb) => cb.closest("label")?.querySelector(".filter-infos")?.getAttribute("title") === parsed.name,
  );
  if (byName) {
    checkOnlyThisFilter(byName, SEL_EDITION_FILTER_CHECKBOX);
    log(`Filtro de edição aplicado em Comprar no Marketplace (por nome): ${parsed.name}`);
    return;
  }

  const byNumber = [...document.querySelectorAll(SEL_CARD_NUMBER_FILTER_CHECKBOX)].find(
    (cb) => cb.closest("label")?.querySelector(".filter-infos")?.getAttribute("title") === `#${parsed.number}`,
  );
  if (byNumber) {
    checkOnlyThisFilter(byNumber, SEL_CARD_NUMBER_FILTER_CHECKBOX);
    log(`Edição "${parsed.name}" não encontrada no filtro de Edições; aplicado fallback por Numeração do Card: #${parsed.number}`);
    return;
  }

  logNotShown(
    "Filtrar por edição (Comprar no Marketplace)",
    `nem o nome ("${parsed.name}") nem o número ("#${parsed.number}") da edição foram encontrados nos filtros`,
  );
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
