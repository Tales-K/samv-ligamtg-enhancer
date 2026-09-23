/**
 * "Copiar" button on each order of the purchases screen — ?view=mp/compras
 *
 * An order card there holds one ".row.infovendas" summary per store, each
 * followed by an ".infovenda-cards" container the site fills in on demand.
 * The button copies every card of that order grouped by store, through the
 * same panel, the same option set and the same line builders the Compra por
 * Lista copy uses (copy-options-panel.js and detailed-format.js), so a list
 * copied here and one copied there look alike and paste back alike.
 *
 * Loading a store's items goes through the background worker, which runs the
 * page's own sale.getItens in the MAIN world (see handleLoadPedidoItens).
 * That fills the container without touching its visibility, so copying never
 * opens or closes an order, and it also covers the orders placed on a store's
 * own shop — those have the same container but no "Visualizar Itens" control
 * to drive.
 *
 * Depends on: content-utils.js (log, logNotShown, getSettings, sendMessage,
 * waitForElement, applySamvStyle, showCopiedFeedback, cardNameFromHref),
 * detailed-format.js (buildSimpleLine, buildDetailedLine, buildSectionedText,
 * buildStoreSectionTitle, idiomaTokenFromLabel) and copy-options-panel.js.
 */

// ── Page detection ────────────────────────────────────────────────────────────
function isComprasPage() {
  return new URLSearchParams(window.location.search).get("view") === "mp/compras";
}

// Deliberately NOT scoped to "#tab-pedidos": the site's "Exibir mais compras"
// appends each further page straight into #main-compras, as a sibling of that
// block, so anchoring on it would permanently miss every card past the first
// page. Cards that aren't orders (the "aguardando avaliação" box) are filtered
// out by injectCopiarNoCard, which requires an items container.
const SEL_PEDIDO_CARD = "div.boxshadow.conteudo.box-interna";
const SEL_LISTA_PEDIDOS = "#main-compras";
const SEL_LOJA_ROW = ".row.infovendas";
const SEL_ITENS_CONTAINER = "infovenda-cards";
// The sale code the site keys a store's items on lives in the container's own
// id ("venda_<cod>"), which is the only place it's exposed on orders that have
// no "Visualizar Itens" control carrying it in an onclick.
const RE_COD_DA_LOJA = /^venda_(\d+)$/;
const COPY_PEDIDO_PROCESSED_ATTR = "data-lgm-copy-pedido";
const COPY_PEDIDO_WRAP_CLASS = "lgm-copy-pedido-wrap";
const PAGINACAO_DEBOUNCE_MS = 150;

/**
 * Stores in a single order. Copying loads the ones not in the DOM yet, one
 * request each — the same request the site itself makes, and one it skips
 * entirely for a store already loaded (the page caches those, and hiding a
 * store never clears its markup). The ceiling is here only so a malformed
 * card can never turn that bounded, click-initiated work into an open-ended
 * loop.
 */
const MAX_LOJAS_POR_PEDIDO = 12;
const ITENS_TIMEOUT_MS = 15_000;
const ITENS_POLL_MS = 150;

/** Shared with the Compra por Lista button, so both screens copy alike. */
let copyPedidoOptions = {};
let copyPedidoSeq = 0;

// ── Reading one order ─────────────────────────────────────────────────────────
/** The items container the site renders immediately after a store's row. */
function itensContainerDaLoja(lojaRow) {
  const proximo = lojaRow.nextElementSibling;
  return proximo?.classList.contains(SEL_ITENS_CONTAINER) ? proximo : null;
}

/** The sale code the site keys this store's items on. */
function codDaLoja(container) {
  return container?.id.match(RE_COD_DA_LOJA)?.[1] ?? null;
}

/**
 * The stores of this order whose items the site can fill in. Keyed on the
 * container rather than on "Visualizar Itens": orders placed on a store's own
 * shop have no such control, but do have the container.
 */
