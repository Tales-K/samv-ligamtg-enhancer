/**
 * Adds a "Remover Características" text link to the left of the site's own
 * "Detalhar Características" link, on the "Compra por Lista" page
 * (?view=cards/lista). Clicking it strips every per-card characteristic in
 * brackets from each line of the card list textarea, keeping quantity and
 * name:
 *
 *   1 Fractius do Poder [EDICAO=CMM][QUALIDADE=NM]  ->  1 Fractius do Poder
 *
 * Purely a local edit of the textarea -- nothing is sent anywhere. The edit
 * is announced to the page with the same events a user's typing produces
 * (input/change, then blur, which is what the site's own card counter
 * listens to), so its listeners see the new text exactly as if typed.
 *
 * Styled like the native link (its font metrics are copied from it, not
 * hardcoded) but in the SAMV purple, and inserted inside the native link's
 * own wrapper, so it shows and hides together with it when the page switches
 * between simple and detailed search.
 *
 * Depends on: content-utils.js (log, logNotShown, waitForElement,
 * SAMV_PURPLE, SAMV_PURPLE_HOVER, showCopiedFeedback), lista-defaults.js
 * (isListaCardsPage)
 */

const CLEAR_CARAC_ID = "lgm-clear-caracteristicas";
const SEL_DETALHAR_LINK = ".change-input-type-btn-simple-wrapper .change-input-type-btn-simple";
const SEL_CARD_LIST = "textarea#card_list";

/** One "[KEY=VALUE]" characteristic, plus the whitespace in front of it. */
const CARACTERISTICA_RE = /\s*\[[^\]\n]*\]/g;

/** Every line without its bracketed characteristics; other text untouched. */
function stripCaracteristicas(text) {
  return text
    .split("\n")
    .map((line) => (line.includes("[") ? line.replace(CARACTERISTICA_RE, "").trimEnd() : line))
    .join("\n");
}

function clearCaracteristicas(link) {
  const textarea = document.querySelector(SEL_CARD_LIST);
  if (!textarea) {
    logNotShown("Remover Características", `lista de cards ("${SEL_CARD_LIST}") não encontrada no clique`);
    return;
  }
  const cleaned = stripCaracteristicas(textarea.value);
  if (cleaned === textarea.value) {
    showCopiedFeedback(link, "Nada para remover");
    return;
  }

  textarea.value = cleaned;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
  textarea.dispatchEvent(new FocusEvent("blur"));
  showCopiedFeedback(link, "Características removidas");
  log("Características removidas da lista de cards.");
}

function buildClearLink(nativeLink) {
  const native = getComputedStyle(nativeLink);
  const link = document.createElement("span");
  link.id = CLEAR_CARAC_ID;
  link.textContent = "Remover Características";
  link.title = "Remove as características ([EDICAO=...], [QUALIDADE=...] etc.) de todas as linhas, mantendo quantidade e nome";
  Object.assign(link.style, {
    display: "block",
    marginRight: "16px",
    cursor: "pointer",
    color: SAMV_PURPLE,
    fontSize: native.fontSize,
    fontFamily: native.fontFamily,
    fontWeight: native.fontWeight,
    lineHeight: native.lineHeight,
    textDecorationLine: native.textDecorationLine,
  });
  link.addEventListener("mouseenter", () => (link.style.color = SAMV_PURPLE_HOVER));
  link.addEventListener("mouseleave", () => (link.style.color = SAMV_PURPLE));
  link.addEventListener("click", () => clearCaracteristicas(link));
  return link;
}

function tryInjectClearCaracteristicas() {
  if (document.getElementById(CLEAR_CARAC_ID)) return true;
  const nativeLink = document.querySelector(SEL_DETALHAR_LINK);
  if (!nativeLink || !document.querySelector(SEL_CARD_LIST)) return false;
  nativeLink.before(buildClearLink(nativeLink));
  log('Injected "Remover Características" link.');
  return true;
}

function initClearCaracteristicas() {
  if (!isListaCardsPage()) return;
  chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
    if (settings?.addClearCaracteristicasButton === false) {
      logNotShown("Remover Características", "desabilitado nas configurações (addClearCaracteristicasButton = false)");
      return;
    }
    const TIMEOUT_MS = 15_000;
    waitForElement(tryInjectClearCaracteristicas, TIMEOUT_MS);
    setTimeout(() => {
      if (!document.getElementById(CLEAR_CARAC_ID)) {
        logNotShown(
          "Remover Características",
          `link nativo ("${SEL_DETALHAR_LINK}") ou lista de cards ("${SEL_CARD_LIST}") não apareceu na página`,
        );
      }
    }, TIMEOUT_MS);
  });
}

initClearCaracteristicas();
