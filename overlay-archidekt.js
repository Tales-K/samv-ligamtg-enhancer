/**
 * Archidekt price overlay — replaces USD price links with BRL prices from LigaMagic.
 *
 * Flow:
 *   1. Collect all unique card names from the current view (text-view rows,
 *      the card detail modal, and/or the grid view — whichever are present).
 *   2. Ask the background worker for locally cached prices (chrome.storage.local).
 *   3. Replace each USD price link with a coloured BRL price that links to
 *      LigaMagic, and add a LigaMagic pill alongside the card detail modal's
 *      and the grid view's own marketplace price row.
 *   4. Re-run automatically when the SPA re-renders the card list.
 *
 * Depends on: overlay-utils.js (log factory, priceColor, fmtBRL, logPriceMap,
 * queryPrices, observeAndRerun, hasAddedNodeMatching) — shared with the
 * Moxfield/Scryfall overlays. Does NOT depend on content-utils.js (different
 * host, separate injection).
 */

const log = createLogger("Archidekt");

// ── Constants ─────────────────────────────────────────────────────────────────
// Archidekt uses CSS Modules — class names have hash suffixes that can change
// between deploys. We match on the stable semantic prefix with [class*=...].
const SEL_CARD_BUTTON = '[class*="textViewCard_button"]';
const SEL_PRICE_LINK = '[class*="textViewCard_shoppingUrl"]';
const SEL_CARD_ROW = '[class*="textViewCard_card"]';

// Archidekt renders the exact same "Prices" component (the TCGplayer / Card
// Kingdom / Mana Pool pill row) in two more places besides the text-view row
// above: the per-card detail modal (opened from a card's "..." menu → "Open
// details") and the grid/image view ("View as" → Grid). Both share the same
// prices_container/prices_price markup, so one code path below handles both
// — the only real difference is which ancestor also holds the card's own
// name, needed to look its price up in priceMap: the modal's name lives
// under cardDetailsOverlay_left, the grid card's under imageCard_imageCard.
const SEL_PRICE_ROW = '[class*="prices_container"]';
const SEL_PRICE_ROW_CARD_ROOT = '[class*="cardDetailsOverlay_left"], [class*="imageCard_imageCard"]';
// Archidekt keeps a card's name/text "loading skeleton" mounted in the DOM
// even after the real card image has finished loading (it's just faded to
// opacity 0, not removed) — present in both the modal and the grid view, and
// a more reliable name source there than the rendered image's alt/title
// text, which bundles in the set code and collector number (e.g. "Xyris,
// the Writhing Storm (dmc) 175") that would need stripping back off.
const SEL_CARD_NAMEBOX = '[class*="cardLoader_namebox"]';
// Marks the pill this file appends to those rows, so a later pass can find
// its own previous work and reconcile it (see applyDetailAndGridPrices)
// rather than appending a second one next to it.
const DETAIL_PILL_CLASS = "lm-ext-detail-price";
// One card tile in the grid ("View as" → Grid) and the quantity badge drawn
// on its corner. The grid renders no textViewCard_* markup at all, so the
// per-card totals below have to read name/quantity from these instead.
const SEL_GRID_TILE = '[class*="imageCard_imageCard"]';
const SEL_GRID_QTY = '[class*="cornerQuantity"]';

/**
 * True if `el` is part of the deck's "Tokens & Extras" content — token/
 * emblem/etc. prints related to cards actually in the deck, captioned "None
 * of the tokens or extras below are actually 'in your deck'" (Archidekt's
 * own tooltip). None of them are cards the player would buy, so querying
 * LigaMagic for their names only ever produces a "not found" result (they're
 * relevant/reprint-adjacent Magic names, not necessarily buyable singles)
 * that inflates the missing-price count and, via the pending-prices
 * backfill, submits names to LigaMagic's deck form that were never going to
 * resolve — see extractCardNames/applyPrices/applyDetailAndGridPrices, every
 * one of this file's own card-reading sites.
 *
 * Confirmed live this is actually TWO separate widgets Archidekt renders
 * under that one heading, not one: (1) the "stack" list entry (id
 * `stack_Tokens & Extras`) — a normal deck-list row/tile like any other
 * category's, but only for whichever tokens the user (or Archidekt) has
 * actually added as a line item; and (2) a standalone preview grid
 * (`tokenContainer_container`) that separately shows EVERY token/emblem the
 * deck's cards CAN produce, matching the "(N)" count next to the section's
 * own <h2> — on a real deck this held 10 entries while the stack list held
 * only 1, so relying on the stack check alone (this function's original,
 * incomplete version) left 9 of them still being queried/counted as
 * missing. Both need checking; a card could in principle appear in only one
 * of the two.
 */
