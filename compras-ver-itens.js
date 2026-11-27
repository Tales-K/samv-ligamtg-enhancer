/**
 * Purchases screen (?view=mp/compras) tweaks:
 *
 *   - Opens straight on the order list. When there are orders waiting for a
 *     store review, the site first shows only that box, with the list behind
 *     its own "Visualizar todos meus pedidos" button; that button is clicked
 *     on load (gated by "skipPedidosAvaliacao"). It only switches which part
 *     of the already-loaded page is visible -- nothing is requested.
 *
 *   - Adds a purple "Visualizar Itens" under "Visualizar Pedido" on orders
 *     placed on a store's own shop (gated by "addVerItensPedidoLoja"). Those
 *     orders have the same hidden items container as every other order
 *     ("#venda_<cod>") but only a link to the store's site instead of the
 *     site's own "Visualizar Itens" toggle. This one opens and closes that
 *     container the same way, loading its cards through the page's own
 *     sale.getItens (via background.js's handleLoadPedidoItens) -- one
 *     request on the first open, none after that, since the page keeps what
 *     it loaded. Once open, if the order's own summary doesn't add up -- the
 *     item total plus shipping comes to more than the amount charged, as
 *     when the store gave a cash/PIX discount -- a "Desconto:" line with the
 *     difference is added to that summary, which otherwise never shows it.
 *
 * Depends on: content-utils.js (log, logNotShown, getSettings, sendMessage,
 * SAMV_PURPLE, SAMV_PURPLE_HOVER), compras-copy-button.js (isComprasPage,
 * SEL_LISTA_PEDIDOS, SEL_LOJA_ROW, RE_COD_DA_LOJA)
 */

const SEL_TAB_AVALIACAO = "#tab-aval";
const SEL_VER_TODOS_PEDIDOS = 'input[onclick^="seeAllOrders"]';
const SEL_VER_PEDIDO_LOJA = ".venda-view-ecom";
const SEL_VER_ITENS_NATIVO = ".venda-view";
const VER_ITENS_CLASS = "lgm-ver-itens-pedido";
const VER_ITENS_DEBOUNCE_MS = 150;
const SEL_RODAPE_ROTULOS = ".row.footer .footer-sum-lbl";
const SEL_RODAPE_VALORES = ".row.footer .footer-sum-pedido";
const DESCONTO_CLASS = "lgm-desconto-pedido";
const DESCONTO_OBSERVADO_ATTR = "data-lgm-desconto-observado";
const RODAPE_TIMEOUT_MS = 15_000;
const SEL_LINHA_DO_PEDIDO = (cod) => `#pedido_main_${cod}`;
// Native selected-row look: the site turns an open order's store row orange
// ("pedido-selected") and its own toggle text white.
const PEDIDO_SELECIONADO_CLASS = "pedido-selected";
const COR_CONTROLE_ABERTO = "#ffffff";

// ── Pular "Pedidos aguardando sua avaliação" ────────────────────────────────
function pularTelaDeAvaliacao() {
  const avaliacao = document.querySelector(SEL_TAB_AVALIACAO);
  if (!avaliacao || getComputedStyle(avaliacao).display === "none") return; // already on the list
  const verTodos = document.querySelector(SEL_VER_TODOS_PEDIDOS);
  if (!verTodos) {
    logNotShown("Pular avaliação de pedidos", `botão "Visualizar todos meus pedidos" ("${SEL_VER_TODOS_PEDIDOS}") não encontrado`);
    return;
  }
  verTodos.click();
  log('Tela de avaliação pulada ("Visualizar todos meus pedidos").');
}

// ── "Visualizar Itens" nos pedidos feitos no site da loja ───────────────────
function codDoPedidoDaLinha(row) {
  const container = row.nextElementSibling;
  return container?.id.match(RE_COD_DA_LOJA)?.[1] ?? null;
}

/** "R$ 1.234,56" → 1234.56; zero stays zero (unlike content-utils' parsePrice, which reads zero as "no price"). */
function valorEmReais(texto) {
  const valor = parseFloat(String(texto ?? "").replace(/[^\d,]/g, "").replace(",", "."));
  return Number.isFinite(valor) ? valor : null;
}