function lojasDoPedido(card) {
  return [...card.querySelectorAll(SEL_LOJA_ROW)].filter((linha) =>
    codDaLoja(itensContainerDaLoja(linha)),
  );
}

function itensCarregados(container) {
  return !!container?.querySelector("p.cardtitle a");
}

function esperarItens(container) {
  return new Promise((resolve) => {
    const inicio = Date.now();
    const tentar = () => {
      if (itensCarregados(container)) return resolve(true);
      if (Date.now() - inicio > ITENS_TIMEOUT_MS) return resolve(false);
      setTimeout(tentar, ITENS_POLL_MS);
    };
    tentar();
  });
}

/**
 * Loads the stores of this order whose items aren't in the DOM yet, one at a
 * time. Whether a store still needs loading is read off the page itself —
 * the container either already holds card rows or it doesn't — so nothing
 * here has to track state of its own, and a store the user opened earlier
 * (or opened and closed again, which only hides it) is skipped for free.
 */
async function garantirItensDoPedido(card) {
  const linhas = lojasDoPedido(card);
  if (linhas.length > MAX_LOJAS_POR_PEDIDO) {
    log(
      `Pedido com ${linhas.length} loja(s), acima do teto de ${MAX_LOJAS_POR_PEDIDO} — cópia cancelada.`,
    );
    return { linhas: [], excedeu: true };
  }
  for (const linha of linhas) {
    const container = itensContainerDaLoja(linha);
    if (itensCarregados(container)) continue;
    const resposta = await sendMessage({
      action: "loadPedidoItens",
      cod: codDaLoja(container),
    });
    if (resposta?.error) {
      log(`Não consegui carregar os itens da loja ${codDaLoja(container)}: ${resposta.error}`);
      continue;
    }
    await esperarItens(container);
  }
  return { linhas, excedeu: false };
}

function nomeDaLoja(linha) {
  // The store block also carries a verified-store badge and an external link;
  // "label.title" is the element holding just the name.
  return linha.querySelector(".venda-store label.title")?.textContent.trim() || "Loja";
}

const semWww = (host) => String(host ?? "").toLowerCase().replace(/^www\./, "");

/**
 * This screen never exposes a store id — no "mpuser.getStore(<id>)" anywhere
 * on it, unlike the marketplace pages. What it does expose is a link to the
 * store's own shop, and the extension's store cache is keyed by id with the
 * domain alongside, so the id comes back from matching on that domain.
 * Returns null when the store isn't in the cache yet, which just means the
 * section title carries the name alone.
 */
function idDaLojaPorDominio(linha, storeCache) {
  const link = linha.querySelector(".venda-store label.aux a")?.href;
  if (!link) return null;
  let host;
  try {
    host = semWww(new URL(link).hostname);
  } catch {
    return null;
  }
  const loja = Object.values(storeCache ?? {}).find((s) => s?.domain && semWww(s.domain) === host);
  return loja?.id ?? null;
}

/**
 * One item row, with every field already in the display form the shared line
 * builders expect. The English name and the set code both come off the link's
 * own query string rather than out of the rendered label, which shows the two
 * names joined as "<português> / <english>".
 */
function dadosDoItem(link) {
  const href = link.getAttribute("href");
  const linha = link.closest(".row");
  const extras = linha?.querySelector("#carrinho-extras");
  let edicao = null;
  try {
    edicao = new URL(href, window.location.href).searchParams.get("ed");
  } catch {
    edicao = null;
  }
  return {
    nome: cardNameFromHref(href),
    edicao,
    quantidade: parseInt(linha?.querySelector(".item-estoque")?.textContent ?? "", 10) || 1,
    qualidade: extras?.querySelector("[qualitycard]")?.textContent.trim() || null,
    // The flag cell carries the icon; the badge itself is the label beside it.
    idioma: extras?.querySelector("[languagecard]")?.nextElementSibling?.textContent.trim() || null,
    preco: linha?.querySelector(".item-xs-total")?.textContent.trim().replace(/^R\$\s*/, "") || null,
  };
}

