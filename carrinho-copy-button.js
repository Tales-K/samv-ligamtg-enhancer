/**
 * Injects a "Copiar Lista" button next to the "Nome do card" field on the
 * cart's shopping list (?view=mp/carrinho), copying every row in LigaMagic's
 * own detailed format — the exact version, quality, language and extras the
 * user picked for each card.
 *
 * Data source: the rows themselves. Each row keeps its state in plain
 * <select>/<input> elements (the fancy dropdowns are just select2 wrappers
 * around them), so the content script reads them directly from the DOM and
 * needs nothing from the page's own JS.
 *
 * Depends on: content-utils.js (log, getSettings, waitForElement,
 * showCopiedFeedback), detailed-format.js (buildDetailedLine)
 */

const SEL_CARRINHO_ROW = "#compra-espec .linha-carta";
const SEL_CARRINHO_SEARCH_BAR = ".wrapper-cl-input-procurar-card";
// Portuguese name; the sibling .cardname-aux holds the English one.
const SEL_CARRINHO_CARD_NAME = ".cad-cardname a.b";

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
  return { value: el.value, text: el.options[el.selectedIndex].text, el };
}

// ── Reading the list ──────────────────────────────────────────────────────────
function readCarrinhoCards() {
  return [...document.querySelectorAll(SEL_CARRINHO_ROW)].map((row) => {
    const qualidade = selectedOption(row, '[id^="txt_qualidade"]');
    const edicao = selectedOption(row, '[id^="txt_edicao"]');
    const idioma = selectedOption(row, '[id^="txt_idioma"]');
    const extrasEl = row.querySelector('[id^="txt_extras_"]');

    return {
      quantidade: row.querySelector('[id^="txt_quantidade"]')?.value ?? "1",
      nome: row.querySelector(SEL_CARRINHO_CARD_NAME)?.textContent ?? "",
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

// ── Button ────────────────────────────────────────────────────────────────────
async function handleCarrinhoCopyClick(button) {
  const cards = readCarrinhoCards();
  if (cards.length === 0) {
    log("Copiar Lista: nenhuma carta na lista de compras.");
    return;
  }

  const text = cards.map(buildDetailedLine).join("\n");
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    log("Copiar Lista: falha ao copiar para a área de transferência:", err.message);
    return;
  }

  showCopiedFeedback(button);
  log(`Lista do carrinho copiada (${cards.length} carta(s)).`);
}

function injectCarrinhoCopyButton() {
  if (document.getElementById("lgm-copy-carrinho-btn")) return true;

  const searchBar = document.querySelector(SEL_CARRINHO_SEARCH_BAR);
  if (!searchBar) return false;

  // Reuses the site's own .botao class so it matches the "Procurar" button
  // sitting right beside it.
  const button = document.createElement("div");
  button.id = "lgm-copy-carrinho-btn";
  button.className = "botao";
  button.title = "Copiar a lista inteira no formato detalhado do LigaMagic";
  button.style.cssText = "cursor: pointer; margin-left: 8px; white-space: nowrap;";
  button.textContent = "Copiar Lista";
  button.addEventListener("click", () => handleCarrinhoCopyClick(button));

  searchBar.appendChild(button);
  log('Injected "Copiar Lista" button into the cart list.');
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