function isInTokensAndExtrasStack(el) {
  if (!el) return false;
  if (el.closest('[id="stack_Tokens & Extras"]')) return true;
  if (el.closest('[class*="tokenContainer_container"]')) return true;
  const stack = el.closest('[class*="stackWrapper_container"]');
  return stack?.querySelector('[class*="stackHeader_title"]')?.textContent?.trim() === "Tokens & Extras";
}

/**
 * Every card in `root`, as {name, qty}, regardless of which view is
 * rendering it — the text view's rows when they're present, the grid's tiles
 * otherwise. The group and deck totals both need this: written against the
 * text view alone, they silently summed nothing at all in grid view (no
 * textViewCard_card exists there), so no total was ever shown.
 */
function cardEntriesIn(root) {
  const rows = [...root.querySelectorAll(SEL_CARD_ROW)];
  if (rows.length > 0) {
    return rows.flatMap((row) => {
      const btn = row.querySelector(SEL_CARD_BUTTON);
      const name = cardNameOf(btn);
      if (!name) return [];
      // Quantity is the first text node of the button, before the name span.
      return [{ name, qty: parseInt(btn.childNodes[0]?.textContent?.trim()) || 1 }];
    });
  }

  return [...root.querySelectorAll(SEL_GRID_TILE)].flatMap((tile) => {
    const name = cardNameFromNamebox(tile.querySelector(SEL_CARD_NAMEBOX));
    if (!name) return [];
    return [{ name, qty: parseInt(tile.querySelector(SEL_GRID_QTY)?.textContent?.trim()) || 1 }];
  });
}

// data-attribute set on price elements we have already processed.
const PROCESSED_ATTR = "data-lm-processed";

/**
 * Anchor for the pending-prices button: right after the "More" button in the
 * deck's top toolbar. Archidekt's CSS-module classes there are hashed and
 * change between deploys, and which button sits before "More" varies with
 * viewer permissions ("Import cards" for the owner, "Clone deck" otherwise)
 * — so this matches on the "More" button's own text instead of any class,
 * then walks up to whichever ancestor is a direct child of the toolbar row,
 * which is the actual flex sibling to insert after.
 */
function findToolbarAnchor() {
  const container = document.querySelector('[class*="primaryActions"]');
  if (!container) return null;
  const moreBtn = [...container.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === "More",
  );
  if (!moreBtn) return null;
  let node = moreBtn;
  while (node.parentElement && node.parentElement !== container) node = node.parentElement;
  return node.parentElement === container ? node : null;
}

const ARCHIDEKT_PRICE_COLUMN_HELP =
  'Habilite clicando na engrenagem em "View as" → "Enabled columns" e marcando "Price".';

/**
 * Whether Archidekt is currently rendering its Price column at all — a
 * per-viewer display toggle (View as → gear → Enabled columns → Price),
 * independent from whether LigaMagic actually has a price for any given
 * card. Read straight off the rendered rows rather than the toggle itself,
 * since that live control only exists in the DOM while its own flyout menu
 * is open.
 */
function isPriceColumnEnabled() {
  const cards = document.querySelectorAll(SEL_CARD_BUTTON);
  return cards.length === 0 || document.querySelectorAll(SEL_PRICE_LINK).length > 0;
}

// ── Card extraction ───────────────────────────────────────────────────────────
/**
 * Reads a card button's name, stripping MTG Arena's "A-" rebalance prefix
 * (see stripArenaAlchemyPrefix) — Archidekt's title attribute carries it as
 * plain text (e.g. "A-Dungeon Descent"), which would otherwise get queried
 * against LigaMagic verbatim, and LigaMagic (paper-only) never carries a
 * card under that Arena-only name.
 */