function linhasDosItens(container, options) {
  return [...container.querySelectorAll("p.cardtitle a")]
    .map((link) => {
      const item = dadosDoItem(link);
      if (!item.nome) return null;
      if (!options.detalhado) return buildSimpleLine(item, options);
      return buildDetailedLine({
        quantidade: item.quantidade,
        // The site's list parser takes the name in either Portuguese or
        // English, so the English one read from the link is used here too.
        nome: item.nome,
        qualidade: item.qualidade,
        edicao: item.edicao,
        // Screen badge -> parser token: the two differ for some languages,
        // so this goes through the shared idioma code rather than reusing
        // the badge text directly.
        idioma: idiomaTokenFromLabel(item.idioma),
      });
    })
    .filter(Boolean);
}

// ── Copy ──────────────────────────────────────────────────────────────────────
async function handleCopiarPedidoClick(card, button, panel, options) {
  if (button.disabled) return;
  sendMessage({ action: "saveSettings", settings: { copyListaOptions: options } });
  copyPedidoOptions = options;

  button.disabled = true;
  button.textContent = "Carregando...";
  panel.style.display = "none";

  try {
    const [{ linhas, excedeu }, storeCache] = await Promise.all([
      garantirItensDoPedido(card),
      sendMessage({ action: "getStoreCache" }),
    ]);
    if (excedeu) {
      showCopiedFeedback(button, "Pedido grande demais");
      return;
    }

    const secoes = linhas.map((linha) => {
      const container = itensContainerDaLoja(linha);
      return {
        title: buildStoreSectionTitle(
          nomeDaLoja(linha),
          idDaLojaPorDominio(linha, storeCache),
          storeCache,
        ),
        lines: container ? linhasDosItens(container, options) : [],
      };
    });

    const texto = buildSectionedText(secoes);
    if (!texto) {
      showCopiedFeedback(button, "Nada para copiar");
      log("Pedido sem itens legíveis — nada copiado.");
      return;
    }

    await navigator.clipboard.writeText(texto);
    showCopiedFeedback(button);
    const nCartas = texto.split("\n").filter((l) => l && !l.startsWith("#")).length;
    log(`Pedido copiado (${secoes.length} loja(s), ${nCartas} carta(s)).`);
  } catch (erro) {
    showCopiedFeedback(button, "Erro ao copiar");
    log(`Falha ao copiar o pedido: ${erro}`);
  } finally {
    button.disabled = false;
  }
}

// ── Injection ─────────────────────────────────────────────────────────────────
/**
 * The site puts "Avaliar Lojas" in a ".survey-post" block floated to the top
 * right of the card, but only on orders that still have a store to rate. On
 * every other order that block simply isn't rendered, so an equivalent one is
 * created in the same position — that way the button sits in one consistent
 * place, and to the left of "Avaliar Lojas" wherever that exists.
 */
function slotDoBotaoCopiar(card) {
  const survey = card.querySelector(":scope > .survey-post");
  if (survey) return survey;
  const slot = document.createElement("div");
  slot.className = "lgm-copy-pedido-slot";
  slot.style.cssText = "float: right;";
  card.insertBefore(slot, card.firstChild);
  return slot;
}

