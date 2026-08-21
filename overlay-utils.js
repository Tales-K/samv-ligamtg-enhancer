/**
 * Shared helpers for the three site-specific price overlays (Archidekt,
 * Moxfield, Scryfall). Each site's DOM/selectors are genuinely different
 * (that part stays in the site-specific file), but all three duplicated the
 * same price-formatting, background-messaging, and debounced-observer
 * boilerplate — this file is that shared half. Listed first in each
 * overlay's content_scripts entry in manifest.json, same pattern as
 * content-utils.js for the ligamagic.com.br bundle.
 */

// Shared on/off gate for every log this file (and the site overlays that
// depend on it) can produce — both createLogger's trace output and
// logNotShown's "why didn't this render" warnings check the same flag,
// instead of the trace being a build-time constant and the warnings being
// unconditional like they used to be. It's a real chrome.storage setting
// (showDebugLogs, see DEFAULT_SETTINGS in background.js), off by default and
// surfaced only through a hidden checkbox in the popup footer (click the
// version number) — so a user can turn logging on in their own browser to
// help diagnose something without needing a dev build, but it stays quiet
// for everyone else. Fetched once per page load; a mid-session toggle in the
// popup takes effect on the next page load/reload, same as every other
// setting these overlays read.
let logsEnabled = false;
chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
  if (!chrome.runtime.lastError) logsEnabled = settings?.showDebugLogs === true;
});

function createLogger(siteName) {
  return (...args) => {
    if (logsEnabled) console.log(`[LigaMagic Tracker | ${siteName}]`, ...args);
  };
}

/**
 * Logs why an injected control (button, panel entry, whatever) did NOT
 * render — via console.warn rather than console.log so it stands out from
 * createLogger's trace when both are on, but gated behind the exact same
 * logsEnabled flag. Call only on the failure/skip path; a control that
 * renders fine doesn't need one of these.
 */
function logNotShown(siteName, controlName, reason) {
  if (!logsEnabled) return;
  console.warn(`[LigaMagic Tracker | ${siteName}] "${controlName}" não exibido — ${reason}`);
}

const LIGAMAGIC_BASE = "https://www.ligamagic.com.br/?view=cards%2Fcard&card=";

// Same purple the extension's popup and its LigaMagic-side injections use,
// so anything this extension adds elsewhere (Scryfall included) reads as
// ours at a glance instead of passing for a native control.
const SAMV_PURPLE = "#6d4fc4";
const SAMV_PURPLE_HOVER = "#7c5ce0";
const SAMV_PURPLE_TEXT = "#f5f3ff";

/** Paints one injected button purple, with a lighter purple on hover. */
function applySamvButtonStyle(el) {
  const paint = (bg) => {
    el.style.setProperty("background", bg, "important");
    el.style.setProperty("color", SAMV_PURPLE_TEXT, "important");
    el.style.setProperty("border-color", bg, "important");
  };
  paint(SAMV_PURPLE);
  el.addEventListener("mouseenter", () => paint(SAMV_PURPLE_HOVER));
  el.addEventListener("mouseleave", () => paint(SAMV_PURPLE));
  return el;
}

/**
 * Strips MTG Arena's "A-" rebalance marker from a card name (e.g.
 * "A-Dungeon Descent" -> "Dungeon Descent"). That prefix marks a card
 * rebalanced for Alchemy, an Arena-only digital variant with no paper
 * printing, so LigaMagic (a paper-card marketplace) never carries anything
 * under the exact "A-..." name -- a price lookup for it fails outright even
 * though the underlying card exists on LigaMagic under its plain name.
 * Matched narrowly (capital letter right after the dash) since no real
 * Magic card name otherwise starts with a bare "A-".
 */
function stripArenaAlchemyPrefix(name) {
  return name.replace(/^A-(?=[A-Z])/, "");
}

