/**
 * Moxfield price overlay — replaces USD prices with BRL prices from LigaMagic.
 *
 * Flow:
 *   1. Collect all unique card names from the current deck view (Text,
 *      Condensed Text, Visual Grid, or Visual Spoiler).
 *   2. Ask the background worker for locally cached prices (chrome.storage.local).
 *   3. Replace each USD price with a coloured BRL price linking to LigaMagic
 *      (Text/Condensed Text) or inject one under each card image (Visual
 *      Spoiler — see applySpoilerPrices).
 *   4. Update each group's header total in BRL.
 *   5. Show a floating "Carregar preços pendentes" button when some cards came
 *      back with no cached price (see renderPendingPricesButton).
 *   6. Keep a LigaMagic entry pinned to the front of the floating card-preview
 *      panel's own buy-links list, updated for whichever card it currently
 *      shows (see ensureHoverAsideObserver) — independent of the price flow
 *      above, since the panel exists before any price is known.
 *   7. Re-run automatically when the SPA re-renders the card list.
 *
 * Depends on: overlay-utils.js (log factory, priceColor, fmtBRL, logPriceMap,
 * queryPrices, observeAndRerun, hasAddedNodeMatching, LIGAMAGIC_BASE,
 * applySamvButtonStyle) — shared with the Archidekt/Scryfall overlays. Does
 * NOT depend on content-utils.js (different host, separate injection).
 */

const log = createLogger("Moxfield");

// ── Constants ─────────────────────────────────────────────────────────────────
// Stable selectors — Moxfield uses Bootstrap utility classes and data attributes.
const SEL_CARD_ROW = "li[data-hash]"; // one per card, Text/Condensed Text views
const SEL_CARD_LINK = 'a[href^="/cards/"]'; // card name anchor
const SEL_PRICE_DIV = "div.text-end.text-monospace"; // USD price column cell
const SEL_QTY_INPUT = 'input[inputmode="numeric"]'; // quantity input
// One per card, Visual Grid/Visual Spoiler views — no <a href> to read a name
// slug from, unlike SEL_CARD_ROW, so these carry the plain display name as
// text in a nested .decklist-card-phantomsearch div instead.
const SEL_DECKLIST_CARD = ".decklist-card[data-hash]";
// Visual Grid renders the identical .decklist-card markup as Visual Spoiler
// (confirmed live: same tag, same classes on the card itself) — the two view
// modes are only told apart by their shared ancestor
// .decklist-image-container, which Visual Grid additionally carries a
// "-condensed" modifier on and Visual Spoiler doesn't. Scoping to the
// unmodified class is what keeps applySpoilerPrices from also painting
// prices onto Grid mode, which wasn't asked for.
const SEL_SPOILER_CARD =
  ".decklist-image-container:not(.decklist-image-container-condensed) .decklist-card[data-hash]";

// data-attribute set on card rows we have already processed.
const PROCESSED_ATTR = "data-lm-processed";

/**
 * Extract card name from Moxfield card href.
 * "/cards/YMDVK-mass-manipulation"     → "Mass Manipulation"
 * "/cards/Y21jp-one-with-the-machine"  → "One with the Machine"
 *
 * Moxfield's slug replaces every non-alphanumeric character (spaces AND
 * apostrophes alike) with "-", so "Rogue's Passage" becomes
 * "rogue-s-passage" — a lone "s" segment can't be told apart from a real
 * word by position alone. Since a standalone one-letter "word" never
 * legitimately appears in a card name, treat it as a collapsed possessive
 * apostrophe and merge it back onto the previous word ("rogue" + "s" →
 * "rogue's"). This covers the overwhelmingly common case (Xxxx's Yyyy) but
 * can't recover other punctuation the slug also drops (e.g. the comma in
 * "Nymris, Oona's Trickster").
 */
