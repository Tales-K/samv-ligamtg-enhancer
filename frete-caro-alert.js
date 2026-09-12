/**
 * Highlights an expensive shipping fee on the "Compra por Lista" results
 * screen (gated by the "addFreteCaroAlert" setting) and shows a brief
 * floating message suggesting the store be blocked and the search redone.
 * "Expensive" is whatever value the user set in the popup (freteCaroLimiar,
 * default R$ 30).
 *
 * Reads straight from each store block's own visible shipping total
 * (#sum_frete_<bloco>, e.g. "R$ 26,90") -- the same value the user already
 * sees -- rather than a separate data fetch, since each block resolves it
 * asynchronously (behind LigaMagic's own "Calculando frete..." indicator) at
 * its own pace, independent of every other block.
 *
 * Depends on: content-utils.js (log, parsePrice, getSettings,
 * SAMV_FRETE_CARO_BG, SAMV_FRETE_CARO_TEXT, FRETE_CARO_LIMIAR_PADRAO),
 * lista-defaults.js (isListaCardsPage)
 */

const FRETE_CARO_TOAST_MS = 5000;
const SEL_SUM_FRETE = '[id^="sum_frete_"]';

/** Paints the shipping total itself as a filled, high-contrast badge. */
function aplicarEstiloFreteCaro(el) {
  el.style.setProperty("background", SAMV_FRETE_CARO_BG, "important");
  el.style.setProperty("color", SAMV_FRETE_CARO_TEXT, "important");
  el.style.setProperty("padding", "1px 6px", "important");
  el.style.setProperty("border-radius", "4px", "important");
  el.style.setProperty("display", "inline-block", "important");
}

/** A temporary floating message near `el`, gone after FRETE_CARO_TOAST_MS. */
function mostrarAvisoFreteCaro(el) {
  const aviso = document.createElement("div");
  aviso.textContent = "Frete caro, considere bloquear a loja e repesquisar";
  aviso.style.cssText = [
    // Document-relative (not "fixed"/viewport-relative): a 16-store results
    // page is easily taller than one screen, and the user can scroll while
    // this is still showing -- "fixed" would leave it floating in place
    // while the frete badge it's supposed to point at scrolls away under it.
    "position: absolute",
    "z-index: 10000",
    `background: ${SAMV_FRETE_CARO_BG}`,
    `color: ${SAMV_FRETE_CARO_TEXT}`,
    "padding: 6px 10px",
    "border-radius: 6px",
    "font-size: 12px",
    "font-weight: 600",
    "box-shadow: 0 2px 8px rgba(0,0,0,0.35)",
    "white-space: nowrap",
    "pointer-events: none",
  ].join(";");
  document.body.appendChild(aviso);

  const rect = el.getBoundingClientRect();
  aviso.style.left = `${Math.max(4, rect.left + window.scrollX)}px`;
  aviso.style.top = `${Math.max(4, rect.top + window.scrollY - aviso.offsetHeight - 6)}px`;

  setTimeout(() => aviso.remove(), FRETE_CARO_TOAST_MS);
}

/** Idempotent per element -- runs at most once per `#sum_frete_N` node. */
function processarFrete(el, limiar) {
  if (el.dataset.freteCaroChecked) return;
  const valor = parsePrice(el.textContent.replace("R$", "").trim());
  if (valor == null) return; // still "Calculando..." or genuinely empty -- try again on the next mutation

  el.dataset.freteCaroChecked = "1";
  if (valor > limiar) {
    aplicarEstiloFreteCaro(el);
    mostrarAvisoFreteCaro(el);
    log(`Frete caro detectado em ${el.id}: R$ ${valor.toFixed(2)} (limiar R$ ${limiar}).`);
  }
}

function initFreteCaroAlert() {
  if (typeof isListaCardsPage !== "function" || !isListaCardsPage()) return;

  getSettings().then((settings) => {
    if (settings?.addFreteCaroAlert === false) return;
    const limiar = Number(settings?.freteCaroLimiar) || FRETE_CARO_LIMIAR_PADRAO;

    const scan = () => document.querySelectorAll(SEL_SUM_FRETE).forEach((el) => processarFrete(el, limiar));
    scan();
    // Every store block resolves its own shipping fee independently and
    // whenever it's ready, replacing its own DOM -- watching the whole
    // results container catches each one as it lands. processarFrete's own
    // dataset guard keeps repeated scans over already-checked blocks cheap.
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  });
}

initFreteCaroAlert();
