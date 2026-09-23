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
 * buildSectionedText, buildStoreSectionTitle, QUALIDADE_SIGLAS,
 * IDIOMA_SIGLAS), lista-defaults.js (isListaCardsPage)
 */

const COPY_LISTA_PREFIX = "lgm-copy-lista";

// ── Text building ─────────────────────────────────────────────────────────────
/** Resolves this screen's numeric codes, then defers to the shared builder. */
function formatCardLine(carta, options) {
  return buildSimpleLine(
    {
      quantidade: carta.quantidade,
      nome: carta.nomeInglesSA,
      edicao: carta.sSigla,
      qualidade: QUALIDADE_SIGLAS[carta.iQualidade],
      idioma: IDIOMA_LABELS[carta.iIdioma],
      preco: carta.precoTotal,
    },
    options,
  );
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
function buildListaText(resultado, options, storeCache) {
  const formatLine = options.detalhado
    ? (carta) => buildDetailedLine(detailedCardFromResultado(carta))
    : (carta) => formatCardLine(carta, options);

  const sections = Object.values(resultado)
    .filter(Boolean)
    .map((bloco) => ({
      title: buildStoreSectionTitle(bloco.nomeLoja, bloco.loja, storeCache),
      lines: bloco.cartas.filter((carta) => carta && carta.quantidade > 0).map(formatLine),
    }));

  return buildSectionedText(sections);
}

// ── Panel ─────────────────────────────────────────────────────────────────────
function buildWrap(initialOptions) {
  const wrap = document.createElement("span");
  wrap.id = "lgm-copy-lista-wrap";
  // Full width, same 10px top gap as the rest of this button stack (see
  // ANALISE_BOTAO_GAP in analise-economia.js) -- the dropdown panel below
  // still anchors to the button's own left edge (left: 0 on the panel),
  // now just a wider one.
  wrap.style.cssText = "position: relative; display: block; width: 100%; box-sizing: border-box; margin-top: 10px;";
  wrap.innerHTML = `
    <div class="botao" id="lgm-copy-lista-btn" style="cursor: pointer; display: block; width: 100%; box-sizing: border-box; text-align: center;">Copiar Lista de Compras</div>
    ${copyOptionsPanelHTML(COPY_LISTA_PREFIX, initialOptions, "bottom: 100%; left: 0; margin-bottom: 6px;")}
  `;
  return wrap;
}

async function handleCopyClick(button, panel, options) {
  sendMessage({ action: "saveSettings", settings: { copyListaOptions: options } });

  const [resultado, storeCache] = await Promise.all([
    sendMessage({ action: "getListaResultado" }),
    sendMessage({ action: "getStoreCache" }),
  ]);
  if (!resultado || Object.keys(resultado).length === 0) {
    log("Copiar Lista: nenhum resultado de busca encontrado.");
    panel.style.display = "none";
    return;
  }

  const text = buildListaText(resultado, options, storeCache);
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
  const panel = wrap.querySelector(`#${COPY_LISTA_PREFIX}-panel`);
  applySamvStyle(button);

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });

  wireCopyOptionsPanel(panel, wrap.querySelector(`#${COPY_LISTA_PREFIX}-confirm`), (options) =>
    handleCopyClick(button, panel, options),
  );

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