/** Returns true only when this call is the one that added the button. */
function injectCopiarNoCard(card) {
  if (card.getAttribute(COPY_PEDIDO_PROCESSED_ATTR)) return false;
  // Only orders that expose an items container at all — without one there is
  // nothing to fill and nothing to copy. This is also what keeps the button
  // off the "Pedidos aguardando sua avaliação" box, which shares the card
  // markup but lists no items.
  if (lojasDoPedido(card).length === 0) return false;
  card.setAttribute(COPY_PEDIDO_PROCESSED_ATTR, "1");

  // Every order on screen gets its own panel, so the ids have to be unique
  // per card rather than fixed like the single-button screens use.
  const prefix = `lgm-copy-pedido-${(copyPedidoSeq += 1)}`;
  const wrap = document.createElement("span");
  wrap.className = COPY_PEDIDO_WRAP_CLASS;
  // The panel is absolutely positioned against this wrapper, not against the
  // site's own float-right block, so nothing of the site's layout is restyled.
  wrap.style.cssText = "position: relative; display: inline-block;";
  wrap.innerHTML = `
    <button type="button" class="botao lgm-copy-pedido-btn" title="Copiar as cartas deste pedido, agrupadas por loja"
      style="cursor: pointer; margin-right: 8px; line-height: normal;">Copiar</button>
    ${copyOptionsPanelHTML(prefix, copyPedidoOptions, "top: 100%; right: 8px; margin-top: 6px;")}
  `;

  const button = wrap.querySelector(".lgm-copy-pedido-btn");
  // Pinned up front so the loading/feedback labels can never be mistaken for
  // the button's resting label (see showCopiedFeedback).
  button.dataset.originalLabel = "Copiar";
  applySamvStyle(button);

  const panel = wrap.querySelector(`#${prefix}-panel`);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });
  wireCopyOptionsPanel(panel, wrap.querySelector(`#${prefix}-confirm`), (options) =>
    handleCopiarPedidoClick(card, button, panel, options),
  );

  const slot = slotDoBotaoCopiar(card);
  slot.insertBefore(wrap, slot.firstChild);
  return true;
}

function injectComprasCopyButtons() {
  const cards = [...document.querySelectorAll(SEL_PEDIDO_CARD)];
  if (cards.length === 0) {
    logNotShown('Botão "Copiar" dos pedidos', `nenhum card casou com "${SEL_PEDIDO_CARD}"`);
    return false;
  }
  const novos = cards.filter(injectCopiarNoCard).length;
  if (novos > 0) log(`Botão "Copiar" adicionado a ${novos} pedido(s).`);
  return true;
}

/** One listener for every card's panel, looked up live rather than closed over. */
function fecharPaineisPedidoAoClicarFora(event) {
  document.querySelectorAll(`.${COPY_PEDIDO_WRAP_CLASS}`).forEach((wrap) => {
    if (wrap.contains(event.target)) return;
    const panel = wrap.querySelector('[id$="-panel"]');
    if (panel) panel.style.display = "none";
  });
}

/**
 * Each further page of orders is appended directly to #main-compras, so a
 * childList observer on that single node catches them without subtree:true.
 * The button is written *inside* a card, never as a direct child of
 * #main-compras, so this observer structurally cannot see its own writes and
 * feed back into itself.
 *
 * content-utils.js's observarMudancasNaLista isn't reused here on purpose: its
 * mutation filter looks for the Compra por Lista result rows, which never
 * appear on this screen, and it watches document.body with subtree:true —
 * both wider and wrong for this case.
 */
function observarPaginacaoDePedidos() {
  const lista = document.querySelector(SEL_LISTA_PEDIDOS);
  if (!lista) {
    logNotShown('Botão "Copiar" nas páginas seguintes', `"${SEL_LISTA_PEDIDOS}" não encontrado`);
    return;
  }
  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(injectComprasCopyButtons, PAGINACAO_DEBOUNCE_MS);
  }).observe(lista, { childList: true });
}

function initComprasCopyButton() {
  if (!isComprasPage()) return;

  getSettings().then((settings) => {
    if (settings?.addComprasCopyButton === false) return;
    copyPedidoOptions = settings.copyListaOptions ?? {};

    document.addEventListener("click", fecharPaineisPedidoAoClicarFora);

    // The first page ships in the HTML already, just hidden behind the site's
    // own "Visualizar todos meus pedidos" toggle, so those buttons can be
    // placed right away and are there the moment the list is revealed. Later
    // pages arrive only when the user asks for them.
    waitForElement(injectComprasCopyButtons);
    // #main-compras is server-rendered, so this doesn't need to wait on
    // anything; if it's ever missing, observarPaginacaoDePedidos logs why.
    observarPaginacaoDePedidos();
  });
}

initComprasCopyButton();
