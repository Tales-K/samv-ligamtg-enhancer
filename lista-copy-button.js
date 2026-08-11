/**
 * Injects a "Copiar Lista de Compras" button next to the site's own
 * "Finalizar Compra" button on the "Compra por Lista" results screen
 * (?view=cards/lista, after a search). Copies every card still in the
 * results to the clipboard in MTG list format ("<qty> <name>", one per
 * line), grouped by store under a "# <Loja>" comment line.
 *
 * Data source: the page's own `CardsOrcamento.item.resultado` (read via
 * background.js's getListaResultado — see there for why), NOT the results
 * table DOM. That object is the exact one the site's own per-card and
 * per-store "X" remove buttons mutate directly, so whatever the user has
 * already removed is reflected with no extra tracking on our side.
 *
 * Clicking the button opens a small panel of options, each remembered across
 * uses (settings.copyListaOptions) so it reopens the way it was last left:
 * four toggles for what to append to each line (edition, quality, language,
 * price), plus "Formato detalhado", which swaps the whole line format for
 * LigaMagic's own (see detailed-format.js) and therefore ignores the other
 * four.
 *
 * Depends on: content-utils.js (log, sendMessage, getSettings,
 * showCopiedFeedback, applySamvStyle), detailed-format.js (buildDetailedLine,
 * buildSectionedText, QUALIDADE_SIGLAS, IDIOMA_SIGLAS), lista-defaults.js
 * (isListaCardsPage)
 */

// Official LigaMagic idioma codes, same list as the "Idiomas" checkboxes in
// popup.html's "Compra por Lista" settings — abbreviated to match the
// EN/PT/PTEN/PH badges the results screen itself already shows per card.
const IDIOMA_LABELS = {
  1: "DE",
  2: "EN",
  3: "ES",
  4: "FR",
  5: "IT",
  6: "JP",
  7: "KR",
  8: "PT",
  9: "RU",
  10: "CT",
  11: "PTEN",
  12: "CS",
  16: "PH",
};

// ── Text building ─────────────────────────────────────────────────────────────
function formatCardLine(carta, options) {
  let line = `${carta.quantidade} ${carta.nomeInglesSA}`;
  if (options.versao && carta.sSigla) line += ` (${carta.sSigla.toUpperCase()})`;
  // Same M/NM/SP/... codes the detailed format uses, just upper-cased for
  // this more human-facing format.
  if (options.qualidade) line += ` [${QUALIDADE_SIGLAS[carta.iQualidade]?.toUpperCase() ?? "?"}]`;
  if (options.idioma) line += ` [${IDIOMA_LABELS[carta.iIdioma] ?? "?"}]`;
  if (options.preco) line += ` - R$ ${carta.precoTotal}`;
  return line;
}

/** Maps a result card onto the shape detailed-format.js expects. */
function detailedCardFromResultado(carta) {
  return {
    quantidade: carta.quantidade,
    // The detailed format is keyed on the Portuguese names.
    nome: carta.nomePortuguesSA,
    qualidade: QUALIDADE_SIGLAS[carta.iQualidade],
    edicao: carta.sSigla,
    idioma: IDIOMA_SIGLAS[carta.iIdioma],
    // Already label strings here ("Foil"), unlike the numeric codes the
    // cart's own selects use.
    extras: carta.extrasArray,
  };
}

/**
 * `resultado` is keyed by block index; `cartas` may have holes left by
 * removeItem's `delete`.
 *
 * Cards sitting at quantity 0 are left out. The results screen still lists
 * them — they're listings the search matched but ended up buying from
 * another store instead — and copying them would put "0 <card>" in a
 * shopping list that's meant to be bought or pasted back.
 */
function buildListaText(resultado, options) {
  const formatLine = options.detalhado
    ? (carta) => buildDetailedLine(detailedCardFromResultado(carta))
    : (carta) => formatCardLine(carta, options);

  const sections = Object.values(resultado)
    .filter(Boolean)
    .map((bloco) => ({
      title: bloco.nomeLoja,
      lines: bloco.cartas.filter((carta) => carta && carta.quantidade > 0).map(formatLine),
    }));

  return buildSectionedText(sections);
}

// ── Panel ─────────────────────────────────────────────────────────────────────
const OPTION_FIELDS = [
  { key: "versao", label: "Incluir versão" },
  { key: "qualidade", label: "Incluir qualidade" },
  { key: "idioma", label: "Incluir idioma" },
  { key: "preco", label: "Incluir preço" },
];

const DETALHADO_FIELD = {
  key: "detalhado",
  label: "Formato detalhado",
  title:
    "Copia no formato do próprio LigaMagic, fixando edição, qualidade, " +
    "idioma e extras de cada carta. Pode ser colado de volta na Compra por Lista.",
};

const checkboxRow = ({ key, label, title }, checked) => `
  <label title="${title ?? ""}" style="display: flex; align-items: center; gap: 6px; margin-bottom: 6px; cursor: pointer;">
    <input type="checkbox" class="lgm-copy-lista-opt" data-key="${key}" ${checked ? "checked" : ""}>
    ${label}
  </label>`;

