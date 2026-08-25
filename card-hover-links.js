/**
 * Adds "Scryfall", "EDHREC" and "Copiar nome" buttons above the card-hover image
 * tooltip (#mystickytooltip) that LigaMagic's own stickytooltip.js library
 * shows on any .sticky_lazy card link -- deck pages, "Meus Decks" listing,
 * wherever the site uses it.
 *
 * Depends on: content-utils.js (waitForElement, cardNameFromHref,
 * applySamvStyle, getSettings, showCopiedFeedback, log)
 */

const STICKY_TOOLTIP_ID = "mystickytooltip";
const CARD_LINKS_BAR_ID = "lm-ext-card-links";
const CARD_LINKS_COPY_CLASS = "lm-ext-copy-name";
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

/** Builds the three-button bar once, right before .stickyloadedimgs -- the
 * box has no fixed height or overflow:hidden, so it grows to fit whatever
 * comes above the image. Called on the first card hover rather than at
 * start-up, so pages that never show a card tooltip get no bar at all. */
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

  // Copies the same English name the two links are built from, which is what
  // deck builders and search fields expect -- not the localized name shown
  // on screen.
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = CARD_LINKS_COPY_CLASS;
  copyButton.textContent = "Copiar nome";
  Object.assign(copyButton.style, {
    flex: "1",
    padding: "6px 0",
    border: "none",
    borderRadius: "4px",
    fontSize: "12px",
    fontWeight: "700",
    cursor: "pointer",
    fontFamily: "inherit",
  });
  applySamvStyle(copyButton);
  copyButton.addEventListener("click", () => {
    const name = bar.dataset.cardName;
    if (!name) return;
    navigator.clipboard.writeText(name).then(() => showCopiedFeedback(copyButton));
  });
  bar.appendChild(copyButton);

  // The bar has to end up inside the box, so it's hidden along with it:
  // "beforebegin" of the image container keeps it a sibling within the same
  // box, just placed above the image instead of below it.
  const loadedImgs = box.querySelector(".stickyloadedimgs");
  if (loadedImgs) loadedImgs.insertAdjacentElement("beforebegin", bar);
  else box.appendChild(bar);
  log("Injected Scryfall/EDHREC card-hover links.");
}

function updateCardLinks(box, name) {
  injectCardLinksBar(box);
  const bar = box.querySelector(`#${CARD_LINKS_BAR_ID}`);
  if (bar) bar.dataset.cardName = name;
  const scryfallLink = box.querySelector(`#${CARD_LINKS_BAR_ID} .lm-ext-scryfall`);
  const edhrecLink = box.querySelector(`#${CARD_LINKS_BAR_ID} .lm-ext-edhrec`);
  if (scryfallLink) scryfallLink.href = scryfallSearchUrl(name);
  if (edhrecLink) edhrecLink.href = edhrecCardUrl(name);
}

// ── Card-hover price line ────────────────────────────────────────────────────
const CARD_HOVER_PRICE_ID = "lm-ext-card-hover-price";

function fmtBRL(value) {
  return `R$ ${value.toFixed(2).replace(".", ",")}`;
}

/**
 * min/avg/max side by side on one line, colored green/yellow/red instead of
 * labelled — the color alone says which value is which, so no "mín/méd/máx"
 * prefix is needed. A lone card page only ever fills in priceMin, so a
 * single-value card just shows the one green number with no spacers.
 */
function buildCardPriceParts(info) {
  return [
    [info.priceMin, SAMV_PRICE_MIN_COLOR],
    [info.priceAvg, SAMV_PRICE_AVG_COLOR],
    [info.priceMax, SAMV_PRICE_MAX_COLOR],
  ].filter(([value]) => value != null);
}

/** Built once per tooltip box, right after the card image — same width as the image, hidden until a price is actually found. */
function injectCardHoverPriceLine(box) {
  if (box.querySelector(`#${CARD_HOVER_PRICE_ID}`)) return;

  const line = document.createElement("div");
  line.id = CARD_HOVER_PRICE_ID;
  Object.assign(line.style, {
    display: "none",
    width: "312px",
    boxSizing: "border-box",
    margin: "4px 4px 0",
    padding: "4px 0",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "12px",
    fontWeight: "700",
    // Whitish backing so the text stays readable regardless of whatever's
    // behind the hover preview at that point on the page.
    background: "rgba(255, 255, 255, 0.92)",
    borderRadius: "4px",
  });

  const loadedImgs = box.querySelector(".stickyloadedimgs");
  if (loadedImgs) loadedImgs.insertAdjacentElement("afterend", line);
  else box.appendChild(line);
}