function priceColor(updatedAt) {
  if (!updatedAt) return "#ef4444"; // red   — not in DB
  const age = Date.now() - new Date(updatedAt).getTime();
  const DAY = 86_400_000;
  if (age < 7 * DAY) return "#33ac5f"; // green  — < 1 week
  if (age < 30 * DAY) return "#cfad25"; // yellow — 1 week – 1 month
  return "#c73b3b"; // red    — older than 1 month
}

/**
 * `spaced` preserves each site's existing exact output rather than silently
 * unifying them: Archidekt has always shown "R$ 5,00" (spaced), Moxfield and
 * Scryfall "R$5,00" (not). The no-price case ("R$ —") is spaced everywhere.
 */
function fmtBRL(value, { spaced = false } = {}) {
  if (value == null) return "R$ —";
  const amount = value.toFixed(2).replace(".", ",");
  return spaced ? `R$ ${amount}` : `R$${amount}`;
}

function logPriceMap(log, priceMap, allNames) {
  if (!logsEnabled) return;
  allNames.forEach((name) => {
    const info = priceMap[name];
    if (info) {
      const date = new Date(info.updatedAt).toLocaleString("pt-BR");
      log(`  ${name}: R$ ${info.priceMin?.toFixed(2) ?? "—"} (atualizado em ${date})`);
    } else {
      log(`  ${name}: no price in DB`);
    }
  });
}

function queryPrices(log, names, callback) {
  chrome.runtime.sendMessage({ action: "queryPrices", cards: names }, (response) => {
    if (chrome.runtime.lastError) {
      log("Background error:", chrome.runtime.lastError.message);
      callback({});
      return;
    }
    callback(response?.prices ?? {});
  });
}

/** True if any mutation added an element matching (or containing) `selector`. */
function hasAddedNodeMatching(mutations, selector) {
  return mutations.some((m) =>
    [...m.addedNodes].some(
      (n) => n.nodeType === Node.ELEMENT_NODE && (n.matches?.(selector) || n.querySelector?.(selector)),
    ),
  );
}

/**
 * Wires up a MutationObserver on document.body: whenever `shouldRun(mutations)`
 * returns true, `runFn` fires once, 600ms after the last qualifying mutation
 * (bursts of DOM changes collapse into a single run). Also runs once
 * immediately for content already rendered when the script is injected.
 */
function observeAndRerun(shouldRun, runFn) {
  let debounceTimer = null;
  const scheduleRun = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runFn, 600);
  };

  new MutationObserver((mutations) => {
    if (shouldRun(mutations)) scheduleRun();
  }).observe(document.body, { childList: true, subtree: true });

  scheduleRun();
}

// ── Pending-prices backfill button ──────────────────────────────────────────
const PENDING_PRICES_WRAPPER_ID = "lm-ext-pending-prices-wrapper";
const PENDING_PRICES_BTN_ID = "lm-ext-pending-prices-btn";
const PENDING_PRICES_MSG_ID = "lm-ext-pending-prices-msg";
// Same green updateDeckTotal/updateGroupTotals use for a healthy value.
const PENDING_PRICES_SUCCESS_COLOR = "#33ac5f";
const PENDING_PRICES_ERROR_COLOR = "#ef4444";
// Same yellow priceColor() uses for "getting stale" — a partial result, not
// an outright failure.
const PENDING_PRICES_WARNING_COLOR = "#cfad25";
const PENDING_PRICES_SUCCESS_MESSAGE_MS = 6000;
// Partial/failure messages list card names, so they run longer and need more
// time on screen than the plain success line.
const PENDING_PRICES_RESULT_MESSAGE_MS = 12000;
// How many unresolved card names to spell out in the completion message
// before summarizing the rest as "e mais N".
const PENDING_PRICES_MAX_LISTED_FAILURES = 5;

// Tracks an in-flight backfill independently of the button *element* —
// Moxfield's SPA can tear down and recreate everything outside its own React
// root at any point (confirmed live: mid-backfill, the button element gets
// replaced), which would otherwise wipe out a "loading" flag stored as a
// dataset attribute on the old, now-detached element and let a fresh render
// start a second backfill on top of the first. `null` when idle.
let pendingPricesState = null; // { done, total }