function buildWrap(initialOptions) {
  const wrap = document.createElement("span");
  wrap.id = "lgm-copy-lista-wrap";
  // width: fit-content keeps the wrap hugging the button, so `margin: auto`
  // centres it under "Finalizar Compra" and the panel below still anchors to
  // the button's own left edge instead of the full column width.
  wrap.style.cssText =
    "position: relative; display: block; width: fit-content; margin: 12px auto 0 auto;";
  wrap.innerHTML = `
    <div class="botao" id="lgm-copy-lista-btn" style="cursor: pointer; display: inline-block;">Copiar Lista de Compras</div>
    <div id="lgm-copy-lista-panel" style="display: none; position: absolute; bottom: 100%; left: 0; margin-bottom: 6px;
      background: #fff; border: 1px solid #999; border-radius: 2px; padding: 10px; width: 190px; z-index: 50;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2); font-size: 12px;">
      ${checkboxRow(DETALHADO_FIELD, initialOptions[DETALHADO_FIELD.key])}
      <div id="lgm-copy-lista-extra-opts" style="border-top: 1px solid #ddd; margin: 8px 0; padding-top: 8px;">
        ${OPTION_FIELDS.map(({ key, label }) => checkboxRow({ key, label }, initialOptions[key])).join("")}
      </div>
      <div class="botao" id="lgm-copy-lista-confirm" style="cursor: pointer; text-align: center; margin-top: 4px;">Copiar</div>
    </div>
  `;
  return wrap;
}

function readOptionsFromPanel(panel) {
  const options = {};
  panel.querySelectorAll(".lgm-copy-lista-opt").forEach((el) => {
    options[el.dataset.key] = el.checked;
  });
  return options;
}

/**
 * The detailed format has a fixed line shape of its own, so the four
 * "incluir …" toggles have no effect while it's on — grey them out instead
 * of silently ignoring them.
 */
function syncPanelState(panel) {
  const detailedOn = panel.querySelector('[data-key="detalhado"]').checked;
  const extraOpts = panel.querySelector("#lgm-copy-lista-extra-opts");
  extraOpts.style.opacity = detailedOn ? "0.45" : "1";
  extraOpts.querySelectorAll("input").forEach((el) => (el.disabled = detailedOn));
}

async function handleCopyClick(wrap, button, panel) {
  const options = readOptionsFromPanel(panel);
  sendMessage({ action: "saveSettings", settings: { copyListaOptions: options } });

  const resultado = await sendMessage({ action: "getListaResultado" });
  if (!resultado || Object.keys(resultado).length === 0) {
    log("Copiar Lista: nenhum resultado de busca encontrado.");
    panel.style.display = "none";
    return;
  }

  const text = buildListaText(resultado, options);
  if (!text) {
    log("Copiar Lista: nenhuma carta com quantidade maior que zero no resultado.");
    panel.style.display = "none";
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    log("Copiar Lista: falha ao copiar para a área de transferência —", err.message);
    return;
  }

  panel.style.display = "none";
  showCopiedFeedback(button);
  log(`Lista de compras copiada (${text.split("\n").filter((l) => l && !l.startsWith("#")).length} carta(s)).`);
}

function injectCopyListaButton(initialOptions) {
  if (document.getElementById("lgm-copy-lista-wrap")) return true;

  // Appended as a sibling of the two existing buttons, inside their own
  // column div — not the outer `.row` — so it doesn't disturb the site's
  // own Bootstrap-style grid layout.
  const finalizarBtn = document.getElementById("btn-finalizar");
  if (!finalizarBtn) return false;

  const wrap = buildWrap(initialOptions);
  finalizarBtn.parentElement.appendChild(wrap);

  const button = wrap.querySelector("#lgm-copy-lista-btn");
  const panel = wrap.querySelector("#lgm-copy-lista-panel");
  applySamvStyle(button);
  // The panel's own confirm button is ours too, so it gets the same colour
  // rather than sitting there in the site's default styling.
  applySamvStyle(wrap.querySelector("#lgm-copy-lista-confirm"));

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });

  panel
    .querySelector('[data-key="detalhado"]')
    .addEventListener("change", () => syncPanelState(panel));
  syncPanelState(panel);

  wrap.querySelector("#lgm-copy-lista-confirm").addEventListener("click", (event) => {
    event.stopPropagation();
    handleCopyClick(wrap, button, panel);
  });

  log('Injected "Copiar Lista de Compras" button.');
  return true;
}

/**
 * Registered once, independent of injection/re-injection: looks up the
 * current panel by ID rather than closing over a specific element, so it
 * keeps working correctly across "Pesquisar Novamente" re-injections
 * instead of leaking a stale listener per re-search.
 */
function closePanelOnOutsideClick(event) {
  const wrap = document.getElementById("lgm-copy-lista-wrap");
  const panel = document.getElementById("lgm-copy-lista-panel");
  if (panel && wrap && !wrap.contains(event.target)) panel.style.display = "none";
}

function initCopyListaButton() {
  if (!isListaCardsPage()) return;

  getSettings().then((settings) => {
    if (settings?.addCopyListaButton === false) return;
    const options = settings.copyListaOptions ?? {};

    document.addEventListener("click", closePanelOnOutsideClick);

    if (injectCopyListaButton(options)) return;

    // Results only exist after the user searches, and "Pesquisar Novamente"
    // replaces the whole results section wholesale (removing our button
    // along with it) — unlike the rest of this codebase's one-shot
    // waitForElement() uses, this keeps watching for the page's whole
    // lifetime so the button comes back after every re-search.
    new MutationObserver(() => injectCopyListaButton(options)).observe(document.body, {
      childList: true,
      subtree: true,
    });
  });
}

initCopyListaButton();