function cardNameOf(btn) {
  const raw = btn?.getAttribute("title")?.trim();
  return raw ? stripArenaAlchemyPrefix(raw) : null;
}

/**
 * Reads a card name straight off its loading-skeleton namebox (see
 * SEL_CARD_NAMEBOX above) — used for the modal and grid surfaces, which
 * don't have a textViewCard_button to read a title attribute off of.
 */
function cardNameFromNamebox(el) {
  const raw = el?.textContent?.trim();
  return raw ? stripArenaAlchemyPrefix(raw) : null;
}

function extractCardNames() {
  const names = new Set();
  document.querySelectorAll(SEL_CARD_BUTTON).forEach((btn) => {
    if (isInTokensAndExtrasStack(btn)) return;
    const name = cardNameOf(btn);
    if (name) names.add(name);
  });
  // Covers decks whose default/only view is Grid (no text-view buttons ever
  // render there) and the card detail modal — without this, a price query
  // never fires for either surface and applyDetailAndGridPrices() below has
  // nothing to inject.
  document.querySelectorAll(SEL_CARD_NAMEBOX).forEach((box) => {
    if (isInTokensAndExtrasStack(box)) return;
    const name = cardNameFromNamebox(box);
    if (name) names.add(name);
  });
  return [...names];
}

// ── Price overlay ─────────────────────────────────────────────────────────────
/**
 * @param {Record<string, {priceMin: number|null, updatedAt: string}>} priceMap
 *   Keyed by card name.
 */
function applyPrices(priceMap, openLigaMagicOnClick = true) {
  let replaced = 0;
  document.querySelectorAll(SEL_PRICE_LINK).forEach((linkEl) => {
    // Skip already-processed elements (handles partial re-renders).
    if (linkEl.hasAttribute(PROCESSED_ATTR)) return;
    // Tokens/extras were never queried (see extractCardNames) — leave
    // Archidekt's own native USD price link exactly as it is instead of
    // replacing it with a LigaMagic price we never looked up.
    if (isInTokensAndExtrasStack(linkEl)) return;

    // Walk up to the card row to find the card name.
    const row = linkEl.closest(SEL_CARD_ROW);
    if (!row) return;

    const btn = row.querySelector(SEL_CARD_BUTTON);
    const name = cardNameOf(btn);
    if (!name) return;

    const info = priceMap[name] ?? null;

    const url = LIGAMAGIC_BASE + encodeURIComponent(name);
    linkEl.setAttribute(PROCESSED_ATTR, "1");

    if (info?.priceMin != null) {
      // ── Has a LigaMagic price → replace the original price label ──────────
      const color = priceColor(info.updatedAt);
      const label = fmtBRL(info.priceMin, { spaced: true });
      const tooltip = `LigaMagic — atualizado em ${new Date(info.updatedAt).toLocaleDateString("pt-BR")}`;

      if (openLigaMagicOnClick) {
        linkEl.href = url;
        linkEl.target = "_blank";
        linkEl.rel = "noopener noreferrer";
      } else {
        linkEl.removeAttribute("href");
        linkEl.removeAttribute("target");
        linkEl.removeAttribute("rel");
      }
      linkEl.title = tooltip;
      linkEl.textContent = label;
      linkEl.style.cssText = [
        `color: ${color}`,
        "font-weight: 600",
        "text-decoration: none",
        openLigaMagicOnClick ? "cursor: pointer" : "cursor: default",
        "transition: opacity 0.15s",
      ].join("; ");
      linkEl.onmouseenter = () => {
        linkEl.style.opacity = "0.75";
      };
      linkEl.onmouseleave = () => {
        linkEl.style.opacity = "1";
      };
    } else if (openLigaMagicOnClick) {
      // ── No LigaMagic price → only redirect to LigaMagic, keep original style
      linkEl.href = url;
      linkEl.title =
        "Sem preço no LigaMagic — clique para abrir a página do card";
    }

    replaced++;
  });

  if (replaced > 0) log(`Replaced ${replaced} price label(s).`);
}

/**
 * Builds one LigaMagic price pill, styled to sit alongside Archidekt's own
 * TCGplayer/Card Kingdom/Mana Pool pills in the prices_container row without
 * depending on their own (hashed) classes for layout — flex/gap/font are set
 * inline instead, matched by eye to the row's existing pills.
 */