/** Name of the deck/page currently open, read off its own <h1> — every site this runs on titles the page that way. Used to name the single LigaMagic deck the pending-prices backfill manages (see contextName below), but only the first time that deck is ever created on an account — never a fixed literal. */
function getViewedDeckName() {
  return document.querySelector("h1")?.textContent?.trim() || null;
}

function createPendingPricesWrapper(mountAfter, toolbarGap, btnPadding, btnBorderRadius, btnHeight) {
  const wrapper = document.createElement("div");
  wrapper.id = PENDING_PRICES_WRAPPER_ID;
  Object.assign(wrapper.style, {
    display: "flex",
    alignItems: "center",
    fontFamily: "inherit",
  });

  const btn = document.createElement("button");
  btn.id = PENDING_PRICES_BTN_ID;
  btn.type = "button";
  Object.assign(btn.style, {
    // border-box so an explicit btnHeight (when given) is the button's full
    // rendered height, padding included, instead of padding adding on top —
    // otherwise matching a neighboring button's exact height would mean
    // reverse-computing padding from its font-size/line-height too.
    boxSizing: "border-box",
    height: btnHeight ?? "auto",
    padding: btnPadding ?? "8px 14px",
    borderRadius: btnBorderRadius ?? "6px",
    border: "none",
    fontSize: "13px",
    fontWeight: "700",
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  });
  applySamvButtonStyle(btn);

  // The message is deliberately NOT a child of `wrapper` — it's appended
  // straight to <body> instead (see getOrCreatePendingPricesMessage) and
  // positioned with "fixed" coordinates computed from the button's own
  // bounding rect at show time. Scryfall's own toolbar row
  // (div.header-control-row) sets `overflow: hidden`, and nothing short of
  // escaping that ancestor entirely keeps an overflowing message from being
  // clipped — a higher z-index doesn't help, since clipping isn't a
  // stacking-order problem. Confirmed live: nested inside the wrapper with
  // `position: absolute`, the message never painted at all on Scryfall, no
  // matter the z-index.
  const msg = getOrCreatePendingPricesMessage();
  msg.dataset.alignRight = mountAfter ? "0" : "1";

  wrapper.appendChild(btn);

  if (mountAfter) {
    // Matches the toolbar's own spacing between its buttons (measured per
    // site — each one uses a different value), so this reads as one more
    // button in that row rather than a bolted-on extra.
    wrapper.style.marginLeft = toolbarGap ?? "12px";
    // A toolbar row can use `align-items: stretch` for its own native items
    // (confirmed live on Moxfield's `.col-auto.d-flex` — `align-items:
    // normal`, which resolves to stretch), which would otherwise stretch
    // this wrapper's box to the row's own height and throw off exactly the
    // vertical centering the row's native items already get for free from
    // their own smaller line-height. `align-self: center` opts this one
    // item out of that stretch without touching the row's CSS at all.
    wrapper.style.alignSelf = "center";
    mountAfter.insertAdjacentElement("afterend", wrapper);
  } else {
    Object.assign(wrapper.style, {
      position: "fixed",
      bottom: "20px",
      right: "20px",
      zIndex: "999999",
      boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
    });
    document.body.appendChild(wrapper);
  }

  return { wrapper, btn, msg };
}

/** Singleton: reused across re-renders (e.g. Moxfield's SPA tearing the
 * toolbar button down and recreating it) instead of piling up detached
 * copies under <body>, since this extension only ever shows one
 * pending-prices message at a time regardless of site. */
