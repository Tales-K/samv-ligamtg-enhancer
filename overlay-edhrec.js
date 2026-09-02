/**
 * EDHREC — adds a "Ver no LigaMagic" link to a commander page's card panel,
 * as its own line above "Rank #..." / "N decks", opening that card's
 * LigaMagic page in a new tab.
 *
 * Note: the card panel's price row (Card Kingdom/TCGplayer/Mana Pool) was
 * considered as the mount point instead, but confirmed live to be a
 * fixed-width flex row already exactly filled by its 3 existing items
 * (justify-content: space-around with zero free space left) -- a 4th item
 * there would pack edge-to-edge with no gap rather than degrade gracefully.
 * The rank/deck-count area below it is a shrink-to-fit flex column instead,
 * so an extra line just adds itself without squeezing anything.
 *
 * Depends on: overlay-utils.js (log factory, logNotShown, SAMV_PURPLE,
 * SAMV_PURPLE_HOVER, LIGAMAGIC_BASE, observeAndRerun, hasAddedNodeMatching)
 * — shared with the Archidekt/Moxfield/Scryfall overlays. Does NOT depend on
 * content-utils.js (different host, separate injection).
 */

const log = createLogger("EDHREC");

// EDHREC (Next.js) uses CSS Modules — class names have hash suffixes that can
// change between deploys. Matched on the stable semantic prefix with
// [class*=...], same technique already used for Archidekt. The new line's
// own layout is inlined rather than borrowing CardLabel_line's hashed class,
// so it keeps working even if that class disappears in a future deploy.
const SEL_CARD_PANEL = '[class*="CardPanel_container__"]';
const SEL_LABEL_CONTAINER = '[class*="CardLabel_container__"]';
const SEL_CARD_NAME = '[class*="Card_name__"]';

const EDHREC_LIGAMAGIC_BTN_ID = "lm-ext-edhrec-ligamagic-btn";

function buildLigaMagicLine(url) {
  const wrap = document.createElement("div");
  wrap.id = EDHREC_LIGAMAGIC_BTN_ID;
  Object.assign(wrap.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "4px",
  });

  const link = document.createElement("a");
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.href = url;
  link.textContent = "Ver no LigaMagic";
  Object.assign(link.style, {
    fontSize: "16px",
    textDecoration: "none",
    color: SAMV_PURPLE,
  });
  link.addEventListener("mouseenter", () => (link.style.color = SAMV_PURPLE_HOVER));
  link.addEventListener("mouseleave", () => (link.style.color = SAMV_PURPLE));

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
function ensureLigaMagicButton() {
  const panel = document.querySelector(SEL_CARD_PANEL);
  if (!panel) {
    logNotShown("EDHREC", "Ver no LigaMagic", `painel do card ("${SEL_CARD_PANEL}") não encontrado`);
    return;
  }
  const labelContainer = panel.querySelector(SEL_LABEL_CONTAINER);
  if (!labelContainer) {
    logNotShown("EDHREC", "Ver no LigaMagic", `área de rank/decks ("${SEL_LABEL_CONTAINER}") não encontrada no painel`);
    return;
  }
  const name = panel.querySelector(SEL_CARD_NAME)?.textContent.trim();
  if (!name) {
    logNotShown("EDHREC", "Ver no LigaMagic", `nome do card ("${SEL_CARD_NAME}") não encontrado no painel`);
    return;
  }

  const url = LIGAMAGIC_BASE + encodeURIComponent(name);
  const existing = document.getElementById(EDHREC_LIGAMAGIC_BTN_ID);
  if (existing) {
    const link = existing.querySelector("a");
    if (link && link.href !== url) link.href = url;
    if (!labelContainer.contains(existing)) labelContainer.prepend(existing);
    return;
  }

  labelContainer.prepend(buildLigaMagicLine(url));
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
        hasAddedNodeMatching(mutations, SEL_LABEL_CONTAINER) ||
        hasAddedNodeMatching(mutations, SEL_CARD_NAME) ||
        !document.getElementById(EDHREC_LIGAMAGIC_BTN_ID),
      ensureLigaMagicButton,
    );
  });
}

run();