/**
 * Shows this card's price below the hover preview when it's already sitting
 * in the local price cache (chrome.storage.local) — a plain, free lookup,
 * never a fetch. Cards this browser hasn't scraped today (on a LigaMagic
 * deck page, card page, or via the pending-prices backfill) just get no
 * price line at all rather than one that lies about "no price on
 * LigaMagic" — that would misrepresent "we haven't looked yet" as "there
 * really is none".
 */
function updateCardHoverPrice(box, name) {
  injectCardHoverPriceLine(box);
  const line = box.querySelector(`#${CARD_HOVER_PRICE_ID}`);
  if (!line) return;

  line.style.display = "none";
  line.dataset.forName = name;

  sendMessage({ action: "queryPrices", cards: [name] }).then((response) => {
    // The cursor may already be over a different card by the time this
    // resolves — bail rather than showing a stale price under it.
    if (line.dataset.forName !== name) return;
    const info = response?.prices?.[name];
    if (!info || info.priceMin == null) {
      logNotShown("Preço no hover da carta", `sem preço em cache para "${name}"`);
      return;
    }

    line.replaceChildren();
    buildCardPriceParts(info).forEach(([value, color], i) => {
      if (i > 0) {
        const spacer = document.createElement("span");
        spacer.textContent = "•";
        spacer.style.margin = "0 6px";
        spacer.style.color = "#999";
        line.appendChild(spacer);
      }
      const span = document.createElement("span");
      span.textContent = fmtBRL(value);
      span.style.color = color;
      line.appendChild(span);
    });
    line.style.display = "flex";
  });
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
    const name = cardNameFromStickyLazy(link);
    updateCardLinks(box, name);
    updateCardHoverPrice(box, name);
  });

  box.addEventListener("mouseleave", hide);
}

function initCardHoverLinks() {
  getSettings().then((settings) => {
    if (settings?.addCardHoverLinks === false) {
      logNotShown("Scryfall/EDHREC/Copiar nome (hover)", "desabilitado nas configurações (addCardHoverLinks = false)");
      return;
    }
    waitForElement(() => {
      const box = document.getElementById(STICKY_TOOLTIP_ID);
      if (!box) return false;
      initHoverBridge(box);
      return true;
    });
  });
}

// ── Individual card page (?view=cards/card&card=...) ────────────────────────
const CARD_PAGE_LINKS_CLASS = "lm-ext-card-page-links";

function isIndividualCardPage() {
  return new URLSearchParams(window.location.search).get("view") === "cards/card";
}

/**
 * Adds Scryfall/EDHREC buttons right after the favorite-heart icon
 * (.item-fav), before the "..." actions menu, in the card page's header.
 */
function injectCardPageLinks() {
  if (document.querySelector(`.${CARD_PAGE_LINKS_CLASS}`)) return true;

  const fav = document.querySelector(".item-fav");
  if (!fav) {
    logNotShown("Scryfall/EDHREC (página de carta)", "âncora .item-fav ainda não apareceu — pode ser só carregamento em andamento");
    return false;
  }

  const name = document.querySelector(".item-name-en")?.textContent?.trim();
  if (!name) {
    logNotShown(
      "Scryfall/EDHREC (página de carta)",
      "nome resolvido não encontrado (.item-name-en ausente/vazio — provável página de busca ambígua, sem um card único)",
    );
    return false;
  }

  const bar = document.createElement("div");
  bar.className = CARD_PAGE_LINKS_CLASS;
  Object.assign(bar.style, { display: "flex", gap: "6px", alignItems: "center" });

  [
    { label: "Scryfall", href: scryfallSearchUrl(name) },
    { label: "EDHREC", href: edhrecCardUrl(name) },
  ].forEach(({ label, href }) => {
    const link = document.createElement("a");
    link.textContent = label;
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    Object.assign(link.style, {
      padding: "6px 10px",
      borderRadius: "4px",
      fontSize: "12px",
      fontWeight: "700",
      textDecoration: "none",
      whiteSpace: "nowrap",
    });
    applySamvStyle(link);
    bar.appendChild(link);
  });

  fav.insertAdjacentElement("afterend", bar);
  log("Injected Scryfall/EDHREC card-page links.");
  return true;
}

function initCardPageLinks() {
  if (!isIndividualCardPage()) return;
  getSettings().then((settings) => {
    if (settings?.addCardHoverLinks === false) {
      logNotShown("Scryfall/EDHREC (página de carta)", "desabilitado nas configurações (addCardHoverLinks = false)");
      return;
    }
    waitForElement(injectCardPageLinks);
  });
}

initCardHoverLinks();
initCardPageLinks();