function getOrCreatePendingPricesMessage() {
  let msg = document.getElementById(PENDING_PRICES_MSG_ID);
  if (msg) return msg;

  msg = document.createElement("div");
  msg.id = PENDING_PRICES_MSG_ID;
  Object.assign(msg.style, {
    display: "none",
    position: "fixed",
    zIndex: "999999",
    background: "rgba(255, 255, 255, 0.97)",
    boxShadow: "0 2px 10px rgba(0, 0, 0, 0.25)",
    borderRadius: "6px",
    padding: "6px 10px",
    fontSize: "12px",
    fontWeight: "600",
    maxWidth: "260px",
    lineHeight: "1.4",
    fontFamily: "inherit",
  });
  document.body.appendChild(msg);

  // Dismiss on click-away, same as any other transient popover — the
  // 6-12s auto-hide timeout alone left it sitting over page content the
  // user had already moved on from.
  document.addEventListener("click", (event) => {
    if (msg.style.display === "none") return;
    if (event.target === msg || msg.contains(event.target)) return;
    if (event.target.id === PENDING_PRICES_BTN_ID) return;
    setPendingPricesMessage(msg, null);
  });

  return msg;
}

/** Positions the (viewport-fixed) message right under the button that
 * triggered it, aligned to whichever edge matches the button's own toolbar
 * alignment (left in toolbar mode, right in Scryfall's floating mode). */
function positionPendingPricesMessage(msg, btn) {
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  msg.style.top = `${rect.bottom + 4}px`;
  if (msg.dataset.alignRight === "1") {
    msg.style.right = `${window.innerWidth - rect.right}px`;
    msg.style.left = "auto";
  } else {
    msg.style.left = `${rect.left}px`;
    msg.style.right = "auto";
  }
}

function setPendingPricesMessage(msg, text, kind, btn) {
  if (!msg) return;
  if (!text) {
    msg.style.display = "none";
    msg.textContent = "";
    return;
  }
  positionPendingPricesMessage(msg, btn ?? document.getElementById(PENDING_PRICES_BTN_ID));
  msg.style.display = "block";
  msg.textContent = text;
  msg.style.color =
    kind === "error"
      ? PENDING_PRICES_ERROR_COLOR
      : kind === "warning"
        ? PENDING_PRICES_WARNING_COLOR
        : PENDING_PRICES_SUCCESS_COLOR;
}

/**
 * Builds the completion message for a pending-prices run, given the total
 * requested and the names LigaMagic's own deck form never accepted (see
 * readInvalidDeckListLines / scrapeBatchViaManagedDeck in background.js —
 * usually cards LigaMagic just doesn't carry under the exact name the site
 * extracted, e.g. a double-faced card's combined "Front // Back" title).
 * Every other requested card got its price loaded normally.
 */
function buildPendingPricesResultMessage(total, failedNames) {
  if (failedNames.length === 0) {
    return { text: "Preços carregados — clique no preço para abrir no LigaMagic.", kind: "success" };
  }

  const succeededCount = total - failedNames.length;
  const listed = failedNames.slice(0, PENDING_PRICES_MAX_LISTED_FAILURES).join(", ");
  const remaining = failedNames.length - PENDING_PRICES_MAX_LISTED_FAILURES;
  const namesText = remaining > 0 ? `${listed} e mais ${remaining}` : listed;

  if (succeededCount === 0) {
    return {
      text: `Nenhum preço carregado. ${failedNames.length} carta(s) não encontrada(s) no LigaMagic: ${namesText}.`,
      kind: "error",
    };
  }
  return {
    text: `${succeededCount} preço(s) carregado(s). ${failedNames.length} carta(s) não encontrada(s) no LigaMagic: ${namesText}.`,
    kind: "warning",
  };
}