function buildLigaMagicPricePill(name, info, openLigaMagicOnClick) {
  const el = document.createElement("a");
  const hasPrice = info?.priceMin != null;
  const color = priceColor(info?.updatedAt);

  el.textContent = fmtBRL(info?.priceMin, { spaced: true });
  el.title = hasPrice
    ? `LigaMagic — atualizado em ${new Date(info.updatedAt).toLocaleDateString("pt-BR")}`
    : "Sem preço no LigaMagic" + (openLigaMagicOnClick ? " — clique para abrir a página do card" : "");
  el.style.cssText = [
    "display: inline-flex",
    "align-items: center",
    `color: ${color}`,
    "font-size: 12px",
    "font-weight: 700",
    "text-decoration: none",
    "white-space: nowrap",
    openLigaMagicOnClick ? "cursor: pointer" : "cursor: default",
  ].join("; ");

  if (openLigaMagicOnClick) {
    el.href = LIGAMAGIC_BASE + encodeURIComponent(name);
    el.target = "_blank";
    el.rel = "noopener noreferrer";
  }

  return el;
}

// ── Card detail modal & grid view price row ─────────────────────────────────
/**
 * Appends a LigaMagic price pill to every prices_container row found so far
 * unprocessed (see SEL_PRICE_ROW/PROCESSED_ATTR) — the modal's and the grid
 * view's each render exactly one, alongside Archidekt's own marketplace
 * pills, so this is additive (appendChild) rather than a replacement like
 * applyPrices() does for the text view's single USD link.
 *
 * @param {Record<string, {priceMin: number|null, updatedAt: string}>} priceMap
 */
function applyDetailAndGridPrices(priceMap, openLigaMagicOnClick = true) {
  let injected = 0;
  document.querySelectorAll(SEL_PRICE_ROW).forEach((row) => {
    // Tokens/extras were never queried (see extractCardNames) — no pill to
    // add here, same reasoning as applyPrices() skipping these for the text
    // view. Checked before the root lookup below since the grid tile IS the
    // root for this case, and this is cheaper than that lookup anyway.
    if (isInTokensAndExtrasStack(row)) return;

    const root = row.closest(SEL_PRICE_ROW_CARD_ROOT);
    if (!root) {
      logNotShown(
        "Archidekt",
        "Preço LigaMagic (modal/grade)",
        "container de preços fora de um card reconhecido (cardDetailsOverlay_left / imageCard_imageCard)",
      );
      return;
    }

    const name = cardNameFromNamebox(root.querySelector(SEL_CARD_NAMEBOX));
    if (!name) {
      logNotShown("Archidekt", "Preço LigaMagic (modal/grade)", "nome do card não encontrado (cardLoader_namebox ausente)");
      return;
    }

    // Reconciled against the pill already there (if any) rather than gated
    // on a one-shot "already processed" marker, because this path is
    // additive: an appendChild that ran a second time on the same row would
    // leave two pills side by side rather than harmlessly redoing its work
    // like the text view's replace-in-place does. That second pass is a
    // normal occurrence, not an edge case — the pending-prices backfill
    // deliberately re-runs everything once it finishes so the newly cached
    // prices get drawn.
    //
    // Keying on the card name plus the price itself also covers a row whose
    // contents Archidekt swapped underneath us (the detail modal reuses one
    // container as the user moves between cards) and a row whose price
    // simply changed since the last pass — both need the pill replaced,
    // and neither is distinguishable from "nothing to do" by presence alone.
    const info = priceMap[name] ?? null;
    const signature = `${name}|${info?.priceMin ?? ""}|${info?.updatedAt ?? ""}|${openLigaMagicOnClick}`;
    const existing = row.querySelector(`.${DETAIL_PILL_CLASS}`);
    if (existing?.dataset.lmSignature === signature) return;
    existing?.remove();

    const pill = buildLigaMagicPricePill(name, info, openLigaMagicOnClick);
    pill.classList.add(DETAIL_PILL_CLASS);
    pill.dataset.lmSignature = signature;
    row.appendChild(pill);
    injected++;
  });

  if (injected > 0) log(`Injected LigaMagic price into ${injected} detail/grid price row(s).`);
}

