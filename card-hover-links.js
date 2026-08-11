/**
 * Adds "Scryfall" and "EDHREC" quick-link buttons under the card-hover image
 * tooltip (#mystickytooltip) that LigaMagic's own stickytooltip.js library
 * shows on any .sticky_lazy card link -- deck pages, "Meus Decks" listing,
 * wherever the site uses it.
 *
 * Depends on: content-utils.js (waitForElement, cardNameFromHref,
 * applySamvStyle, getSettings, log)
 */

const STICKY_TOOLTIP_ID = "mystickytooltip";
const CARD_LINKS_BAR_ID = "lm-ext-card-links";
const STICKY_LAZY_SELECTOR = ".sticky_lazy";
// Tolerance for the empty space between the card link and the tooltip box
// (the box sits at a fixed offset from the cursor, not glued to it), so the
// cursor has time to cross the gap before the box actually disappears.
const HOVER_HIDE_GRACE_MS = 200;

function scryfallSearchUrl(name) {
  const frontFace = name.split(" // ")[0];
  return `https://scryfall.com/search?q=${encodeURIComponent(`!"${frontFace}"`)}`;
}

/**
 * EDHREC's own card-page slug: front face only, accents stripped,
 * apostrophes dropped outright (not turned into a hyphen), everything else
 * collapsed to single hyphens. Verified directly against edhrec.com --
 * e.g. "Shardmage's Rescue" -> "shardmages-rescue", accented card names ->
 * unaccented slugs, "Fire // Ice" -> "fire".
 */
function edhrecCardSlug(name) {
  return name
    .split(" // ")[0]
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // diacritics split out by NFD normalization
    .toLowerCase()
    .replace(/['’]/g, "") // straight and curly apostrophes
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function edhrecCardUrl(name) {
  return `https://edhrec.com/cards/${edhrecCardSlug(name)}`;
}

/**
 * Card name displayed on hover is whatever language the user has the site
 * set to (see cardNameFromHref's own doc comment) -- Scryfall/EDHREC need
 * the canonical English name, which only the link's href carries. The link
 * markup differs by view mode: list view puts .sticky_lazy directly on the
 * <a>, grid view puts it on a wrapping div with the <a> inside.
 */
function cardNameFromStickyLazy(el) {
  const anchor = el.matches("a[href]") ? el : el.querySelector("a[href]");
  return (anchor && cardNameFromHref(anchor.getAttribute("href"))) || el.textContent.trim();
}

/** Builds the two-button bar once, right after .stickyloadedimgs -- the box
 * has no fixed height or overflow:hidden, so it grows to fit whatever comes
 * after the image. Called on the first card hover rather than at start-up,
 * so pages that never show a card tooltip get no bar at all. */
function injectCardLinksBar(box) {
  if (box.querySelector(`#${CARD_LINKS_BAR_ID}`)) return;

  const bar = document.createElement("div");
  bar.id = CARD_LINKS_BAR_ID;
  Object.assign(bar.style, {
    display: "flex",
    gap: "6px",
    width: "312px", // matches the tooltip image's own width
    margin: "4px 4px 4px",
  });

  [
    { className: "lm-ext-scryfall", label: "Scryfall" },
    { className: "lm-ext-edhrec", label: "EDHREC" },
  ].forEach(({ className, label }) => {
    const link = document.createElement("a");
    link.className = className;
    link.textContent = label;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    Object.assign(link.style, {
      flex: "1",
      textAlign: "center",
      padding: "6px 0",
      borderRadius: "4px",
      fontSize: "12px",
      fontWeight: "700",
      textDecoration: "none",
    });
    applySamvStyle(link);
    bar.appendChild(link);
  });

  // The bar has to end up inside the box, so it's hidden along with it:
  // "afterend" of the box itself would leave it sitting loose in the page.
  const loadedImgs = box.querySelector(".stickyloadedimgs");
  if (loadedImgs) loadedImgs.insertAdjacentElement("afterend", bar);
  else box.appendChild(bar);
  log("Injected Scryfall/EDHREC card-hover links.");
}

function updateCardLinks(box, name) {
  injectCardLinksBar(box);
  const scryfallLink = box.querySelector(`#${CARD_LINKS_BAR_ID} .lm-ext-scryfall`);
  const edhrecLink = box.querySelector(`#${CARD_LINKS_BAR_ID} .lm-ext-edhrec`);
  if (scryfallLink) scryfallLink.href = scryfallSearchUrl(name);
  if (edhrecLink) edhrecLink.href = edhrecCardUrl(name);
}

/**
 * LigaMagic's stickytooltip.js hides the box as soon as the cursor leaves
 * the card link (gated by a `stickytooltip.isdocked` flag it owns, meant to
 * be set while the cursor is over the box itself) -- but the box sits at a
 * fixed pixel offset from the link, not glued to the cursor, so that hide
 * fires before the cursor has actually crossed the gap to reach it.
 *
 * This site runs jQuery 1.9, whose mouseenter/mouseleave are simulated on
 * top of native mouseover/mouseout (checking relatedTarget) rather than
 * using the native events directly. Intercepting mouseout/mouseover
 * ourselves in the capture phase runs ahead of that simulation's own
 * bubble-phase listener, so stopPropagation() here keeps it from ever
 * seeing the event -- we take over hiding the box entirely instead of
 * racing the library for it, and isdocked is never touched.
 */
function initHoverBridge(box) {
  if (box.dataset.samvHoverBridge) return;
  box.dataset.samvHoverBridge = "1";

  let hideTimer = null;
  const cancelHide = () => clearTimeout(hideTimer);
  const hide = () => {
    cancelHide();
    box.style.display = "none";
  };

  document.addEventListener(
    "mouseout",
    (e) => {
      if (!e.target.closest?.(STICKY_LAZY_SELECTOR)) return;
      e.stopPropagation();
      cancelHide();
      hideTimer = setTimeout(hide, HOVER_HIDE_GRACE_MS);
    },
    true,
  );

  document.addEventListener(
    "mouseover",
    (e) => {
      if (!e.target.closest?.(`#${STICKY_TOOLTIP_ID}`)) return;
      e.stopPropagation();
      cancelHide();
    },
    true,
  );

  // Not part of the hide-suppression bridge above -- this is the normal
  // (bubbling, non-capture) hover that fills in the two link hrefs. Also
  // cancels a pending hide left over from a previous card link, in case the
  // cursor moved straight from one card to the next without ever reaching
  // the box.
  document.addEventListener("mouseover", (e) => {
    const link = e.target.closest?.(STICKY_LAZY_SELECTOR);
    if (!link) return;
    cancelHide();
    updateCardLinks(box, cardNameFromStickyLazy(link));
  });

  box.addEventListener("mouseleave", hide);
}

function initCardHoverLinks() {
  getSettings().then((settings) => {
    if (settings?.addCardHoverLinks === false) return;
    waitForElement(() => {
      const box = document.getElementById(STICKY_TOOLTIP_ID);
      if (!box) return false;
      initHoverBridge(box);
      return true;
    });
  });
}

initCardHoverLinks();