function cardNameFromHref(href) {
  const base = "/cards/";
  const dashIdx = href.indexOf("-", base.length);
  if (dashIdx === -1) return null;

  const words = href.slice(dashIdx + 1).split("-");
  const merged = [];
  words.forEach((w) => {
    if (w === "s" && merged.length > 0) {
      merged[merged.length - 1] += "'s";
    } else {
      merged.push(w);
    }
  });

  return merged.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Loose comparison key — strips everything but letters/digits, lowercased. */
function normalizeForCompare(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Card name for a Moxfield card row. Prefers the link's own visible text —
 * already correctly punctuated (e.g. "Sorin, Imperious Bloodlord") — over
 * decoding the href slug, which can't recover a comma at all (see
 * cardNameFromHref's own doc comment: the slug replaces both spaces and
 * commas with "-" identically, so there's no way to tell them apart from the
 * slug alone).
 *
 * For double-faced cards, the visible text only ever shows the front face,
 * and Moxfield's href slug encodes the *other* face — but not consistently:
 *   - Modal cards (e.g. "Balin's Tomb // Ancient Tomb") get a slug for the
 *     back face ALONE: ".../O9Awn-ancient-tomb".
 *   - Transform cards (e.g. "Restless Bloodseeker // Bloodsoaked Reveler")
 *     get a slug for BOTH faces concatenated:
 *     ".../EWoj1-restless-bloodseeker-bloodsoaked-reveler".
 * Neither is LigaMagic's own "Front // Back" naming for these cards on its
 * own, and blindly combining as `text + " // " + slugName` mangles the
 * transform case into a malformed "Front // Front Back" (confirmed live —
 * that's exactly what an earlier version of this function produced). Instead:
 *   1. If the slug and the text agree once normalized, it's an ordinary
 *      single-faced card (a comma, like the Sorin example above, still
 *      counts as agreeing) — just return the text.
 *   2. Otherwise, check whether the slug's words start with the front-face
 *      text's own words — if so, this is the transform case, and everything
 *      after that prefix is the back face.
 *   3. Otherwise, the whole slug is the back face on its own (the modal case).
 * Confirmed live against LigaMagic's own search: "Balin's Tomb // Ancient
 * Tomb" and "Minas Morgul // Cabal Coffers" (modal) both resolve directly
 * with the combined form. Not every double-faced card follows this, though —
 * Bloomburrow's "Restless" transform lands (e.g. "Restless Bloodseeker //
 * Bloodsoaked Reveler") are catalogued under the front face ALONE, so the
 * combined guess still misses for those. That's not a regression: the old
 * slug-only decoding never resolved them either (it produced a
 * space-mangled "Restless Bloodseeker Bloodsoaked Reveler" with no
 * separator at all), just differently wrong. Getting every double-faced
 * card type right would need asking LigaMagic itself which name it
 * registered a card under, not guessing from Moxfield's own markup.
 *
 * The step-2 prefix check needs textWords and slugWords tokenized the SAME
 * way, since it compares them position by position — but the slug's own
 * words are split on every "-" (cardNameFromHref can't tell a real hyphen in
 * the name from a space, so it splits on both identically), while the front
 * face's visible text keeps a real hyphen as part of one word. Splitting
 * textWords on whitespace only, as an earlier version of this did, misaligns
 * the two arrays for any front face that itself contains a hyphen: confirmed
 * live producing a mangled double-length name for "Brass's Tunnel-Grinder //
 * Tecutlan, the Searing Rift" (front face has "Tunnel-Grinder"), "Two-Handed
 * Axe // Sweeping Cleave", and "Studious First-Year // Rampant Growth" — in
 * each case isPrefix came back false past the hyphenated word even though the
 * text genuinely is the slug's own prefix, so the fallback used the entire
 * undecoded slug as the "back face", duplicating the front face's own words
 * inside it. Splitting textWords on hyphens too keeps it aligned with how
 * slugWords was already built.
 *
 * Step 3 (isPrefix false — "the whole slug is the back face on its own") is
 * genuinely ambiguous: a real modal DFC (e.g. "Balin's Tomb // Ancient Tomb")
 * lands there because its slug encodes the BACK face alone, sharing no words
 * with the front face text at all — but Moxfield showing a printing's
 * cosmetic *flavor name* as the row's visible text lands there for the exact
 * same reason, with the href slug still encoding the card's real, unrelated-
 * looking oracle name underneath (confirmed live on "Luca Stadium", a Final
 * Fantasy crossover treatment whose slug decodes to "Strixhaven Stadium", an
 * entirely ordinary single-faced land with no combined name at all).
 *
 * Moxfield's own rotate/"Transform" icon looked like a clean way to tell
 * these apart, and does correctly distinguish most cases — but isn't fully
 * reliable: confirmed live absent even on a genuine MDFC ("The Monstrous
 * Serpent // Koma, Cosmos Serpent"), which would then wrongly resolve to just
 * "Koma Cosmos Serpent" (the bare back face, not a submittable name on its
 * own) with no way to recover. Guessing wrong here isn't fatal either way,
 * though, as long as *something* downstream still asks LigaMagic which
 * reading is actually right instead of committing to one guess — which is
 * exactly what scrapeBatchViaManagedDeck's retry ladder in background.js
 * does: combined name first, then just the front face, then (new) the slug's
 * own decoded name alone, dropping a card only once none of those three are
 * accepted by LigaMagic's own validation. So this always attempts the
 * combined form here — matching step 2's behavior — and leaves sorting out
 * which face (if either) is the real submittable name to that retry ladder,
 * which has LigaMagic's own answer to check against instead of a DOM signal
 * that isn't consistently present.
 */
function cardNameFromLinkRaw(link) {
  const text = link?.textContent?.trim();
  const slugName = cardNameFromHref(link?.getAttribute("href") ?? "");
  if (!text) return slugName;
  if (!slugName) return text;
  if (normalizeForCompare(slugName) === normalizeForCompare(text)) return text;

  const textWords = text.split(/[\s-]+/);
  const slugWords = slugName.split(/\s+/);
  const isPrefix = textWords.every(
    (w, i) => normalizeForCompare(slugWords[i] ?? "") === normalizeForCompare(w),
  );
  const backFace = isPrefix ? slugWords.slice(textWords.length).join(" ") : slugName;

  return backFace ? `${text} // ${backFace}` : text;
}

/**
 * Same as cardNameFromLinkRaw, minus MTG Arena's "A-" rebalance prefix (see
 * stripArenaAlchemyPrefix) — stripped only at this final step, after the
 * double-faced-card name reconciliation above has already run on the
 * untouched text/slug, so that logic's own comparisons stay exactly as
 * they were (its slug-vs-text matching isn't guaranteed to treat a leading
 * "A-" the same way on both sides).
 */
function cardNameFromLink(link) {
  const raw = cardNameFromLinkRaw(link);
  return raw ? stripArenaAlchemyPrefix(raw) : raw;
}

/**
 * Anchor for the pending-prices button: right after the "More" entry in the
 * deck's top toolbar (Primer / Playtest / Bulk Edit / Buy Deck / … / More —
 * which of those precede "More" varies with the viewer's permissions, so
 * #subheader-more itself, not any of them, is the one stable landmark).
 */
function findToolbarAnchor() {
  return document.getElementById("subheader-more")?.parentElement ?? null;
}

/**
 * Anchor for the pending-prices button's own centered row (see fullWidthRow
 * in renderPendingPricesButton/createPendingPricesWrapper) — the whole
 * `.row.justify-content-between...` toolbar, not the narrow `.col-auto`
 * column findToolbarAnchor() above points at.
 *
 * That column is only as wide as its own buttons (confirmed live: 651px
 * against the toolbar's real 1552px on a public deck view with no Primer/
 * Bulk Edit button), so a "width: 100%, centered" wrapper mounted inside it
 * centers against that narrow column instead of the toolbar a viewer
 * actually sees — visibly off-center, not fixed by fullWidthRow alone.
 * Mounting after the row itself (a sibling under its own parent) instead
 * gives that wrapper the container's real full width to center against.
 */
function findToolbarRow() {
  return findToolbarAnchor()?.closest(".row") ?? null;
}

const MOXFIELD_PRICE_COLUMN_HELP =
  'Habilite clicando em "Advanced" (ícone de controles deslizantes) e marcando "Price" em "Include Extra Data".';

/**
 * Whether Moxfield is currently rendering its Price column at all — a
 * per-viewer display toggle (Advanced → Include Extra Data → Price),
 * independent from whether LigaMagic actually has a price for any given
 * card. Read straight off the rendered rows rather than the toggle itself,
 * since that live checkbox only exists in the DOM while its own modal is
 * open.
 */
function isPriceColumnEnabled() {
  const rows = document.querySelectorAll(SEL_CARD_ROW);
  return rows.length === 0 || [...rows].some((row) => row.querySelector(SEL_PRICE_DIV));
}

// ── Card extraction ───────────────────────────────────────────────────────────
// "Visual Grid" and "Visual Spoiler" render an entirely different card-list
// markup than Text/Condensed Text — <div class="decklist-card"> tiles with no
// <a href="/cards/..."> to read a slug from at all (see SEL_DECKLIST_CARD
// below) — so a name collected only from SEL_CARD_ROW would leave run() with
// an empty list, and skip querying prices altogether, whenever the viewer
// is in one of those modes. Collecting from both keeps that from happening.
function extractCardNames() {
  const names = new Set();
  document.querySelectorAll(SEL_CARD_ROW).forEach((row) => {
    const link = row.querySelector(SEL_CARD_LINK);
    if (!link) return;
    const name = cardNameFromLink(link);
    if (name) names.add(name);
  });
  document.querySelectorAll(SEL_DECKLIST_CARD).forEach((card) => {
    const text = card.querySelector(".decklist-card-phantomsearch")?.textContent?.trim();
    if (text) names.add(stripArenaAlchemyPrefix(text));
  });
  return [...names];
}

// ── Hover card-preview store list ───────────────────────────────────────────
// Every view mode (Text, Visual Grid, Visual Spoiler, …) shares one floating
// card-preview panel — <aside class="deckview-image-container"> — that shows
// the currently hovered card's image plus a row of "Buy @ <store>" links.
// Confirmed live via CDP (mouse-hover simulation + a throwaway marker
// attribute left on the node across hovers) that this is a genuine React
// singleton: the <aside> itself, its buy-links container, and even the
// existing <a> elements inside it are the SAME DOM nodes across different
// cards being hovered — React mutates their attributes/text in place rather
// than tearing the subtree down and rebuilding it. That singleton behaviour
// is also why the panel already shows the deck's first card before any
// hover ever happens (it isn't lazily created on first hover — it's always
// present, just pointed at whichever card is "current").
//
// Rather than tracking hover state ourselves (which would need separate
// listeners for Text view's <li data-hash> rows vs. Visual Grid/Spoiler's
// <div class="decklist-card" data-hash> tiles, and still wouldn't cover the
// initial pre-hover state), this reads back OFF the panel itself: every
// card's image URL embeds the same short id used in every view mode's own
// data-hash attribute ("card-Q9Am5-normal.webp" for data-hash="Q9Am5"), so a
// MutationObserver watching that image's src is a single, view-mode-agnostic
// signal for "the panel now shows a different card" — and from that id, the
// matching data-hash element elsewhere on the page gives the exact same
// card-name extraction this file already trusts for the Text view
// (cardNameFromLink), with a same-page fallback for the two view modes that
// don't have a link to read one from.
const SEL_HOVER_ASIDE = "aside.deckview-image-container";
const SEL_HOVER_STORE_LIST = "div.d-grid.gap-2.mt-4.mx-auto";
const HOVER_LINK_ATTR = "data-lm-hover-link";
const HOVER_PRICE_ATTR = "data-lm-hover-price";

// Most recent priceMap from run()'s queryPrices round, shared with the hover
// panel. The panel is populated on its own schedule — it exists, and can be
// re-pointed at a different card, without any price round happening — so it
// reads the latest snapshot here instead of being called from inside one.
let lastPriceMap = {};

// The <aside> currently being watched, and the observer bound to it. Re-set
// whenever ensureHoverAsideObserver() finds a different node than last time
// (e.g. after an SPA navigation to a different deck tears the old one down).
let hoverAsideObserverTarget = null;
let hoverAsideObserver = null;

/** Card id embedded in the preview panel's own image URL, e.g. "Q9Am5" out
 * of ".../cards/card-Q9Am5-normal.webp?...". Same id Moxfield uses as every
 * card row/tile's own data-hash, in every view mode. */
function currentHoverCardHash(aside) {
  const src = aside.querySelector("img.deckview-image.front")?.getAttribute("src") ?? "";
  return src.match(/\/cards\/card-([^-]+)-/)?.[1] ?? null;
}

/** Resolves a data-hash id to a card name, trying Text view's row markup
 * first (routed through cardNameFromLink, the one place in this file that
 * already handles double-faced cards and slug punctuation loss correctly)
 * and falling back to Visual Grid/Spoiler's own tile markup, which has no
 * link to read but does carry the plain display name as text. */
function cardNameForHash(hash) {
  if (!hash) return null;
  const escaped = CSS.escape(hash);

  const row = document.querySelector(`li[data-hash="${escaped}"]`);
  if (row) {
    const link = row.querySelector(SEL_CARD_LINK);
    if (link) return cardNameFromLink(link);
  }

  const tile = document.querySelector(`.decklist-card[data-hash="${escaped}"]`);
  const text = tile?.querySelector(".decklist-card-phantomsearch")?.textContent?.trim();
  return text ? stripArenaAlchemyPrefix(text) : null;
}

/** Creates (once) or updates the LigaMagic entry at the front of the preview
 * panel's own buy-links list, pointed at whichever card the panel currently
 * shows. Called both right after the panel is found (covers the card it
 * shows before any hover happens) and on every subsequent image-src mutation
 * (covers the panel being re-pointed at a newly hovered card). */
function updateHoverStoreLink(aside) {
  const storeList = aside.querySelector(SEL_HOVER_STORE_LIST);
  if (!storeList) {
    logNotShown("Moxfield", "LigaMagic (popup de preview)", "lista de lojas do popup não encontrada");
    return;
  }

  const hash = currentHoverCardHash(aside);
  const name = cardNameForHash(hash);
  if (!name) {
    logNotShown(
      "Moxfield",
      "LigaMagic (popup de preview)",
      `nome da carta não resolvido (data-hash="${hash ?? "?"}")`,
    );
    return;
  }

  let link = storeList.querySelector(`[${HOVER_LINK_ATTR}]`);
  if (!link) {
    link = document.createElement("a");
    link.setAttribute(HOVER_LINK_ATTR, "1");
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    // Same classes the panel's own "Buy @ Card Kingdom"/"Buy @ TCGplayer"/
    // "Buy @ Mana Pool" links use for sizing/spacing — only the colour
    // (applySamvButtonStyle, below) marks this one as ours rather than a
    // native Moxfield entry.
    link.className = "btn btn-sm text-start text-ellipsis";
    // Price first, then the label — the same order (and the same
    // "float-end ms-1" price span) Moxfield's own store links use, so this
    // one lines its price up in the same place theirs do instead of
    // needing its own layout.
    const price = document.createElement("span");
    price.className = "float-end ms-1";
    price.setAttribute(HOVER_PRICE_ATTR, "1");
    link.appendChild(price);
    const label = document.createElement("span");
    label.className = "text-ellipsis";
    label.textContent = "Comprar no LigaMagic";
    link.appendChild(label);
    applySamvButtonStyle(link);
    storeList.insertBefore(link, storeList.firstChild);
  }
  link.href = LIGAMAGIC_BASE + encodeURIComponent(name);

  // Priced off whatever the last queryPrices round returned (see run()) —
  // the panel exists and can change card long before, and independently of,
  // any price round, so it reads from that shared snapshot rather than being
  // driven by one.
  const info = lastPriceMap[name] ?? null;
  const priceEl = link.querySelector(`[${HOVER_PRICE_ATTR}]`);
  if (priceEl) priceEl.textContent = fmtBRL(info?.priceMin ?? null);
  // Freshness is carried in the tooltip rather than by colouring the price
  // text, for the same reason it is in the Scryfall prints table: against
  // this button's purple fill, all three priceColor() values read at very
  // low contrast, well under the legibility floor for normal text.
  link.title = info?.priceMin != null
    ? `LigaMagic — atualizado em ${new Date(info.updatedAt).toLocaleDateString("pt-BR")}`
    : "Sem preço no LigaMagic — clique para abrir a página do card";
}

/** Finds the preview panel (if currently on the page) and makes sure a
 * MutationObserver is watching its image for card changes. Cheap to call on
 * every run() — a no-op past the first call as long as the panel node itself
 * hasn't changed. */
function ensureHoverAsideObserver() {
  const aside = document.querySelector(SEL_HOVER_ASIDE);
  if (!aside) return;

  updateHoverStoreLink(aside);

  if (hoverAsideObserverTarget === aside) return;
  hoverAsideObserver?.disconnect();
  hoverAsideObserver = new MutationObserver(() => updateHoverStoreLink(aside));
  hoverAsideObserver.observe(aside, { attributes: true, attributeFilter: ["src"], subtree: true });
  hoverAsideObserverTarget = aside;
}

// ── Price overlay ─────────────────────────────────────────────────────────────
/**
 * Replaces each card row's USD price cell content with a BRL-priced link to
 * the card page on LigaMagic.
 * @param {Record<string, {priceMin: number|null, updatedAt: string}>} priceMap
 */
function applyPrices(priceMap, openLigaMagicOnClick = true) {
  let replaced = 0;

  document.querySelectorAll(SEL_CARD_ROW).forEach((row) => {
    if (row.hasAttribute(PROCESSED_ATTR)) return;

    const link = row.querySelector(SEL_CARD_LINK);
    if (!link) return;
    const name = cardNameFromLink(link);
    if (!name) return;

    const priceDiv = row.querySelector(SEL_PRICE_DIV);
    if (!priceDiv) return;

    const info = priceMap[name] ?? null;

    const url = LIGAMAGIC_BASE + encodeURIComponent(name);

    if (info?.priceMin != null) {
      // ── Has a LigaMagic price → replace the price div content ─────────────
      const color = priceColor(info.updatedAt);
      const label = fmtBRL(info.priceMin);
      const tooltip = `LigaMagic — atualizado em ${new Date(info.updatedAt).toLocaleDateString("pt-BR")}`;

      priceDiv.textContent = "";

      const a = document.createElement("a");
      if (openLigaMagicOnClick) {
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
      a.title = tooltip;
      a.textContent = label;
      a.style.cssText = [
        `color: ${color}`,
        "text-decoration: none",
        openLigaMagicOnClick ? "cursor: pointer" : "cursor: default",
        "transition: opacity 0.15s",
      ].join("; ");
      a.onmouseenter = () => {
        a.style.opacity = "0.75";
      };
      a.onmouseleave = () => {
        a.style.opacity = "1";
      };
      priceDiv.appendChild(a);
    } else {
      // ── No LigaMagic price ────────────────────────────────────────────────
      const originalText = priceDiv.textContent.trim();

      if (originalText) {
        // Moxfield shows its own USD price — wrap it in a LigaMagic link.
        if (!priceDiv.querySelector("[data-lm-link]")) {
          priceDiv.textContent = "";
          const a = document.createElement("a");
          a.setAttribute("data-lm-link", "1");
          if (openLigaMagicOnClick) {
            a.href = url;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.title =
              "Não encontrado no LigaMagic — clique para abrir a página do card";
          } else {
            a.title = "Não encontrado no LigaMagic";
          }
          a.textContent = originalText;
          a.style.cssText = [
            "color: inherit",
            "text-decoration: none",
            openLigaMagicOnClick ? "cursor: pointer" : "cursor: default",
            "transition: opacity 0.15s",
          ].join("; ");
          a.onmouseenter = () => {
            a.style.opacity = "0.7";
          };
          a.onmouseleave = () => {
            a.style.opacity = "1";
          };
          priceDiv.appendChild(a);
        }
      } else if (!priceDiv.querySelector("[data-lm-link]")) {
        // Moxfield shows no price for this card — inject a red "R$ —" link.
        const a = document.createElement("a");
        a.setAttribute("data-lm-link", "1");
        if (openLigaMagicOnClick) {
          a.href = url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.title = "Sem preço no LigaMagic — clique para abrir a página do card";
        } else {
          a.title = "Sem preço no LigaMagic";
        }
        a.textContent = "R$ —";
        a.style.cssText = [
          "color: #ef4444",
          "text-decoration: none",
          openLigaMagicOnClick ? "cursor: pointer" : "cursor: default",
          "transition: opacity 0.15s",
        ].join("; ");
        a.onmouseenter = () => {
          a.style.opacity = "0.7";
        };
        a.onmouseleave = () => {
          a.style.opacity = "1";
        };
        priceDiv.appendChild(a);
      }
    }

    row.setAttribute(PROCESSED_ATTR, "1");
    replaced++;
  });

  if (replaced > 0) log(`Replaced ${replaced} price label(s).`);
}

// ── Visual Spoiler price ─────────────────────────────────────────────────────
const SPOILER_PRICE_ATTR = "data-lm-spoiler-price";

/**
 * Injects a BRL price line under each card image in the Visual Spoiler grid
 * (SEL_SPOILER_CARD — Visual Grid's identical tiles are deliberately excluded,
 * see that selector's own comment). Same freshness colouring (priceColor) and
 * click-to-LigaMagic behaviour (openLigaMagicOnClick) as the Text view's
 * price column in applyPrices above — this is the same feature, just for a
 * view with no existing table cell to take over.
 */
function applySpoilerPrices(priceMap, openLigaMagicOnClick = true) {
  const cards = document.querySelectorAll(SEL_SPOILER_CARD);
  if (cards.length === 0) return; // not currently in Visual Spoiler view

  let rendered = 0;

  cards.forEach((card) => {
    const rawName = card.querySelector(".decklist-card-phantomsearch")?.textContent?.trim();
    if (!rawName) {
      logNotShown(
        "Moxfield",
        "Preço BRL (Visual Spoiler)",
        `nome não encontrado para o card data-hash="${card.dataset.hash}"`,
      );
      return;
    }
    const name = stripArenaAlchemyPrefix(rawName);
    const info = priceMap[name] ?? null;

    // Reconciled against what this tile already shows, rather than skipped
    // outright as soon as any price element is present. A plain
    // "already has one" guard never updates: the pending-prices backfill
    // deliberately re-runs everything once it finishes, and every tile it
    // just fetched a price for would still be reading "R$ —" until the next
    // full page load. Keying on the price and the click setting as well as
    // the name also covers a tile React re-pointed at a different card and a
    // price that simply changed since the last pass.
    const signature = `${name}|${info?.priceMin ?? ""}|${info?.updatedAt ?? ""}|${openLigaMagicOnClick}`;
    const existing = card.querySelector(`[${SPOILER_PRICE_ATTR}]`);
    if (existing?.dataset.lmSignature === signature) return;
    existing?.remove();

    const wrapper = document.createElement("div");
    wrapper.setAttribute(SPOILER_PRICE_ATTR, "1");
    wrapper.dataset.lmSignature = signature;
    wrapper.style.cssText = "text-align: center; font-size: 13px; font-weight: 700; margin-top: 4px;";

    const a = document.createElement("a");
    a.style.textDecoration = "none";
    if (openLigaMagicOnClick) {
      a.href = LIGAMAGIC_BASE + encodeURIComponent(name);
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.style.cursor = "pointer";
    } else {
      a.style.cursor = "default";
    }

    if (info?.priceMin != null) {
      a.textContent = fmtBRL(info.priceMin);
      a.style.color = priceColor(info.updatedAt);
      a.title = `LigaMagic — atualizado em ${new Date(info.updatedAt).toLocaleDateString("pt-BR")}`;
    } else {
      a.textContent = fmtBRL(null);
      a.style.color = "#ef4444";
      a.title = "Sem preço no LigaMagic";
    }

    wrapper.appendChild(a);
    card.appendChild(wrapper);
    rendered++;
  });

  if (rendered > 0) log(`Visual Spoiler: ${rendered} preço(s) renderizado(s).`);
}

// ── Group total update ────────────────────────────────────────────────────────
/**
 * For each deck group, sums qty × priceMin for every card found in priceMap
 * and updates the group header total in-place.
 *
 * Group structure inside a <ul>:
 *   <li>  ← header row (no data-hash)
 *     <a>...<span title="Group Name">Group Name</span>...</a>
 *     <span class="text-nowrap fw-normal ms-1">–&nbsp;$1.48</span>
 *   </li>
 *   <li data-hash="...">  ← card row
 *     ...
 *   </li>
 */
function updateGroupTotals(priceMap) {
  // A group <ul> is any <ul> that contains at least one card row.
  const groupUls = [...document.querySelectorAll("ul")].filter((ul) =>
    ul.querySelector(SEL_CARD_ROW),
  );

  groupUls.forEach((ul) => {
    let total = 0;
    let hasAnyPrice = false;

    ul.querySelectorAll(SEL_CARD_ROW).forEach((row) => {
      const link = row.querySelector(SEL_CARD_LINK);
      if (!link) return;
      const name = cardNameFromLink(link);
      if (!name) return;

      const qtyInput = row.querySelector(SEL_QTY_INPUT);
      const qty = parseInt(qtyInput?.value) || 1;

      const info = priceMap[name];
      if (info?.priceMin != null) {
        total += qty * info.priceMin;
        hasAnyPrice = true;
      }
    });

    if (!hasAnyPrice) return;

    // Group header = first li without data-hash in this <ul>.
    const headerLi = ul.querySelector("li:not([data-hash])");
    if (!headerLi) return;

    const priceSpan = headerLi.querySelector("span.text-nowrap.fw-normal.ms-1");
    if (!priceSpan) return;

    // Keep the en-dash separator that Moxfield uses (–&nbsp;$X.XX) and append
    // the BRL total as its own coloured span — same green as the deck total
    // below, not just plain text inheriting the row's default colour.
    const originalGroupText =
      priceSpan.getAttribute("data-lm-original") ?? priceSpan.textContent;
    priceSpan.setAttribute("data-lm-original", originalGroupText);
    priceSpan.textContent = `${originalGroupText}  ·  `;
    const brlSpan = document.createElement("span");
    brlSpan.style.color = "#33ac5f";
    brlSpan.textContent = fmtBRL(total);
    priceSpan.appendChild(brlSpan);
  });

  log("Group totals updated.");
}

// ── Group totals, Visual Grid / Visual Spoiler ───────────────────────────────
// Those two views render no <ul>/<li data-hash> markup at all, so
// updateGroupTotals above (written against the text views' rows) sums nothing
// and shows no total there. Their groups are laid out differently too: one
// ".col-auto" per group, whose first child is the header and whose tiles sit
// in a <ul> below it. The header's own USD total is a bare "span.ms-1"
// ("–&nbsp;$0.69") rather than the text view's "span.text-nowrap.fw-normal.ms-1",
// which is why it needs its own selector rather than reusing that one.
const SEL_TILE_GROUP = ".col-auto";
const SEL_TILE_GROUP_PRICE = ":scope > span.ms-1";

/** Quantity badge on a grid/spoiler tile, rendered as "x3" next to the name. */
function tileQuantity(tile) {
  const match = tile.textContent.match(/\bx(\d+)\b/);
  return match ? parseInt(match[1]) || 1 : 1;
}

function updateTileGroupTotals(priceMap) {
  const groups = [...document.querySelectorAll(SEL_TILE_GROUP)].filter((g) =>
    g.querySelector(SEL_DECKLIST_CARD),
  );

  groups.forEach((group) => {
    let total = 0;
    let hasAnyPrice = false;

    group.querySelectorAll(SEL_DECKLIST_CARD).forEach((tile) => {
      const raw = tile.querySelector(".decklist-card-phantomsearch")?.textContent?.trim();
      if (!raw) return;
      const info = priceMap[stripArenaAlchemyPrefix(raw)];
      if (info?.priceMin != null) {
        total += tileQuantity(tile) * info.priceMin;
        hasAnyPrice = true;
      }
    });

    if (!hasAnyPrice) return;

    const header = group.firstElementChild;
    const priceSpan = header?.querySelector(SEL_TILE_GROUP_PRICE);
    if (!priceSpan) return;

    // Same append-alongside treatment updateGroupTotals uses for the text
    // views: Moxfield's own USD total is preserved, ours follows it in the
    // deck-total green, and the original is remembered so repeated runs
    // rebuild from it instead of compounding.
    const original = priceSpan.getAttribute("data-lm-original") ?? priceSpan.textContent;
    priceSpan.setAttribute("data-lm-original", original);
    priceSpan.textContent = `${original}  ·  `;
    const brl = document.createElement("span");
    brl.style.color = "#33ac5f";
    brl.textContent = fmtBRL(total);
    priceSpan.appendChild(brl);
  });
}

// ── Deck total ─────────────────────────────────────────────────────────────────
/**
 * Sums qty × priceMin for all cards in the main deck (articles that appear
 * before the "Considering" / "Sideboard" collapsible section) and shows the
 * BRL total in an injected element just above that separator.
 */
function updateDeckTotal(priceMap) {
  // Find the sideboard separator — a cursor-pointer div whose <strong> reads
  // "Considering" or "Sideboard" (Moxfield uses one or the other).
  const sideboardLabel = [
    ...document.querySelectorAll("div.cursor-pointer"),
  ].find((el) =>
    /considering|sideboard/i.test(
      el.querySelector("strong")?.textContent ?? "",
    ),
  );

  // Collect <article> elements that contain card rows.
  const allArticles = [...document.querySelectorAll("article")].filter((a) =>
    a.querySelector(SEL_CARD_ROW),
  );

  // Keep only main-deck articles — those that appear BEFORE the sideboard label.
  // compareDocumentPosition flag 4 = DOCUMENT_POSITION_FOLLOWING (arg comes after caller).
  const mainArticles = sideboardLabel
    ? allArticles.filter(
        (a) =>
          a.compareDocumentPosition(sideboardLabel) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      )
    : allArticles;

  let total = 0;
  let hasAnyPrice = false;

  mainArticles.forEach((article) => {
    article.querySelectorAll(SEL_CARD_ROW).forEach((row) => {
      const link = row.querySelector(SEL_CARD_LINK);
      if (!link) return;
      const name = cardNameFromLink(link);
      if (!name) return;

      const qtyInput = row.querySelector(SEL_QTY_INPUT);
      const qty = parseInt(qtyInput?.value) || 1;

      const info = priceMap[name];
      if (info?.priceMin != null) {
        total += qty * info.priceMin;
        hasAnyPrice = true;
      }
    });
  });

  if (!hasAnyPrice) return;

  // Display the BRL total alongside the existing USD price in the deck header.
  // Moxfield renders the header bar twice (sticky + main), so use querySelectorAll.
  // Target: <span id="shoppingcart">...$8.34</span>
  const cartSpans = document.querySelectorAll('[id="shoppingcart"]');
  if (cartSpans.length === 0) return;

  const formatted = fmtBRL(total);
  cartSpans.forEach((cartSpan) => {
    let totalEl = cartSpan.parentElement.querySelector("[data-lm-deck-total]");
    if (!totalEl) {
      totalEl = document.createElement("span");
      totalEl.setAttribute("data-lm-deck-total", "1");
      totalEl.style.cssText = "margin-left: 0.75rem; font-weight: 600;";
      cartSpan.insertAdjacentElement("afterend", totalEl);
    }
    totalEl.textContent = `· ${formatted}`;
    totalEl.style.color = "#33ac5f";
  });

  log(`Deck total updated: ${formatted}`);
}
// ── Main run ──────────────────────────────────────────────────────────────────
function run() {
  chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
    if (chrome.runtime.lastError) {
      log("Could not read settings:", chrome.runtime.lastError.message);
      return;
    }
    if (settings?.overlayMoxfield === false) {
      log("Overlay disabled via settings.");
      return;
    }
    const openLigaMagicOnClick = settings?.openLigaMagicOnClick ?? true;

    // Independent of the card-list logic below — the preview panel exists
    // (and may already be showing a card) even before any prices are known,
    // so this runs unconditionally rather than inside the queryPrices
    // callback further down.
    ensureHoverAsideObserver();

    const names = extractCardNames();
    if (names.length === 0) return;
    log(`Found ${names.length} unique card(s) — querying BRL prices…`);

    queryPrices(log, names, (priceMap) => {
      const found = Object.keys(priceMap).length;
      log(`Prices received: ${found}/${names.length}`);
      logPriceMap(log, priceMap, names);
      lastPriceMap = priceMap;
      applyPrices(priceMap, openLigaMagicOnClick);
      applySpoilerPrices(priceMap, openLigaMagicOnClick);
      updateGroupTotals(priceMap);
      updateTileGroupTotals(priceMap);
      updateDeckTotal(priceMap);
      // The panel may already be showing a card whose price only just
      // arrived in this round — refresh it against the snapshot above.
      const hoverAside = document.querySelector(SEL_HOVER_ASIDE);
      if (hoverAside) updateHoverStoreLink(hoverAside);

      const missingNames = names.filter((n) => !priceMap[n]);
      renderPendingPricesButton({
        missingNames,
        onDone: () => {
          // applyPrices() marks every row PROCESSED_ATTR regardless of
          // whether a price was found, so a plain re-run would skip these
          // rows and never pick up the price the backfill just cached —
          // clear the marker on exactly the ones that were missing.
          document.querySelectorAll(SEL_CARD_ROW).forEach((row) => {
            const link = row.querySelector(SEL_CARD_LINK);
            const name = link && cardNameFromLink(link);
            if (name && missingNames.includes(name)) row.removeAttribute(PROCESSED_ATTR);
          });
          run();
        },
        log,
        contextName: getViewedDeckName(),
        // The narrow .col-auto column findToolbarAnchor() points at doesn't
        // reserve a spot for this button — whether it lands at the end of
        // the existing line or wraps depends on how many native buttons
        // happen to be present (Primer only shows when the deck has primer
        // text; Bulk Edit only for the owner), so it was never actually
        // centered on purpose either way. fullWidthRow + mounting after the
        // whole row (not just that column — see findToolbarRow) gives it a
        // deterministic, correctly-centered line of its own instead,
        // identical regardless of which native buttons are present —
        // confirmed live both with and without Primer/Bulk Edit visible, at
        // a wide desktop width and a narrower ~1280px one.
        mountAfter: findToolbarRow(),
        fullWidthRow: true,
        // Matches the height of the "Find and add cards..." search field
        // beside it (33.5px, off 5.25px/10.5px padding + 21px line-height/
        // 14px font) — landing on the same value by padding alone since the
        // two controls don't share a font size to reverse-compute from.
        // Previously 2px 12px (~23.5px), sized against the *native toolbar
        // buttons'* height instead; that comparison no longer applies now
        // that this renders on its own row rather than inline with them.
        btnPadding: "7px 12px",
        checkPriceColumnEnabled: isPriceColumnEnabled,
        priceColumnHelp: MOXFIELD_PRICE_COLUMN_HELP,
      });
    });
  });
}

// ── SPA observer ──────────────────────────────────────────────────────────────
// Moxfield is a React SPA. Card rows are added/removed as the user navigates.
// Re-run on new card rows, on new Visual Grid/Spoiler tiles (switching into
// either of those view modes tears down every SEL_CARD_ROW <li> and mounts
// SEL_DECKLIST_CARD <div> tiles instead — without also matching those here,
// applySpoilerPrices would never get a chance to run after such a switch),
// or on price text appearing inside a row we haven't processed yet (e.g.
// Moxfield filling in USD prices after an async fetch) — that last case is
// Moxfield-specific, so it can't move into the shared hasAddedNodeMatching()
// check alone.
observeAndRerun((mutations) => {
  if (hasAddedNodeMatching(mutations, SEL_CARD_ROW)) return true;
  if (hasAddedNodeMatching(mutations, SEL_DECKLIST_CARD)) return true;
  return mutations.some((m) => {
    const row = m.target.closest?.(SEL_CARD_ROW);
    return row && !row.hasAttribute(PROCESSED_ATTR);
  });
}, run);
