/**
 * The "what to copy" dropdown shared by every copy button in this extension.
 *
 * Originally lived inside lista-copy-button.js; the purchases screen needs the
 * very same panel (same toggles, same "Formato detalhado" rule, same saved
 * preferences), so it lives here instead of being duplicated. Each caller
 * passes its own id prefix and its own absolute-position rule, since the
 * Compra por Lista button sits at the bottom of a column and opens upward
 * while an order card's button sits at the top right and opens downward.
 *
 * The options object is the same shape both callers persist as
 * `settings.copyListaOptions`, so the two screens stay in sync by default.
 *
 * Depends on: content-utils.js (applySamvStyle).
 */

const COPY_OPTION_FIELDS = [
  { key: "versao", label: "Incluir versão" },
  { key: "qualidade", label: "Incluir qualidade" },
  { key: "idioma", label: "Incluir idioma" },
  { key: "preco", label: "Incluir preço" },
];

const COPY_DETALHADO_FIELD = {
  key: "detalhado",
  label: "Formato detalhado",
  title:
    "Copia no formato do próprio LigaMagic, fixando edição, qualidade, " +
    "idioma e extras de cada carta. Pode ser colado de volta na Compra por Lista.",
};

const COPY_OPT_CLASS = "lgm-copy-opt";
const COPY_EXTRA_OPTS_CLASS = "lgm-copy-extra-opts";

function copyCheckboxRow({ key, label, title }, checked) {
  return `
  <label title="${title ?? ""}" style="display: flex; align-items: center; gap: 6px; margin-bottom: 6px; cursor: pointer;">
    <input type="checkbox" class="${COPY_OPT_CLASS}" data-key="${key}" ${checked ? "checked" : ""}>
    ${label}
  </label>`;
}

/**
 * The panel's markup. `posicaoCss` places it relative to the wrapper the
 * caller anchors it in (which must be `position: relative`).
 */
function copyOptionsPanelHTML(prefix, initialOptions, posicaoCss) {
  return `
    <div id="${prefix}-panel" style="display: none; position: absolute; ${posicaoCss}
      background: #fff; border: 1px solid #999; border-radius: 2px; padding: 10px; width: 190px; z-index: 50;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2); font-size: 12px; text-align: left; color: #333; font-weight: normal;">
      ${copyCheckboxRow(COPY_DETALHADO_FIELD, initialOptions[COPY_DETALHADO_FIELD.key])}
      <div class="${COPY_EXTRA_OPTS_CLASS}" style="border-top: 1px solid #ddd; margin: 8px 0; padding-top: 8px;">
        ${COPY_OPTION_FIELDS.map(({ key, label }) => copyCheckboxRow({ key, label }, initialOptions[key])).join("")}
      </div>
      <div class="botao" id="${prefix}-confirm" style="cursor: pointer; text-align: center; margin-top: 4px;">Copiar</div>
    </div>`;
}

function readCopyOptions(panel) {
  const options = {};
  panel.querySelectorAll(`.${COPY_OPT_CLASS}`).forEach((el) => {
    options[el.dataset.key] = el.checked;
  });
  return options;
}

/**
 * The detailed format has a fixed line shape of its own, so the four
 * "incluir …" toggles have no effect while it's on — grey them out instead
 * of silently ignoring them.
 */
function syncCopyOptionsPanel(panel) {
  const detailedOn = panel.querySelector('[data-key="detalhado"]').checked;
  const extraOpts = panel.querySelector(`.${COPY_EXTRA_OPTS_CLASS}`);
  extraOpts.style.opacity = detailedOn ? "0.45" : "1";
  extraOpts.querySelectorAll("input").forEach((el) => (el.disabled = detailedOn));
}

/**
 * Wires the panel's own controls. `onConfirm(options)` runs on the confirm
 * button; closing the panel afterwards is left to the caller, which knows
 * whether the copy succeeded.
 */
function wireCopyOptionsPanel(panel, confirmBtn, onConfirm) {
  applySamvStyle(confirmBtn);
  panel
    .querySelector('[data-key="detalhado"]')
    .addEventListener("change", () => syncCopyOptionsPanel(panel));
  syncCopyOptionsPanel(panel);
  confirmBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    onConfirm(readCopyOptions(panel));
  });
}
