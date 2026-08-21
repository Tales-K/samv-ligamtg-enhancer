/**
 * Adds a "Carregar Tags" button and a "Carregar Preço" button, side by side,
 * to each card's prints box on Scryfall.
 *
 * "Carregar Tags" fetches community tags from Scryfall Tagger on click and
 * renders them as a prints-table -- the same markup the site's own "Faces,
 * Tokens & Other Parts" box uses, so its own CSS styles the table and rows
 * for us. Each tag row also gets two small icon buttons (copy / add to the
 * search field), which are the one bit of custom styling in here.
 *
 * "Carregar Preço" triggers, on demand, the same per-card BRL price lookup
 * overlay-scryfall.js's automatic run() already performs (see
 * loadPriceForBlock there) -- shown only for a block that doesn't have the
 * price column yet, independently of whatever state the tags button/box is
 * in.
 *
 * Works on the same pages as overlay-scryfall.js: individual card pages and
 * search results in "full" view -- both render div.inner-flex > div.prints.
 *
 * Depends on: overlay-utils.js (createLogger, applySamvButtonStyle, SAMV_PURPLE)
 * and overlay-scryfall.js (hasPriceColumn, loadPriceForBlock).
 */

const tagsLog = createLogger("Scryfall Tags");

// Scoped to the card-profile parent, not just the bare "inner-flex" layout
// class — see the matching comment on SEL_CARD_BLOCK in overlay-scryfall.js
// for why (that generic class also matches the Toolbox panel and page
// footer on an individual card page, neither of which is a real card block).
const SEL_TAGS_CARD_BLOCK = "div.card-profile > div.inner-flex";
const TAGS_BOX_CLASS = "custom-tags-box";
const PRICE_BOX_CLASS = "custom-price-box";
const ACTIONS_WRAPPER_CLASS = "custom-actions-box";
// Guards injection of the shared actions wrapper (Tags + Price) per block --
// an idempotency guard against re-running on every observeAndRerun pass, not
// a "these are loaded" flag: each button's own visibility is decided
// separately at injection time (see injectActionsBox).
const TAGS_PROCESSED_ATTR = "data-lm-scryfall-tags-processed";
const SEARCH_FIELD_SELECTOR = "#header-search-field";

/**
 * The current print's set code and collector number, read from the same
 * "prints-current" marker the site itself uses to highlight which row of
 * the prints table is the one being viewed right now -- present both on a
 * single card page and on each card's own block in a search results page.
 */
function extractSetAndNumber(block) {
  const current = block.querySelector("div.prints .prints-current");
  if (!current) return null;
  const setHref = current.querySelector(".prints-current-set")?.getAttribute("href");
  const setMatch = setHref?.match(/\/sets\/([a-z0-9]+)/i);
  const numberMatch = current.textContent.match(/#(\S+)/);
  if (!setMatch || !numberMatch) return null;
  return { set: setMatch[1].toLowerCase(), number: numberMatch[1] };
}

// ── Tag row icon buttons ─────────────────────────────────────────────────────
const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Builds a Feather/Lucide-style 24x24 icon (thicker stroke reads better at
 * this button's small size than a single thin <path> does).
 */
function createIconSvg(kind) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  // Scryfall's own global CSS positions, sizes and fills every <svg> for its
  // icon sprite system, and CSS outranks SVG presentation attributes -- so
  // everything that shapes these icons has to be set inline with !important
  // or they end up out of the button's flex layout and painted as blobs.
  svg.style.position = "static";
  svg.style.overflow = "visible";
  [
    ["width", "17px"],
    ["height", "17px"],
    ["fill", "none"],
    ["stroke", "currentColor"],
    ["stroke-width", "2"],
    ["stroke-linecap", "round"],
    ["stroke-linejoin", "round"],
    ["background", "none"],
    ["border", "none"],
    ["border-radius", "0"],
    ["box-shadow", "none"],
  ].forEach(([prop, value]) => svg.style.setProperty(prop, value, "important"));

  const shape = (tag, attrs) => {
    const el = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    el.style.setProperty("fill", "none", "important");
    el.style.setProperty("stroke", "currentColor", "important");
    svg.appendChild(el);
  };

  if (kind === "copy") {
    shape("rect", { x: 9, y: 9, width: 13, height: 13, rx: 2, ry: 2 });
    shape("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" });
  } else if (kind === "search") {
    shape("circle", { cx: 11, cy: 11, r: 8 });
    shape("line", { x1: 21, y1: 21, x2: 16.65, y2: 16.65 });
  } else if (kind === "check") {
    shape("path", { d: "M4.5 12.75l6 6 9-13.5" });
  }
  return svg;
}