// ── Group total update ─────────────────────────────────────────────────────────
/**
 * For each card group (stack), sums qty × priceMin for every card found in
 * priceMap and updates the group header total in-place.
 *
 * Structure targeted:
 *   <div class="stackHeader_meta...">
 *     <span>Qty: 2</span>
 *     <span>Price: <span title="$5.98">$5.98</span></span>
 *   </div>
 */
function updateGroupTotals(priceMap) {
  const SEL_STACK = '[class*="stackWrapper_container"]';

  document.querySelectorAll(SEL_STACK).forEach((stack) => {
    // Tokens/extras were never queried (see extractCardNames), so this
    // stack's own subtotal would always read !hasAnyPrice below and hit the
    // early return anyway — except a version of this extension prior to
    // that exclusion could have written a real BRL total into this exact
    // span already, which would otherwise sit there stale (still "R$ 0,75"
    // for a card no longer priced at all) instead of ever getting reverted,
    // since the code below only ever adds or replaces a total, never clears
    // one — so this stack gets its own explicit revert-to-native pass
    // instead of just relying on the early return.
    const titleEl = stack.querySelector('[class*="stackHeader_title"]');
    if (titleEl?.textContent?.trim() === "Tokens & Extras") {
      const totalSpan = stack.querySelector('[class*="stackHeader_meta"] span[title]');
      const original = totalSpan?.getAttribute("data-lm-original");
      if (original) {
        totalSpan.title = original;
        totalSpan.textContent = original;
        totalSpan.removeAttribute("data-lm-original");
      }
      return;
    }

    let total = 0;
    let hasAnyPrice = false;

    cardEntriesIn(stack).forEach(({ name, qty }) => {
      const info = priceMap[name];
      if (info?.priceMin != null) {
        total += qty * info.priceMin;
        hasAnyPrice = true;
      }
    });

    if (!hasAnyPrice) return;

    // The price total lives in the inner <span title="..."> inside stackHeader_meta.
    const totalSpan = stack.querySelector(
      '[class*="stackHeader_meta"] span[title]',
    );
    if (!totalSpan) return;

    const formatted = `R$ ${total.toFixed(2).replace(".", ",")}`;
    const originalGroupTitle =
      totalSpan.getAttribute("data-lm-original") ??
      totalSpan.textContent.trim();
    totalSpan.setAttribute("data-lm-original", originalGroupTitle);
    // Tooltip stays plain text (title attributes can't carry markup); the
    // visible text gets the BRL part as its own coloured span instead of
    // plain text inheriting the row's default colour.
    totalSpan.title = `${originalGroupTitle}  ·  ${formatted}`;
    totalSpan.textContent = `${originalGroupTitle}  ·  `;
    const brlSpan = document.createElement("span");
    brlSpan.style.color = "#33ac5f";
    brlSpan.textContent = formatted;
    totalSpan.appendChild(brlSpan);
  });

  log("Group totals updated.");
}

// ── Deck header total ─────────────────────────────────────────────────────────
// The "Est cost: $231,48" trigger button in the deck header — CSS-module
// class hash changes between deploys same as the card-row selectors above,
// so this matches on the stable semantic prefix. Confirmed live 2026-08-21:
// Archidekt has since redesigned this from a plain price span into a
// tooltip-trigger button ("deckPrice_trigger__...", not "deckPrice_orange__..."
// as before), which is why the old selector stopped matching anything.
const SEL_DECK_EST_COST = '[class*="deckPrice_trigger"]';
const DECK_TOTAL_BRL_CLASS = "lm-ext-deck-total-brl";

/**
 * Sums qty × priceMin for every card in the entire deck (all groups except
 * "Maybeboard" and "Tokens & Extras" — neither is actually in the deck, per
 * Archidekt's own tooltip on the latter) and shows it as its own green span
 * next to Archidekt's own "Est cost: $X" trigger button, the same way
 * updateGroupTotals adds one per group — appended alongside the existing
 * content rather than overwriting it, so Archidekt's own price and label
 * stay exactly as they are.
 */