/**
 * Shows (or updates) a button offering to fetch LigaMagic prices for every
 * card on the page that came back with none. Clicking it asks the background
 * worker to visit each missing card's LigaMagic page in its own background
 * tab (see handleLoadPendingPrices) — the extension's existing card-page
 * scraper picks the price up there exactly as it would if the user had
 * browsed there directly, so this is the same passive scrape, just triggered
 * on demand instead of waiting for the user to stumble onto each card
 * naturally.
 *
 * Shared by every site this extension overlays (Moxfield, Archidekt,
 * Scryfall) — only the site-specific selectors and DOM structure live in
 * each one's own file; this function is the reusable rest: mounting,
 * validation, progress tracking, and messaging are identical everywhere.
 *
 * @param {object} opts
 * @param {string[]} opts.missingNames
 * @param {() => void} opts.onDone   called once the backfill finishes, so the
 *   caller can re-query prices and redraw.
 * @param {(...args: any[]) => void} opts.log
 * @param {string} [opts.siteName] site label for logNotShown when this
 *   button doesn't render (e.g. "Moxfield") — falls back to a generic label
 *   if a caller hasn't been updated to pass it yet.
 * @param {string} [opts.contextName] name of the deck/page the missing cards
 *   came from (e.g. the Moxfield deck being viewed), if the caller has one —
 *   used to name the single managed LigaMagic deck this backfill uses,
 *   instead of a fixed literal, but only the first time that deck is ever
 *   created on an account (every later run edits it in place and leaves its
 *   name untouched), so it doesn't look identical across every account
 *   running this extension.
 * @param {HTMLElement} [opts.mountAfter] element to insert the button right
 *   after (toolbar mode — the button becomes a permanent fixture there, like
 *   any other toolbar control). Omit for a floating bottom-right button that
 *   only appears once there's something to fetch (Scryfall — no toolbar slot
 *   to anchor to there).
 * @param {string} [opts.toolbarGap] left margin to use in toolbar mode —
 *   pass whatever that site's own toolbar uses between its buttons (measured
 *   per site, they're not the same), so this one reads as another button in
 *   the row rather than a mismatched extra.
 * @param {string} [opts.btnPadding] vertical/horizontal padding for the
 *   button itself — pass whatever matches the height of a neighboring button
 *   it's mounted next to (e.g. Scryfall's "Filtro padrão" button uses
 *   "5px 10px", 26px tall; the "8px 14px" default is just this button's own
 *   original size, unrelated to any particular site).
 * @param {string} [opts.btnBorderRadius] border-radius for the button — pass
 *   whatever the neighboring button it's mounted next to uses (e.g.
 *   Scryfall's "Filtro padrão" button uses "4px"), so the two read as a
 *   matched pair instead of visibly different controls bolted together; the
 *   "6px" default is this button's own original value.
 * @param {string} [opts.btnHeight] explicit height for the button — pass the
 *   neighboring button's own rendered height (e.g. Archidekt's "More"
 *   button is 39px) when matching it by padding alone isn't reliable
 *   because the two buttons use different font sizes. Omit to size the
 *   button off its padding/font the normal way.
 * @param {() => boolean} [opts.checkPriceColumnEnabled] site-specific check
 *   run at click time, before anything else — if it returns false, a red
 *   error is shown instead of starting the backfill (the missing prices are
 *   never actually missing from LigaMagic in that case, just hidden by the
 *   site's own column toggle, so it would be misleading to try).
 * @param {string} [opts.priceColumnHelp] appended to that error message,
 *   telling the user exactly how to re-enable the column on this site.
 */