function formatarReais(valor) {
  return `R$ ${valor.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Adds "Desconto:" to an order's summary when its own numbers leave a gap:
 * the summary lists Total (items), Frete and Valor Total (charged), in that
 * order, and the gap between the first two and the third is a discount the
 * summary never names. Idempotent; returns false while the summary isn't
 * there yet.
 */
function mostrarDescontoNoRodape(container) {
  const rotulos = container.querySelector(SEL_RODAPE_ROTULOS);
  const valores = container.querySelector(SEL_RODAPE_VALORES);
  if (!rotulos || !valores) return false;
  if (valores.querySelector(`.${DESCONTO_CLASS}`)) return true;

  const linhas = [...valores.querySelectorAll("p")];
  if (linhas.length !== 3) {
    logNotShown('"Desconto" no resumo do pedido', `resumo com ${linhas.length} valor(es), esperava Total, Frete e Valor Total`);
    return true;
  }
  const [total, frete, cobrado] = linhas.map((p) => valorEmReais(p.textContent));
  if ([total, frete, cobrado].some((v) => v == null)) {
    logNotShown('"Desconto" no resumo do pedido', "algum valor do resumo não pôde ser lido");
    return true;
  }
  const desconto = Math.round((total + frete - cobrado) * 100) / 100;
  if (desconto <= 0) return true; // the summary adds up -- nothing to show

  const rotulo = document.createElement("p");
  rotulo.className = `p12 ${DESCONTO_CLASS}`;
  rotulo.textContent = "Desconto:";
  rotulo.title = "Diferença entre o total dos itens com frete e o valor total cobrado (ex.: desconto à vista ou no PIX dado pela loja)";
  const valor = document.createElement("p");
  valor.className = `p12 ${DESCONTO_CLASS}`;
  valor.textContent = `- ${formatarReais(desconto)}`;

  const rotulosLinhas = rotulos.querySelectorAll("p");
  rotulosLinhas[rotulosLinhas.length - 1].before(rotulo);
  linhas[2].before(valor);
  return true;
}

/**
 * Keeps the discount line on an order's summary. The page rewrites the whole
 * items container every time its items are asked for again -- reopening the
 * order (served from its cache) or the "Copiar" button loading them -- which
 * drops anything added inside it, so the line is re-added on each rewrite.
 * Watches only the container's direct children: the rewrite replaces them,
 * while the line itself goes deeper inside, so adding it can't retrigger
 * this.
 */
function manterDescontoNoRodape(container) {
  mostrarDescontoNoRodape(container);
  if (container.hasAttribute(DESCONTO_OBSERVADO_ATTR)) return;
  container.setAttribute(DESCONTO_OBSERVADO_ATTR, "");
  new MutationObserver(() => mostrarDescontoNoRodape(container)).observe(container, { childList: true });
  setTimeout(() => {
    if (getComputedStyle(container).display !== "none" && !container.querySelector(SEL_RODAPE_VALORES)) {
      logNotShown('"Desconto" no resumo do pedido', `resumo ("${SEL_RODAPE_VALORES}") não apareceu em ${RODAPE_TIMEOUT_MS / 1000}s`);
    }
  }, RODAPE_TIMEOUT_MS);
}

/** Chevron drawn in the control's own color, so it reads on the order row whether the items are open or not. */
function buildSeta() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 12 8");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "8");
  svg.setAttribute("aria-hidden", "true");
  Object.assign(svg.style, { verticalAlign: "middle", marginLeft: "2px", transition: "transform 0.15s" });
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M1 1.5l5 5 5-5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}

function corDoControle(controle, hover = false) {
  if (controle.dataset.aberto === "1") return COR_CONTROLE_ABERTO;
  return hover ? SAMV_PURPLE_HOVER : SAMV_PURPLE;
}

function alternarItens(controle, cod) {
  const container = document.getElementById(`venda_${cod}`);
  if (!container) {
    logNotShown('"Visualizar Itens" do pedido', `contêiner "#venda_${cod}" não encontrado no clique`);
    return;
  }
  const abrir = container.style.display === "none" || getComputedStyle(container).display === "none";
  container.style.display = abrir ? "" : "none";
  container.classList.toggle("venda-selected", abrir);
  const linha = document.querySelector(SEL_LINHA_DO_PEDIDO(cod)) ?? controle.closest(SEL_LOJA_ROW);
  linha?.classList.toggle(PEDIDO_SELECIONADO_CLASS, abrir);
  controle.dataset.aberto = abrir ? "1" : "";
  controle.style.color = corDoControle(controle);
  controle.querySelector("svg").style.transform = abrir ? "rotate(180deg)" : "";
  if (!abrir) return;
  manterDescontoNoRodape(container);
  // The page answers from its own cache after the first load.
  sendMessage({ action: "loadPedidoItens", cod });
}

function buildVerItens(cod) {
  const controle = document.createElement("div");
  controle.className = VER_ITENS_CLASS;
  controle.title = "Mostrar as cartas deste pedido aqui mesmo";
  Object.assign(controle.style, { color: SAMV_PURPLE, cursor: "pointer", marginTop: "4px", userSelect: "none" });
  controle.append("Visualizar Itens ");
  controle.appendChild(buildSeta());
  controle.addEventListener("mouseenter", () => (controle.style.color = corDoControle(controle, true)));
  controle.addEventListener("mouseleave", () => (controle.style.color = corDoControle(controle)));
  controle.addEventListener("click", () => alternarItens(controle, cod));
  return controle;
}

function injectVerItensNosPedidosDeLoja() {
  let novos = 0;
  for (const row of document.querySelectorAll(SEL_LOJA_ROW)) {
    const slot = row.querySelector(SEL_VER_PEDIDO_LOJA);
    if (!slot || slot.querySelector(`.${VER_ITENS_CLASS}`)) continue;
    if (row.querySelector(SEL_VER_ITENS_NATIVO)) continue; // the site already has its own toggle
    const cod = codDoPedidoDaLinha(row);
    if (!cod) {
      logNotShown('"Visualizar Itens" do pedido', 'pedido com "Visualizar Pedido" sem contêiner "#venda_<cod>" logo depois');
      continue;
    }
    slot.appendChild(buildVerItens(cod));
    novos++;
  }
  if (novos > 0) log(`"Visualizar Itens" adicionado a ${novos} pedido(s) feito(s) no site da loja.`);
}

/** Later pages of orders are appended straight into #main-compras -- same reasoning as compras-copy-button.js's observarPaginacaoDePedidos. */
function observarPaginasDePedidos() {
  const lista = document.querySelector(SEL_LISTA_PEDIDOS);
  if (!lista) {
    logNotShown('"Visualizar Itens" nas páginas seguintes', `"${SEL_LISTA_PEDIDOS}" não encontrado`);
    return;
  }
  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(injectVerItensNosPedidosDeLoja, VER_ITENS_DEBOUNCE_MS);
  }).observe(lista, { childList: true });
}

function initComprasVerItens() {
  if (!isComprasPage()) return;
  getSettings().then((settings) => {
    if (settings?.skipPedidosAvaliacao !== false) pularTelaDeAvaliacao();
    if (settings?.addVerItensPedidoLoja === false) return;
    injectVerItensNosPedidosDeLoja();
    observarPaginasDePedidos();
  });
}

initComprasVerItens();
