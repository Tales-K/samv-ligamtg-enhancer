/**
 * Builds the "detailed" list format LigaMagic itself accepts in the
 * "Compra por Lista" textarea, where each line pins the exact version of a
 * card instead of just its name:
 *
 *   1 anel solar [qualidade=sp][edicao=cmr][idioma=fr][extras=foil,alterada]
 *
 * Rules, all confirmed against the site's own parser and its Extras/Idioma/
 * Qualidade selects:
 *   - names are the Portuguese ones, lowercase and unaccented;
 *   - `qualidade` is always present (the site's Qualidade select has no
 *     "any" option), the other tokens only when the card pins that field;
 *   - `extras` uses the same labels, in the same order, as the site's own
 *     "Extras" multiselect.
 *
 * Shared by the "Compra por Lista" results button (lista-copy-button.js) and
 * the cart list button (carrinho-copy-button.js), which read the same cards
 * from two very different places.
 */

// Quality codes as they appear inside the parentheses of the site's own
// Qualidade options ("(SP) Usada Levemente ou superior").
const QUALIDADE_SIGLAS = { 1: "m", 2: "nm", 3: "sp", 4: "mp", 5: "hp", 6: "d" };

// Same idea for Idioma. These are the site's parser tokens, which are not
// always the abbreviations used elsewhere in its UI — 7 is "ko" (not "kr"),
// 10 is "tw" and 12 is "tk".
const IDIOMA_SIGLAS = {
  1: "de",
  2: "en",
  3: "es",
  4: "fr",
  5: "it",
  6: "jp",
  7: "ko",
  8: "pt",
  9: "ru",
  10: "tw",
  11: "pten",
  12: "tk",
  16: "ph",
};

/** Lowercase and unaccented, the shape every token in this format uses. */
function normalizeDetailedToken(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase();
}

/**
 * @param {object} card Fields already resolved to their label/sigla form
 *   (`qualidade: "sp"`, `edicao: "CMR"`, `extras: ["Foil"]`); normalization
 *   happens here, and empty optional fields are left out of the line.
 */
function buildDetailedLine({ quantidade, nome, qualidade, edicao, idioma, extras }) {
  const parts = [];
  if (qualidade) parts.push(`[qualidade=${normalizeDetailedToken(qualidade)}]`);
  if (edicao) parts.push(`[edicao=${normalizeDetailedToken(edicao)}]`);
  if (idioma) parts.push(`[idioma=${normalizeDetailedToken(idioma)}]`);

  const extraTokens = (extras ?? []).map(normalizeDetailedToken).filter(Boolean);
  if (extraTokens.length) parts.push(`[extras=${extraTokens.join(",")}]`);

  const name = `${quantidade} ${normalizeDetailedToken(nome)}`;
  return parts.length ? `${name} ${parts.join("")}` : name;
}
