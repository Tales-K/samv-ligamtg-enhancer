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

// The abbreviations the site's own UI shows per card (the EN/PT/PTEN/PH
// badges), keyed by the same idioma code as IDIOMA_SIGLAS above. Deliberately
// separate from it: for some languages the badge and the parser token differ
// (7 is "KR" on screen but `ko` to the parser, 10 is "CT"/`tw`, 12 is
// "CS"/`tk`), so going from one to the other has to travel through this shared
// numeric key rather than reusing the string.
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

/**
 * Parser token for an idioma given the badge the site rendered ("PT", "KR").
 * For screens that only expose the badge and never the numeric code, this is
 * the exact conversion -- see the note on IDIOMA_LABELS for why reusing the
 * badge as the token would be wrong.
 */
function idiomaTokenFromLabel(label) {
  const alvo = String(label ?? "").trim().toUpperCase();
  const codigo = Object.keys(IDIOMA_LABELS).find((k) => IDIOMA_LABELS[k] === alvo);
  return codigo ? IDIOMA_SIGLAS[codigo] : null;
}

/**
 * The plain list format: "<qty> <name>", with the optional suffixes the copy
 * panel's four toggles add. Takes fields already resolved to their display
 * form, so a caller reading them off the DOM and a caller mapping them from
 * the site's numeric codes share this one implementation.
 */
function buildSimpleLine({ quantidade, nome, edicao, qualidade, idioma, preco }, options) {
  let line = `${quantidade} ${nome}`;
  if (options.versao && edicao) line += ` (${String(edicao).toUpperCase()})`;
  if (options.qualidade) line += ` [${qualidade ? String(qualidade).toUpperCase() : "?"}]`;
  if (options.idioma) line += ` [${idioma || "?"}]`;
  if (options.preco && preco) line += ` - R$ ${preco}`;
  return line;
}

/** Lowercase and unaccented, the shape every token in this format uses. *//** Lowercase and unaccented, the shape every token in this format uses. */
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

/**
 * Builds a "# <nome>" section title, adding the store's id (and its domain,
 * once resolved) when one is known -- so a copied list still identifies
 * exactly which store a block came from, not just its display name, which
 * can repeat across different sellers or change over time.
 *
 * `storeCache` is the id-keyed dict background.js's getStoreCache returns
 * ({ id, name, domain }[] by id) -- domain is filled in only once
 * background.js has resolved it (see mergeScrapedStoresIntoCache), so it's
 * routinely still missing and left out rather than shown as empty.
 */
function buildStoreSectionTitle(nome, id, storeCache) {
  if (id == null) return nome;
  const domain = storeCache?.[String(id)]?.domain;
  return domain ? `${nome} (ID ${id} · ${domain})` : `${nome} (ID ${id})`;
}

/**
 * Renders `{ title, lines }` groups as a "# <title>" header followed by its
 * lines, one blank line between groups. Empty groups are dropped.
 *
 * The headers are safe to keep: LigaMagic's own parser skips any line it
 * can't read as a card, so the text still pastes back into "Compra por
 * Lista" with them in place.
 */
function buildSectionedText(sections) {
  return sections
    .filter((section) => section && section.lines.length > 0)
    .map((section) => [`# ${section.title}`, ...section.lines].join("\n"))
    .join("\n\n");
}