function updateDeckTotal(priceMap) {
  const SEL_STACK = '[class*="stackWrapper_container"]';
  const SEL_STACK_TITLE = '[class*="stackHeader_title"]';

  let total = 0;
  let hasAnyPrice = false;

  document.querySelectorAll(SEL_STACK).forEach((stack) => {
    const titleEl = stack.querySelector(SEL_STACK_TITLE);
    const stackName = titleEl?.textContent?.trim();
    if (stackName === "Maybeboard" || stackName === "Tokens & Extras") return;

    cardEntriesIn(stack).forEach(({ name, qty }) => {
      const info = priceMap[name];
      if (info?.priceMin != null) {
        total += qty * info.priceMin;
        hasAnyPrice = true;
      }
    });
  });

  if (!hasAnyPrice) return;

  const estCostButton = document.querySelector(SEL_DECK_EST_COST);
  if (!estCostButton) return;

  const brlDeckTotal = `R$ ${total.toFixed(2).replace(".", ",")}`;
  let brlSpan = estCostButton.querySelector(`.${DECK_TOTAL_BRL_CLASS}`);
  if (!brlSpan) {
    brlSpan = document.createElement("span");
    brlSpan.className = DECK_TOTAL_BRL_CLASS;
    Object.assign(brlSpan.style, { color: "#33ac5f", marginLeft: "6px" });
    estCostButton.appendChild(brlSpan);
  }
  brlSpan.textContent = `· ${brlDeckTotal}`;
  log(`Deck total updated: ${brlDeckTotal}`);
}
// ── Main run ──────────────────────────────────────────────────────────────────
function run() {
  chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
    if (chrome.runtime.lastError) {
      log("Could not read settings:", chrome.runtime.lastError.message);
      return;
    }
    if (settings?.overlayArchidekt === false) {
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
      applyDetailAndGridPrices(priceMap, openLigaMagicOnClick);

      const missingNames = names.filter((n) => !priceMap[n]);
      renderPendingPricesButton({
        missingNames,
        onDone: () => {
          // applyPrices() marks every price link PROCESSED_ATTR regardless
          // of whether a price was found, so a plain re-run would skip them
          // and never pick up the price the backfill just cached — clear
          // the marker on exactly the links whose card was missing.
          // applyDetailAndGridPrices() needs no equivalent: it reconciles
          // each row against the pill already there, so re-running is enough
          // on its own to redraw one whose price just arrived.
          document.querySelectorAll(SEL_PRICE_LINK).forEach((linkEl) => {
            const row = linkEl.closest(SEL_CARD_ROW);
            const name = cardNameOf(row?.querySelector(SEL_CARD_BUTTON));
            if (name && missingNames.includes(name)) linkEl.removeAttribute(PROCESSED_ATTR);
          });
          run();
        },
        log,
        contextName: getViewedDeckName(),
        mountAfter: findToolbarAnchor(),
        // The toolbar row already spaces its own children with a flexbox
        // "gap" (7px, measured live) rather than per-item margins like
        // Moxfield — nothing extra to add here, it applies automatically to
        // this button too once inserted as a sibling.
        toolbarGap: "0px",
        // Matches the "More" button's own rendered height (measured live:
        // 39px) — its padding/font-size don't line up with ours closely
        // enough for padding alone to land on the same height.
        btnHeight: "39px",
        checkPriceColumnEnabled: isPriceColumnEnabled,
        priceColumnHelp: ARCHIDEKT_PRICE_COLUMN_HELP,
      });
    });
  });
}

// ── SPA observer ──────────────────────────────────────────────────────────────
// Archidekt is a React SPA. Card rows are added/removed as the user switches
// deck views. observeAndRerun debounces mutations so a burst of DOM changes
// triggers one run, and does the initial run for content already rendered.
// SEL_CARD_NAMEBOX also triggers a re-run: switching to Grid view or opening
// the card detail modal never adds a SEL_CARD_ROW (that's text-view-only),
// but both always mount a fresh cardLoader_namebox.
observeAndRerun(
  (mutations) => hasAddedNodeMatching(mutations, SEL_CARD_ROW) || hasAddedNodeMatching(mutations, SEL_CARD_NAMEBOX),
  run,
);
