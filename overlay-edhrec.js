/**
 * EDHREC — adds a "Ver no LigaMagic" button to a commander page's card panel,
 * as its own line right below the card image + price row (above the
 * Rank / Decks stats), opening that card's LigaMagic page in a new tab.
 *
 * Note: the card panel's price row (Card Kingdom/TCGplayer/Mana Pool) was
 * considered as the mount point instead, but it is a fixed-width row already
 * filled by its own items -- a 4th item there would pack edge-to-edge with no
 * gap rather than degrade gracefully. A separate line below the card avoids
 * squeezing anything.
 *
 * Depends on: overlay-utils.js (log factory, logNotShown, LIGAMAGIC_BASE,
 * applySamvButtonStyle, observeAndRerun, hasAddedNodeMatching) — shared with
 * the Archidekt/Moxfield/Scryfall overlays. Does NOT depend on
 * content-utils.js (different host, separate injection).
 */

const log = createLogger("EDHREC");

// EDHREC uses CSS Modules whose class names are "<hash>_<localName>" (e.g.
// "wz3HWa_cardFront"), with no component name and a hash that can change on
// any deploy -- so no selector here relies on a hashed class. The anchors
// are: the page's <h1> (the commander's name heading), the card element's
// data-cardfaces-* attributes (every card on the page carries at least one of
// them; the commander's sits in the <h1>'s header block, the rest are the
// recommendation grid), and, for the name, the "_cardFront" / "_name" local
// names, matched without their hash. The front face's name is used so a
// double-faced commander links to its front-face name.
//
// A partner pair's header renders two layouts, only one shown at a time: a
// single stacked card (data-cardfaces-variant="partner") and a side-by-side
// pair of plain cards (data-cardfaces-prices only). Hence both attributes in
// the selector and the visibility filter below; with two visible cards the
// last one in document order is the one drawn in front, so the button sits
// under it instead of under a card partly covered by it.
const SEL_CARD = "[data-cardfaces-variant], [data-cardfaces-prices]";
const SEL_CARD_FRONT_NAME = '[class*="_cardFront"] span[class*="_name"]';

const EDHREC_LIGAMAGIC_BTN_ID = "lm-ext-edhrec-ligamagic-btn";

function buildLigaMagicLine(url) {
  const wrap = document.createElement("div");
  wrap.id = EDHREC_LIGAMAGIC_BTN_ID;
  Object.assign(wrap.style, {
    display: "flex",
    justifyContent: "center",
    margin: "8px 0",
  });

  // Geometry matches the "Carregar filtro padrão" button injected on
  // LigaMagic's own "Compra por Lista" page (see injectLoadDefaultsButton in
  // lista-defaults.js) -- measured live via getComputedStyle on that
  // button's rendered `.botao` element (height 36px, padding 8px 15px,
  // border-radius 3px, font 700 12px arial/helvetica/sans-serif) since
  // EDHREC (React, CSS Modules) has no equivalent native class to borrow
  // for the shape, unlike overlay-moxfield.js's link, which reuses
  // Moxfield's own button class. Colors come from applySamvButtonStyle
  // (overlay-utils.js), the same helper every other injected button here
  // uses, including its hover swap to SAMV_PURPLE_HOVER.
  const link = document.createElement("a");
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.href = url;
  link.textContent = "Ver no LigaMagic";
  Object.assign(link.style, {
    display: "inline-block",
    boxSizing: "border-box",
    height: "36px",
    lineHeight: "18px",
    padding: "8px 15px",
    borderRadius: "3px",
    border: "1px solid transparent",
    fontSize: "12px",
    fontWeight: "700",
    fontFamily: "arial, helvetica, sans-serif",
    textDecoration: "none",
    whiteSpace: "nowrap",
  });
  applySamvButtonStyle(link);

  wrap.appendChild(link);
  return wrap;
}

/**
 * Idempotent by design (see the project's DOM-mutation-handling convention):
 * cheap to call on every qualifying mutation, since it just checks/repairs
 * what's already there instead of always rebuilding. Handles two distinct
 * cases the same page can hit:
 *   - the button was never added (first render, or React tore it out on a
 *     re-render because it isn't part of its own virtual tree);
 *   - the button already exists but the page navigated client-side to a
 *     different commander, reusing the same DOM subtree with a new card
 *     name -- the href needs updating, not just the button's presence.
 */
/** The commander's card element: the front-most visible card inside the
 * smallest ancestor of the page's <h1> that contains any card at all -- i.e.
 * the page header, not the recommendation grid further down. */
function findCommanderCard() {
  const heading = document.querySelector("h1");
  if (!heading) {
    logNotShown("EDHREC", "Ver no LigaMagic", "título <h1> da página não encontrado");
    return null;
  }
  let header = heading.parentElement;
  while (header && !header.querySelector(SEL_CARD)) header = header.parentElement;
  if (!header) {
    logNotShown("EDHREC", "Ver no LigaMagic", `nenhum card ("${SEL_CARD}") no cabeçalho do <h1> — página sem comandante?`);
    return null;
  }
  const visible = [...header.querySelectorAll(SEL_CARD)].filter((el) => el.getClientRects().length > 0);
  if (!visible.length) {
    logNotShown("EDHREC", "Ver no LigaMagic", "cards do cabeçalho existem, mas nenhum está visível");
    return null;
  }
  return visible[visible.length - 1];
}

function ensureLigaMagicButton() {
  const card = findCommanderCard();
  if (!card) return;
  const name = card.querySelector(SEL_CARD_FRONT_NAME)?.textContent.trim();
  if (!name) {
    logNotShown("EDHREC", "Ver no LigaMagic", `nome da face da frente ("${SEL_CARD_FRONT_NAME}") não encontrado no card`);
    return;
  }

  const url = LIGAMAGIC_BASE + encodeURIComponent(name);
  const existing = document.getElementById(EDHREC_LIGAMAGIC_BTN_ID);
  if (existing) {
    const link = existing.querySelector("a");
    if (link && link.href !== url) link.href = url;
    if (existing.previousElementSibling !== card) card.after(existing);
    return;
  }

  card.after(buildLigaMagicLine(url));
  log(`Link "Ver no LigaMagic" adicionado para "${name}".`);
}

function run() {
  chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
    if (chrome.runtime.lastError) {
      logNotShown("EDHREC", "Ver no LigaMagic", `erro ao ler configurações — ${chrome.runtime.lastError.message}`);
      return;
    }
    if (settings?.addEdhrecLigaMagicButton === false) {
      logNotShown("EDHREC", "Ver no LigaMagic", "desabilitado nas configurações (addEdhrecLigaMagicButton = false)");
      return;
    }

    observeAndRerun(
      (mutations) =>
        hasAddedNodeMatching(mutations, SEL_CARD) ||
        !document.getElementById(EDHREC_LIGAMAGIC_BTN_ID),
      ensureLigaMagicButton,
    );
  });
}

run();