function iconButton(kind, title) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.title = title;
  btn.setAttribute("aria-label", title);
  Object.assign(btn.style, {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "25px",
    height: "25px",
    padding: "0",
    margin: "0",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    flexShrink: "0",
  });
  btn.appendChild(createIconSvg(kind));
  applySamvButtonStyle(btn);
  return btn;
}

/** Swaps the icon for a checkmark for a moment, to confirm the click did something. */
function flashCheckmark(btn, kind) {
  btn.replaceChild(createIconSvg("check"), btn.querySelector("svg"));
  setTimeout(() => {
    const current = btn.querySelector("svg");
    if (current) btn.replaceChild(createIconSvg(kind), current);
  }, 900);
}

function copyTagToClipboard(slug, btn) {
  navigator.clipboard.writeText(`otag:${slug}`).then(() => flashCheckmark(btn, "copy"));
}

/** Appends the tag to the site's own search field without submitting it. */
function addTagToSearchField(slug, btn) {
  const field = document.querySelector(SEARCH_FIELD_SELECTOR);
  if (!field) return;
  const current = field.value.trim();
  field.value = current ? `${current} otag:${slug}` : `otag:${slug}`;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.focus();
  field.setSelectionRange(field.value.length, field.value.length);
  flashCheckmark(btn, "search");
}

function buildTagRow(slug) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  Object.assign(td.style, { display: "flex", alignItems: "center", paddingRight: "10px" });

  const label = document.createElement("span");
  label.textContent = slug;
  label.style.flex = "1";
  td.appendChild(label);

  // A <div>, not a <span> -- the site's own prints-table CSS reserves a
  // fixed column width for a bare <span> inside td (used elsewhere for
  // rarity/set icons), which would otherwise stretch this wrapper out and
  // leave the buttons stranded mid-row instead of flush against the edge.
  const actions = document.createElement("div");
  Object.assign(actions.style, { display: "inline-flex", alignItems: "center", gap: "6px", marginLeft: "8px" });

  const copyBtn = iconButton("copy", "Copiar tag");
  copyBtn.addEventListener("click", () => copyTagToClipboard(slug, copyBtn));
  actions.appendChild(copyBtn);

  const addBtn = iconButton("search", "Adicionar à pesquisa");
  addBtn.addEventListener("click", () => addTagToSearchField(slug, addBtn));
  actions.appendChild(addBtn);

  td.appendChild(actions);
  tr.appendChild(td);
  return tr;
}

function buildTagsTable(tags) {
  const table = document.createElement("table");
  table.className = "prints-table";
  table.innerHTML = "<thead><tr><th><span>Tags</span></th></tr></thead>";

  const tbody = document.createElement("tbody");
  if (tags.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.textContent = "Nenhuma tag encontrada";
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    tags.forEach(({ slug }) => tbody.appendChild(buildTagRow(slug)));
  }
  table.appendChild(tbody);
  return table;
}

// ── Actions wrapper (Tags box + Price button, side by side) ─────────────────
/** Spacing from the prints block above -- lives on the outer wrapper only; the
 * boxes/buttons nested inside it don't need their own copy. */
function applyBoxSpacing(box) {
  box.style.marginTop = "12px";
}

/**
 * Shared flex row that holds the Tags box and the Price button next to each
 * other, gap-separated rather than margin-separated so nothing looks
 * lopsided if only one of the two ends up present. flex-wrap covers the
 * moment the Tags box turns into a full-width table (see loadTags) -- the
 * Price button (if still present) wraps onto its own line instead of being
 * squeezed.
 */
function createActionsWrapper() {
  const wrapper = document.createElement("div");
  wrapper.className = ACTIONS_WRAPPER_CLASS;
  applyBoxSpacing(wrapper);
  Object.assign(wrapper.style, {
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-start",
    gap: "8px",
    flexWrap: "wrap",
  });
  return wrapper;
}

function buildErrorBox(message, coords) {
  const box = document.createElement("div");
  box.className = TAGS_BOX_CLASS;
  Object.assign(box.style, { display: "flex", flexDirection: "column", alignItems: "center", gap: "6px" });

  const msg = document.createElement("div");
  msg.textContent = message;
  box.appendChild(msg);

  const retryButton = document.createElement("button");
  retryButton.type = "button";
  retryButton.className = "button-n";
  retryButton.textContent = "Tentar novamente";
  applySamvButtonStyle(retryButton);
  retryButton.addEventListener("click", () => rebuildInitialBox(box, coords));
  box.appendChild(retryButton);

  return box;
}

function buildInitialBox(coords) {
  const box = document.createElement("div");
  box.className = TAGS_BOX_CLASS;
  Object.assign(box.style, { display: "flex", justifyContent: "center" });

  const button = document.createElement("button");
  button.type = "button";
  button.className = "button-n";
  button.textContent = "Carregar Tags";
  applySamvButtonStyle(button);
  button.addEventListener("click", () => loadTags(box, button, coords));

  box.appendChild(button);
  return box;
}

