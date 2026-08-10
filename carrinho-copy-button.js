/**
 * Injects a "Copiar Lista" button next to the "Nome do card" field on the
 * cart page (?view=mp/carrinho), copying everything the page holds in
 * LigaMagic's own detailed format — the exact version, quality, language and
 * extras of each card.
 *
 * The page holds two separate sets of cards, and both are copied, each under
 * its own "# " header:
 *   - "Lista de Compras", the wishlist-style table at the top, where each row
 *     describes the version the user is looking for;
 *   - the cart itself, one block per store, holding the specific listings
 *     already picked. The same card can legitimately appear in both (a plain
 *     Sol Ring on the list, a foil one picked from a store), so nothing is
 *     deduplicated.
 *
 * Both sets are read straight from the DOM: the list keeps its state in plain
 * <select>/<input> elements (the fancy dropdowns are just select2 wrappers
 * around them) and the cart rows carry semantic attributes of their own
 * ([cardtitle], [extrascard], [editioncard], [languagecard], [qualitycard]),
 * so nothing is needed from the page's own JS.
 *
 * Depends on: content-utils.js (log, getSettings, waitForElement,
 * showCopiedFeedback), detailed-format.js (buildDetailedLine,
 * buildSectionedText)
 */

// ── "Lista de Compras" (the editable table at the top) ────────────────────────
const SEL_LISTA_ROW = "#compra-espec .linha-carta";
const SEL_LISTA_SEARCH_BAR = ".wrapper-cl-input-procurar-card";
// Portuguese name; the sibling .cardname-aux holds the English one.
const SEL_LISTA_CARD_NAME = ".cad-cardname a.b";

// ── The cart proper (one #meucarrinho block per store) ────────────────────────
const SEL_CART_BLOCK = "#meucarrinho";
const SEL_CART_ROW = '.itens .row[id^="linha_"]';
const SEL_CART_STORE_NAME = ".loja-titulo";

function isCarrinhoPage() {
  const params = new URLSearchParams(location.search);
  return params.get("view") === "mp/carrinho";
}

/** The "(SP)" in "(SP) Usada Levemente ou superior". */
function siglaFromParentheses(text) {
  return (String(text ?? "").match(/\(([^)]+)\)/) ?? [])[1] ?? "";
}

function selectedOption(row, selector) {
  const el = row.querySelector(selector);
  if (!el || el.selectedIndex < 0) return null;
  return { value: el.value, text: el.options[el.selectedIndex].text };
}

// ── Reading the "Lista de Compras" table ──────────────────────────────────────
function readListaCards() {
  return [...document.querySelectorAll(SEL_LISTA_ROW)].map((row) => {
    const qualidade = selectedOption(row, '[id^="txt_qualidade"]');
    const edicao = selectedOption(row, '[id^="txt_edicao"]');
    const idioma = selectedOption(row, '[id^="txt_idioma"]');
    const extrasEl = row.querySelector('[id^="txt_extras_"]');

    return {
      quantidade: row.querySelector('[id^="txt_quantidade"]')?.value ?? "1",
      nome: row.querySelector(SEL_LISTA_CARD_NAME)?.textContent ?? "",
      qualidade: siglaFromParentheses(qualidade?.text),
      // "Qualquer edição" is the empty-valued option; a real one reads
      // "BR - Battle Royale Box Set", and only the sigla goes in the line.
      edicao: edicao?.value ? edicao.text.split(" - ")[0] : "",
      // Same idea for "Qualquer idioma", which is value "0".
      idioma: idioma?.value && idioma.value !== "0" ? siglaFromParentheses(idioma.text) : "",
      extras: extrasEl ? [...extrasEl.selectedOptions].map((option) => option.text) : [],
    };
  });
}

// ── Reading the cart blocks ───────────────────────────────────────────────────
/**
 * Card titles read "Anel Solar / Sol Ring". Splitting on " / " would break on
 * the double-faced cards that carry a "//" of their own, so the English half
 * is taken from the link's own `card` parameter and trimmed off the end.
 */
function portugueseNameFromTitle(link) {
  const full = link?.textContent.trim() ?? "";
  const href = link?.getAttribute("href") ?? "";
  const english = new URLSearchParams(href.split("?")[1] ?? "").get("card") ?? "";
  return english && full.endsWith(` / ${english}`) ? full.slice(0, -(english.length + 3)) : full;
}

function readCartRow(row) {
  const editionHref = row.querySelector("[editioncard] a")?.getAttribute("href") ?? "";
  const extrasText = row.querySelector("[extrascard]")?.textContent.trim() ?? "";

  return {
    quantidade: row.querySelector("input.qty")?.value ?? "1",
    nome: portugueseNameFromTitle(row.querySelector("[cardtitle] a")),
    // Already the same sigla/label vocabulary the detailed format uses.
    qualidade: row.querySelector("[qualitycard]")?.textContent.trim() ?? "",
    edicao: (editionHref.match(/ed=([^&\s]+)/) ?? [])[1] ?? "",
    // The flag cell is followed by the language code cell ("EN", "PTEN").
    idioma: row.querySelector("[languagecard]")?.nextElementSibling?.textContent.trim() ?? "",
    // "Foil, Foil Especial / Foil Etched" — no extra label contains a comma.
    extras: extrasText.split(",").map((label) => label.trim()).filter(Boolean),
  };
}

function readCartSections() {
  return [...document.querySelectorAll(SEL_CART_BLOCK)].map((block) => {
    const storeName =
      block.parentElement?.querySelector(SEL_CART_STORE_NAME)?.textContent.trim() ?? "Loja";
    const cards = [...block.querySelectorAll(SEL_CART_ROW)].map(readCartRow);
    return { title: storeName, lines: cards.map(buildDetailedLine) };
  });
}

function buildCarrinhoText() {
  return buildSectionedText([
    { title: "Lista de Compras", lines: readListaCards().map(buildDetailedLine) },
    ...readCartSections(),
  ]);
}

// ── Button ────────────────────────────────────────────────────────────────────
async function handleCarrinhoCopyClick(button) {
  const text = buildCarrinhoText();
  if (!text) {
    log("Copiar Lista: nada na lista de compras nem no carrinho.");
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    log("Copiar Lista: falha ao copiar para a área de transferência:", err.message);
    return;
  }

  showCopiedFeedback(button);
  const cardCount = text.split("\n").filter((line) => line && !line.startsWith("#")).length;
  log(`Carrinho copiado (${cardCount} carta(s)).`);
}

function injectCarrinhoCopyButton() {
  if (document.getElementById("lgm-copy-carrinho-btn")) return true;

  const searchBar = document.querySelector(SEL_LISTA_SEARCH_BAR);
  if (!searchBar) return false;

  // Reuses the site's own .botao class so it matches the "Procurar" button
  // sitting right beside it.
  const button = document.createElement("div");
  button.id = "lgm-copy-carrinho-btn";
  button.className = "botao";
  button.title =
    "Copiar a lista de compras e os itens do carrinho no formato detalhado do LigaMagic";
  button.style.cssText = "cursor: pointer; margin-left: 8px; white-space: nowrap;";
  button.textContent = "Copiar Lista";
  button.addEventListener("click", () => handleCarrinhoCopyClick(button));

  searchBar.appendChild(button);
  log('Injected "Copiar Lista" button into the cart.');
  return true;
}

function initCarrinhoCopyButton() {
  if (!isCarrinhoPage()) return;

  getSettings().then((settings) => {
    if (settings?.addCarrinhoCopyButton === false) return;
    waitForElement(injectCarrinhoCopyButton);
  });
}

initCarrinhoCopyButton();