function renderPendingPricesButton({
  missingNames,
  onDone,
  log,
  siteName,
  contextName,
  mountAfter,
  toolbarGap,
  btnPadding,
  btnBorderRadius,
  btnHeight,
  checkPriceColumnEnabled,
  priceColumnHelp,
}) {
  const site = siteName ?? "Pending Prices";
  // A backfill is already running — just (re)show its progress, never a
  // fresh clickable button, regardless of what missingNames says right now.
  if (pendingPricesState) {
    const btn = document.getElementById(PENDING_PRICES_BTN_ID);
    if (btn) {
      btn.disabled = true;
      btn.style.cursor = "default";
      btn.textContent = `Carregando ${pendingPricesState.done}/${pendingPricesState.total}…`;
    }
    return;
  }

  let existing = document.getElementById(PENDING_PRICES_WRAPPER_ID);
  // Floating mode (no toolbar slot to occupy) stays hidden until there's
  // actually something to fetch. Toolbar mode is a permanent fixture, like
  // any other button in that bar, so it renders regardless. Once a wrapper
  // exists either way, it's left in place rather than toggled in and out —
  // that also keeps a just-shown message from being yanked away by the next
  // unrelated re-render before its own timeout clears it.
  if (!existing) {
    if (!mountAfter && missingNames.length === 0) {
      logNotShown(
        site,
        "Carregar preços pendentes",
        "modo flutuante (sem ponto de ancoragem no toolbar) e nenhum preço pendente — nada para exibir",
      );
      return;
    }
    // A null mountAfter here isn't necessarily wrong — Scryfall floats by
    // design when it has no anchor to use — so whether that's expected or a
    // real failure is judged where the anchor is looked up (findToolbarAnchor
    // in Moxfield/Archidekt, waitForFilterButton in Scryfall), not here.
    existing = createPendingPricesWrapper(mountAfter, toolbarGap, btnPadding, btnBorderRadius, btnHeight).wrapper;
  }

  const btn = existing.querySelector(`#${PENDING_PRICES_BTN_ID}`);
  const msg = document.getElementById(PENDING_PRICES_MSG_ID);

  btn.disabled = false;
  btn.style.cursor = "pointer";
  btn.textContent =
    missingNames.length > 0
      ? `Carregar preços pendentes (${missingNames.length})`
      : "Carregar preços pendentes";

  btn.onclick = () => {
    setPendingPricesMessage(msg, null);

    if (checkPriceColumnEnabled && !checkPriceColumnEnabled()) {
      setPendingPricesMessage(
        msg,
        `Erro: Coluna de preços não habilitada.${priceColumnHelp ? ` ${priceColumnHelp}` : ""}`,
        "error",
      );
      return;
    }

    if (missingNames.length === 0) {
      setPendingPricesMessage(msg, "Todos os preços já foram carregados.", "success");
      return;
    }

    pendingPricesState = { done: 0, total: missingNames.length };
    btn.disabled = true;
    btn.style.cursor = "default";
    btn.textContent = `Carregando 0/${missingNames.length}…`;

    // The backfill can run for many seconds across several background tabs —
    // too long to trust a single sendMessage response channel to survive (it
    // doesn't; confirmed live: the work finishes and the price cache gets
    // updated correctly, but the response callback below never fires). So
    // this listens for the background's own progress messages instead of
    // waiting on loadPendingPrices's response — done >= total on the last one
    // doubles as the completion signal.
    const listener = (m) => {
      if (m.action !== "pendingPricesProgress") return;
      pendingPricesState = { done: m.done, total: m.total };
      const liveBtn = document.getElementById(PENDING_PRICES_BTN_ID);
      if (liveBtn) liveBtn.textContent = `Carregando ${m.done}/${m.total}…`;
      if (m.done < m.total) return;
      chrome.runtime.onMessage.removeListener(listener);
      pendingPricesState = null;

      const liveMsg = document.getElementById(PENDING_PRICES_MSG_ID);
      const { text, kind } = buildPendingPricesResultMessage(m.total, m.failedNames ?? []);
      setPendingPricesMessage(liveMsg, text, kind);
      const messageDurationMs = kind === "success" ? PENDING_PRICES_SUCCESS_MESSAGE_MS : PENDING_PRICES_RESULT_MESSAGE_MS;
      setTimeout(() => {
        if (document.getElementById(PENDING_PRICES_MSG_ID) === liveMsg) {
          setPendingPricesMessage(liveMsg, null);
        }
      }, messageDurationMs);

      onDone();
    };
    chrome.runtime.onMessage.addListener(listener);

    chrome.runtime.sendMessage({ action: "loadPendingPrices", cards: missingNames, contextName }, () => {
      if (chrome.runtime.lastError) log("Background error:", chrome.runtime.lastError.message);
    });
  };
}