function rebuildInitialBox(oldBox, coords) {
  const fresh = buildInitialBox(coords);
  oldBox.replaceWith(fresh);
}

function loadTags(box, button, coords) {
  button.disabled = true;
  button.textContent = "Carregando...";

  chrome.runtime.sendMessage({ action: "fetchCardTags", set: coords.set, number: coords.number }, (response) => {
    if (chrome.runtime.lastError) {
      box.replaceWith(buildErrorBox("Erro ao buscar tags.", coords));
      return;
    }
    if (response?.error) {
      box.replaceWith(buildErrorBox(response.error, coords));
      return;
    }
    // The table is full-width native markup, not the centered button/error
    // layout, so the box's own flex centering is dropped.
    box.removeAttribute("style");
    box.replaceChildren(buildTagsTable(response?.tags ?? []));
  });
}

/**
 * "Carregar Preço" button -- on-demand counterpart to the price column
 * overlay-scryfall.js's automatic run() already adds. Its own box is
 * self-contained: once the lookup succeeds the price shows inline in the
 * prints-table column exactly as it would have automatically, so there's
 * nothing left for this box to display and it just removes itself.
 *
 * It was shown because the column wasn't there *yet* at injection time --
 * overlay-scryfall.js's own automatic run() can still be mid-flight (it's a
 * getSettings + queryPrices round trip through the background worker) and
 * fill the column in a moment later on its own. A small observer scoped to
 * just this block catches that and removes the now-redundant button without
 * the user having to click it.
 */
function buildPriceButtonBox(block) {
  const box = document.createElement("div");
  box.className = PRICE_BOX_CLASS;
  Object.assign(box.style, { display: "flex", justifyContent: "center" });

  const button = document.createElement("button");
  button.type = "button";
  button.className = "button-n";
  button.textContent = "Carregar Preço";
  applySamvButtonStyle(button);
  button.addEventListener("click", () => {
    button.disabled = true;
    button.textContent = "Carregando...";
    autoRemoveObserver.disconnect();
    loadPriceForBlock(block, (ok) => {
      if (ok) {
        box.remove();
      } else {
        button.disabled = false;
        button.textContent = "Carregar Preço";
      }
    });
  });

  const autoRemoveObserver = new MutationObserver(() => {
    if (hasPriceColumn(block)) {
      autoRemoveObserver.disconnect();
      box.remove();
    }
  });
  autoRemoveObserver.observe(block, { attributes: true, attributeFilter: [PROCESSED_ATTR] });

  box.appendChild(button);
  return box;
}

/**
 * Injects the shared Tags + Price actions row into a card block. The two
 * buttons' visibility is decided independently -- Tags shows unless this
 * layout isn't tracked by Tagger (no coords) or the setting disables it;
 * Price shows unless the column has already been added for this block (see
 * hasPriceColumn in overlay-scryfall.js) -- neither condition depends on the
 * other, so e.g. a layout Tagger doesn't cover still gets a Price button on
 * its own.
 */
function injectActionsBox(block, tagsEnabled) {
  if (block.hasAttribute(TAGS_PROCESSED_ATTR)) return;
  const prints = block.querySelector("div.prints");
  if (!prints) {
    logNotShown("Scryfall Tags", "Carregar Tags / Carregar Preço", 'elemento "div.prints" não encontrado no bloco da carta');
    return;
  }

  const coords = extractSetAndNumber(block);
  const showTags = tagsEnabled && !!coords;
  const showPrice = !hasPriceColumn(block);
  // Not logged when both end up false: that's the routine, expected state
  // for most blocks (tags disabled and/or price column already loaded), not
  // a failure — logging it here would drown out real signal in noise.
  if (!showTags && !showPrice) return;

  const wrapper = createActionsWrapper();
  if (showTags) wrapper.appendChild(buildInitialBox(coords));
  if (showPrice) wrapper.appendChild(buildPriceButtonBox(block));

  prints.appendChild(wrapper);
  block.setAttribute(TAGS_PROCESSED_ATTR, "1");
}

function runActionsOverlay() {
  chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
    if (chrome.runtime.lastError) {
      logNotShown("Scryfall Tags", "Carregar Tags / Carregar Preço", `erro ao ler configurações — ${chrome.runtime.lastError.message}`);
      return;
    }
    const tagsEnabled = settings?.addScryfallTagsButton !== false;
    document.querySelectorAll(SEL_TAGS_CARD_BLOCK).forEach((block) => injectActionsBox(block, tagsEnabled));
  });
}

observeAndRerun((mutations) => hasAddedNodeMatching(mutations, SEL_TAGS_CARD_BLOCK), runActionsOverlay);
