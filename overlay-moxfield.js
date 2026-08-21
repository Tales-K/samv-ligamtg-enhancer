/**
 * Moxfield price overlay — replaces USD prices with BRL prices from LigaMagic.
 *
 * Flow:
 *   1. Collect all unique card names from the current deck view.
 *   2. Ask the background worker for locally cached prices (chrome.storage.local).
 *   3. Replace each USD price with a coloured BRL price linking to LigaMagic.
 *   4. Update each group's header total in BRL.
 *   5. Show a floating "Carregar preços pendentes" button when some cards came
 *      back with no cached price (see renderPendingPricesButton).
 *   6. Re-run automatically when the SPA re-renders the card list.
 *
 * Depends on: overlay-utils.js (log factory, priceColor, fmtBRL, logPriceMap,
 * queryPrices, observeAndRerun, hasAddedNodeMatching) — shared with the
 * Archidekt/Scryfall overlays. Does NOT depend on content-utils.js (different
 * host, separate injection).
 */

const log = createLogger("Moxfield");

// ── Constants ─────────────────────────────────────────────────────────────────
// Stable selectors — Moxfield uses Bootstrap utility classes and data attributes.
const SEL_CARD_ROW = "li[data-hash]"; // one per card
const SEL_CARD_LINK = 'a[href^="/cards/"]'; // card name anchor
const SEL_PRICE_DIV = "div.text-end.text-monospace"; // USD price column cell
const SEL_QTY_INPUT = 'input[inputmode="numeric"]'; // quantity input

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
function extractCardNames() {
  const names = new Set();
  document.querySelectorAll(SEL_CARD_ROW).forEach((row) => {
    const link = row.querySelector(SEL_CARD_LINK);
    if (!link) return;
    const name = cardNameFromLink(link);
    if (name) names.add(name);
  });
  return [...names];
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
    const names = extractCardNames();
    if (names.length === 0) return;
    log(`Found ${names.length} unique card(s) — querying BRL prices…`);

    queryPrices(log, names, (priceMap) => {
      const found = Object.keys(priceMap).length;
      log(`Prices received: ${found}/${names.length}`);
      logPriceMap(log, priceMap, names);
      applyPrices(priceMap, openLigaMagicOnClick);
      updateGroupTotals(priceMap);
      updateDeckTotal(priceMap);

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
        mountAfter: findToolbarAnchor(),
        // Matches the row's own gap between Primer/Playtest/Buy Deck/…/More
        // (each carries a Bootstrap .me-5, computed here as 32px).
        toolbarGap: "32px",
        // Native toolbar items (Playtest/Buy/Download/More) render at
        // ~17-21px tall off a 14px/400-weight line-height with no padding
        // at all. This button keeps its own purple-pill look rather than
        // matching their bare-text style, but the default padding (8px
        // 14px) rendered it at 35.5px — over double theirs — which stretched
        // the whole toolbar row and pushed it visibly above their baseline.
        // Cut down to keep the pill shape while landing close to their
        // height (~23.5px here, against a 13px/700-weight line-height).
        btnPadding: "2px 12px",
        checkPriceColumnEnabled: isPriceColumnEnabled,
        priceColumnHelp: MOXFIELD_PRICE_COLUMN_HELP,
      });
    });
  });
}

// ── SPA observer ──────────────────────────────────────────────────────────────
// Moxfield is a React SPA. Card rows are added/removed as the user navigates.
// Re-run on new card rows, or on price text appearing inside a row we
// haven't processed yet (e.g. Moxfield filling in USD prices after an async
// fetch) — that second case is Moxfield-specific, so it can't move into the
// shared hasAddedNodeMatching() check alone.
observeAndRerun((mutations) => {
  if (hasAddedNodeMatching(mutations, SEL_CARD_ROW)) return true;
  return mutations.some((m) => {
    const row = m.target.closest?.(SEL_CARD_ROW);
    return row && !row.hasAttribute(PROCESSED_ATTR);
  });
}, run);
