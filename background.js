/**
 * Background service worker — the single place that owns:
 *   - Storage reads/writes
 *
 * Content scripts and popup only scrape DOM / render UI, then delegate here
 * via chrome.runtime.sendMessage({ action: "sendPrices", cards }).
 *
 * Everything is local: no network requests are made and no data ever leaves
 * the browser. Prices scraped on LigaMagic are cached in chrome.storage.local
 * and reused to power the overlays on Archidekt/Moxfield/Scryfall — there is
 * no shared/remote database, so a price only shows up on those sites if this
 * browser has itself scraped that card on LigaMagic that day.
 */

// ── Lifecycle ────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  seedStoreIdCache().catch(() => {});
  registerSearchCardContextMenu();
});

// ── "Pesquisar carta" context menu ───────────────────────────────────────────
// Right-click on selected text anywhere in the browser (not limited to
// LigaMagic/Archidekt/Moxfield/Scryfall — a name can be selected on any
// page) offers a search on each of the three sites this extension already
// links out to elsewhere (card-hover-links.js's own Scryfall/EDHREC
// buttons, LIGAMAGIC_BASE everywhere else).
const SEARCH_MENU_ROOT_ID = "lm-ext-search-card";
const SEARCH_MENU_TARGETS = {
  "lm-ext-search-card-ligamagic": {
    title: "LigaMagic",
    // Same URL every card-price link elsewhere in this extension already
    // uses. LigaMagic's own search there tolerates an inexact name --
    // confirmed live: a name that doesn't match anything verbatim still
    // lands on a results page listing near-matches, rather than a dead
    // end, so a rough / partial text selection still gets somewhere useful.
    buildUrl: (text) => `https://www.ligamagic.com.br/?view=cards%2Fcard&card=${encodeURIComponent(text)}`,
  },
  "lm-ext-search-card-scryfall": {
    title: "Scryfall",
    // A plain (non-quoted) search, unlike card-hover-links.js's own
    // scryfallSearchUrl -- that one wraps a name already known to be
    // exact (extracted from LigaMagic's own DOM) in `!"..."` for a single
    // precise match. Text selected by hand on an arbitrary page has no
    // such guarantee, so this uses Scryfall's normal fuzzy search instead,
    // which still finds the card off a rough or partial selection.
    buildUrl: (text) => `https://scryfall.com/search?q=${encodeURIComponent(text)}`,
  },
  "lm-ext-search-card-edhrec": {
    title: "EDHREC",
    // EDHREC has no general full-text search page to link straight into,
    // so this reuses the same front-face-only, accent-stripped slug
    // card-hover-links.js's edhrecCardSlug already builds for a known-exact
    // name -- the tradeoff (and the reason that function's own doc comment
    // exists) is that an imprecise selection lands on a 404 there rather
    // than a results page, same limitation the hover-link feature already
    // has today, not a new one this introduces.
    buildUrl: (text) => {
      const slug = text
        .split(" // ")[0]
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/['’]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      return `https://edhrec.com/cards/${slug}`;
    },
  },
};

/**
 * (Re)builds the submenu from scratch against the current
 * addCardSearchContextMenu setting -- called both at startup and, via
 * saveSettings, right after the popup checkbox changes, so toggling it off
 * removes the menu from the browser immediately, no reload needed.
 */
async function registerSearchCardContextMenu() {
  const settings = await loadSettings();
  // Clears any items a previous install/reload left registered -- create()
  // throws on a duplicate id otherwise, which the dev workflow's repeated
  // chrome.runtime.reload() would hit immediately. Also what turns the whole
  // submenu off when the setting is disabled: removeAll() with nothing
  // recreated after it.
  chrome.contextMenus.removeAll(() => {
    if (settings.addCardSearchContextMenu === false) return;
    chrome.contextMenus.create({
      id: SEARCH_MENU_ROOT_ID,
      title: 'Pesquisar carta "%s"',
      contexts: ["selection"],
    });
    Object.entries(SEARCH_MENU_TARGETS).forEach(([id, { title }]) => {
      chrome.contextMenus.create({ id, parentId: SEARCH_MENU_ROOT_ID, title, contexts: ["selection"] });
    });
  });
}

chrome.contextMenus.onClicked.addListener((info) => {
  const target = SEARCH_MENU_TARGETS[info.menuItemId];
  if (!target || !info.selectionText) return;
  chrome.tabs.create({ url: target.buildUrl(info.selectionText.trim()) });
});

// Any LigaMagic page can carry a `screenfilter.stores` client-side object
// (card listing pages, marketplace search, etc.) — whenever one finishes
// loading, harvest whatever stores it lists into the local cache. See
// handleScrapeStoresFromPage for what's actually extracted.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url?.includes("ligamagic.com.br")) return;
  handleScrapeStoresFromPage(tabId).catch(() => {});
});

// ── Message handler ──────────────────────────────────────────────────────────
/**
 * Accepted messages:
 *   { action: "sendPrices", cards: Card[] }
 *     → filters already-saved-today, writes to local storage, updates badge
 *     → resolves with { skipped?: true } | { newCount, message } | { error }
 *
 *   { action: "queryPrices", cards: string[] }
 *     → looks up card names in the local price cache (built from this
 *       browser's own scrapes) and returns a price map
 *     → resolves with { prices: Record<name, {priceMin, priceAvg, priceMax, updatedAt}> } | { error }
 *
 *   { action: "reinitTooltips" }
 *     → re-runs the LigaMagic deck page's own hover-tooltip init in the
 *       page's MAIN world (see handleReinitTooltips) — fire-and-forget
 *
 *   { action: "getCardEditionsPrices" }
 *     → reads editionsCard.jsonEditions off an individual card page — the
 *       page's own already-loaded per-edition price data (see
 *       handleGetCardEditionsPrices) — a page MAIN-world global, so only the
 *       background worker can reach it
 *     → resolves with { idkey, price }[] | null
 *

 *   { action: "getStoreCache" }
 *     → returns every store known so far, keyed by store ID — used to
 *       populate the "lojas conhecidas" autocomplete and the popup's "Lojas
 *       conhecidas" list. `domain` is null for stores discovered via page
 *       scraping (see handleScrapeStoresFromPage) whose domain hasn't been
 *       resolved yet.
 *     → resolves with Record<id, { id, name, domain: string|null, addedAt }>
 *
 *   { action: "removeStoreCacheEntry", id: string }
 *     → forgets one known store, so it needs to be resolved again next time
 *       it's added by URL
 *     → resolves with { ok: true }
 *
 *   { action: "clearStoreCache" }
 *     → forgets every resolved store
 *     → resolves with { ok: true }
 *
 *   { action: "requestStorePermissions", urls: string[] }
 *     → requests host permission for every not-yet-cached URL in one shot
 *       (see handleRequestStorePermissions) — must be called once, up front,
 *       from a real click handler, before any resolveStoreUrl calls; the
 *       permission prompt only works during a genuine user gesture and that
 *       doesn't survive being split across a per-URL loop
 *     → resolves with { granted: boolean }
 *
 *   { action: "resolveStoreUrl", url: string }
 *     → resolves a store's own website URL to its LigaMagic marketplace ID
 *       (see handleResolveStoreUrl) — cached locally so this only needs to
 *       hit the store's site once per domain, ever. Only *checks* permission
 *       (never requests it) — call requestStorePermissions first.
 *     → resolves with { id, name, domain, fromCache } | { error }
 *
 *   { action: "installSearchOverride" }
 *     → wraps the page's own CardsOrcamento.pesquisar() once so it picks up
 *       checked custom stores when the user clicks the site's own
 *       "Pesquisar" button (see handleInstallSearchOverride) — idempotent,
 *       safe to call on every page load
 *     → resolves with { ok: true } | { error }
 *
 *   { action: "syncCustomStoreIds", storeIds: string[] }
 *     → updates the working set of checked custom store IDs that the
 *       pesquisar() wrapper reads at search time (see
 *       handleSyncCustomStoreIds) — does NOT trigger a search itself
 *     → resolves with { ok: true } | { error }
 *
 *   { action: "getListaResultado" }
 *     → reads the page's own `CardsOrcamento.item.resultado` (see
 *       handleGetListaResultado) — the live per-store/per-card breakdown
 *       "Compra por Lista" results render from, already kept in sync with
 *       whatever the user has removed via the page's own "X" buttons, so
 *       there's nothing to scrape or track separately
 *     → resolves with Record<blocoIndex, StoreBlock> | null
 *
 *   { action: "fetchCardTags", set: string, number: string }
 *     → fetches a card's Scryfall Tagger tags (see handleFetchCardTags),
 *       keeping only "card" namespace tags (oracle tags and the ones they
 *       inherit from an ancestor tag) and dropping "artwork" (illustration)
 *       tags entirely
 *     → resolves with { tags: {name, slug}[] } | { error }
 *
 *   { action: "loadPendingPrices", cards: string[], contextName?: string }
 *     → backfills LigaMagic prices for cards the Archidekt/Moxfield/Scryfall
 *       overlays found no cached price for (see handleLoadPendingPrices):
 *       maintains a single LigaMagic deck this extension owns per account
 *       (id kept in chrome.storage.local, see loadPendingPricesDeck) — the
 *       first ever call creates it, every later call just edits its card
 *       list to the current batch (in batches of up to 100) in a background
 *       tab, and lets the existing deck scraper (scraper-deck.js) read all
 *       their prices off that one page. The deck is never deleted; contextName
 *       (e.g. the Moxfield deck being viewed) only names it at that first
 *       creation (see buildTempDeckName) so the one deck every account ends up
 *       with doesn't carry an identical fixed name across every install.
 *     → fire-and-forget: does NOT use sendResponse (see the handler below for
 *       why). Progress travels back to the calling tab as
 *       { action: "pendingPricesProgress", done, total, failedNames } after
 *       each batch; done >= total on that message doubles as the completion
 *       signal. failedNames accumulates the names of every card LigaMagic's
 *       own deck form rejected as unrecognized (see
 *       scrapeBatchViaManagedDeck) — empty when everything resolved normally.
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "sendPrices") {
    handleSendPrices(request.cards).then(sendResponse);
    return true; // keep channel open for async response
  }
  if (request.action === "queryPrices") {
    handleQueryPrices(request.cards).then(sendResponse);
    return true;
  }
  if (request.action === "getSettings") {
    loadSettings().then(sendResponse);
    return true;
  }
  if (request.action === "saveSettings") {
    saveSettings(request.settings).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (request.action === "reinitTooltips") {
    handleReinitTooltips(sender.tab?.id);
    return false; // fire-and-forget, no response expected
  }
  if (request.action === "getCardEditionsPrices") {
    handleGetCardEditionsPrices(sender.tab?.id).then(sendResponse);
    return true;
  }
  if (request.action === "getStoreCache") {
    loadStoreIdCache().then(sendResponse);
    return true;
  }
  if (request.action === "removeStoreCacheEntry") {
    handleRemoveStoreCacheEntry(request.id).then(sendResponse);
    return true;
  }
  if (request.action === "clearStoreCache") {
    saveStoreIdCache({}).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (request.action === "requestStorePermissions") {
    handleRequestStorePermissions(request.urls).then(sendResponse);
    return true;
  }
  if (request.action === "resolveStoreUrl") {
    handleResolveStoreUrl(request.url).then(sendResponse);
    return true;
  }
  if (request.action === "installSearchOverride") {
    handleInstallSearchOverride(sender.tab?.id).then(sendResponse);
    return true;
  }
  if (request.action === "syncCustomStoreIds") {
    handleSyncCustomStoreIds(request.storeIds, sender.tab?.id).then(sendResponse);
    return true;
  }
  if (request.action === "getListaResultado") {
    handleGetListaResultado(sender.tab?.id).then(sendResponse);
    return true;
  }
  if (request.action === "fetchCardTags") {
    handleFetchCardTags(request.set, request.number).then(sendResponse);
    return true;
  }
  if (request.action === "loadPendingPrices") {
    // Fire-and-forget: this can run for many seconds across several tabs, and
    // an onMessage response channel kept open that long is unreliable — Chrome
    // can silently drop it well before the work (and its side effects) are
    // actually done. Progress/completion travel back to the calling tab as
    // their own one-way chrome.tabs.sendMessage calls instead (see
    // handleLoadPendingPrices), each one self-contained regardless of
    // whatever happened to this original message's channel.
    handleLoadPendingPrices(request.cards, sender.tab?.id, request.contextName);
    return false;
  }
});

// ── Core logic ───────────────────────────────────────────────────────────────
async function handleSendPrices(cards) {
  if (!Array.isArray(cards) || cards.length === 0) {
    return { error: "No cards provided." };
  }

  // Basic lands always answer as a synthetic R$0,00 (see isBasicLandName in
  // handleQueryPrices) regardless of anything stored here, so a real scrape
  // of one — someone browsing its actual LigaMagic page — would only ever
  // sit in the cache unread. Dropped before it's ever written.
  cards = cards.filter((c) => !isBasicLandName(c.name));
  if (cards.length === 0) return { noPrice: true };

  const stats = await loadStats();

  // Cards that have a price at all.
  const cardsWithPrice = cards.filter((c) => c.priceMin != null);
  // Among those, only the ones not yet sent today.
  const newCards = cardsWithPrice.filter((c) => !stats.todayCards[c.name]);

  if (newCards.length === 0) {
    if (cardsWithPrice.length === 0) {
      // Nothing had a price — this is NOT an "already saved today" case.
      return { noPrice: true };
    }
    return { skipped: true, message: "All cards already saved today." };
  }

  const now = Date.now();
  const updatedAt = new Date(now).toISOString();
  const cache = await loadPriceCache();

  newCards.forEach((c) => {
    stats.todayCards[c.name] = {
      priceMin: c.priceMin,
      priceAvg: c.priceAvg,
      priceMax: c.priceMax,
      sentAt: now,
    };
    const entry = {
      name: c.name,
      priceMin: c.priceMin,
      priceAvg: c.priceAvg,
      priceMax: c.priceMax,
      updatedAt,
    };
    cache.prices[priceCacheKey(c.name)] = entry;

    // LigaMagic's own scraped name for a transform/MDFC/split card is the
    // authority on its real "Front // Back" punctuation (confirmed live: it
    // doesn't always match what an overlay guessed when submitting a card —
    // e.g. LigaMagic's own catalogue calls a card "Koma, Cosmos Serpent",
    // comma included, when an overlay's own combined-name guess for the same
    // card had no comma). Indexing this entry under its front face alone too
    // means a later combined-name query for the SAME card — however that
    // query happens to punctuate the back face — still finds it via
    // handleQueryPrices' own front-face fallback, without needing to guess or
    // reproduce LigaMagic's exact punctuation.
    const split = splitFrontBack(c.name);
    if (split) {
      cache.prices[priceCacheKey(split.front)] = entry;
    }
  });
  stats.totalUpdates += newCards.length;
  await saveStats(stats);
  await savePriceCache(cache);

  return {
    newCount: newCards.length,
    message: `${newCards.length} card(s) saved locally.`,
  };
}

/**
 * Splits a combined "Front // Back" card name — a transform/MDFC/split card,
 * however Archidekt/Moxfield/Scryfall happen to hand it over — into its two
 * faces. Returns null for a name with no such separator. The one place this
 * file knows how to recognize/split that punctuation; every step of the
 * price pipeline that needs a face alone (indexing a fresh scrape under its
 * front face too, falling back to a cached front/back face on a query miss,
 * substituting a face LigaMagic's own deck-form validation rejected the
 * combined name for) goes through this instead of re-deriving it locally —
 * see each call site's own comment for why that particular step needs it.
 */
function splitFrontBack(name) {
  const separatorIdx = name.indexOf(" // ");
  if (separatorIdx <= 0) return null;
  return { front: name.slice(0, separatorIdx).trim(), back: name.slice(separatorIdx + 4).trim() };
}

// The 5 basic land types have no real LigaMagic listing worth tracking —
// nobody buys them, and without this they'd sit in every deck's "missing
// prices" count forever, since LigaMagic never returns anything for them.
// Answered with a synthetic R$0,00 entry, computed fresh on every query
// instead of written to the cache once, so it can never be evicted or age
// into yellow/red like a real scrape would — it's always exactly "updated
// now". This alone is also what keeps them out of missingNames on every
// overlay (Archidekt/Moxfield/Scryfall): that list is just "names the query
// came back without an entry for" (see each overlay's own
// `names.filter((n) => !priceMap[n])`), and a basic land never comes back
// without one.
const BASIC_LAND_NAMES = new Set(["plains", "island", "swamp", "mountain", "forest"]);

function isBasicLandName(name) {
  return BASIC_LAND_NAMES.has(name.trim().toLowerCase());
}

function basicLandPriceEntry(name) {
  return {
    name,
    priceMin: 0,
    priceAvg: 0,
    priceMax: 0,
    updatedAt: new Date().toISOString(),
  };
}

async function handleQueryPrices(names) {
  if (!Array.isArray(names) || names.length === 0) {
    return { error: "No card names provided." };
  }

  // Purely a local lookup — only cards this browser has itself scraped on
  // LigaMagic are present in the cache (across any past day; see
  // loadPriceCache). There is no remote fallback.
  const cache = await loadPriceCache();

  // Return only the names that were requested.
  const prices = {};
  names.forEach((n) => {
    if (isBasicLandName(n)) {
      prices[n] = basicLandPriceEntry(n);
      return;
    }

    const direct = cache.prices[priceCacheKey(n)];
    if (direct) {
      prices[n] = direct;
      return;
    }
    // Transform/MDFC/split cards: LigaMagic sometimes only catalogues these
    // under the front face alone, not the combined "Front // Back" form this
    // extension queries by (see scrapeBatchViaManagedDeck's own front-face
    // retry in the pending-prices backfill, and cardNameFromLinkRaw's
    // comments in overlay-moxfield.js). If the front face alone is already
    // priced — from that retry, or from ordinary browsing — it's the same
    // physical card, so it still answers a query for the combined name.
    const split = splitFrontBack(n);
    if (split) {
      const frontFace = cache.prices[priceCacheKey(split.front)];
      if (frontFace) {
        prices[n] = frontFace;
        return;
      }
      // Rarer still: neither the combined name nor the front face is right,
      // only the back face is (see scrapeBatchViaManagedDeck's back-face
      // retry stage — confirmed live for a Moxfield row whose front-face
      // text was actually a printing's cosmetic flavor name, not a real
      // front face at all, so only the card's real oracle name — read off
      // the slug as the "back face" — was ever a valid card to query for).
      const backFace = cache.prices[priceCacheKey(split.back)];
      if (backFace) prices[n] = backFace;
    }
  });
  return { prices };
}

/**
 * Re-runs LigaMagic's own `stickytooltip.init(...)` / `viewdeck.loadStickyLazy()`
 * so the card-hover image tooltip works on rows deck-view.js clones into its
 * custom "Preço" tab (cloneNode() doesn't carry over the original's event
 * bindings, so the page's own init needs to see the new elements).
 *
 * Content scripts run in an isolated JS world and can't call page globals
 * directly. Injecting a literal <script> tag from the content script proved
 * unreliable in testing, so this uses chrome.scripting.executeScript with
 * world: "MAIN" instead — the supported way to run code in the page's own
 * context — which only the background service worker can call.
 */
function handleReinitTooltips(tabId) {
  if (tabId == null) return;
  chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      if (typeof stickytooltip !== "undefined" && typeof stickytooltip.init === "function") {
        stickytooltip.init("*[data-tooltip]", "mystickytooltip");
      }
      if (typeof viewdeck !== "undefined" && typeof viewdeck.loadStickyLazy === "function") {
        viewdeck.loadStickyLazy();
      }
    },
  });
}

/**
 * Reads `editionsCard.jsonEditions` off an individual card page — the same
 * per-edition price data (Normal/Foil min-avg-max) the page uses to update
 * the price panel when the user hovers an edition icon, already loaded with
 * the page and not fetched again per edition. `editionsCard` is a page
 * global, unreachable from the content script's isolated world, so this runs
 * in the MAIN world like handleReinitTooltips above.
 */
async function handleGetCardEditionsPrices(tabId) {
  if (tabId == null) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        if (typeof editionsCard === "undefined" || !editionsCard.jsonEditions) return null;
        return Object.values(editionsCard.jsonEditions).map((e) => ({ idkey: e.idkey, price: e.price }));
      },
    });
    return results[0]?.result ?? null;
  } catch {
    return null;
  }
}

// ── Custom store search ─────────────────────────────────────────────────────
/**
 * Resolves a store's own website (e.g. "https://www.tabernageek.com.br") to
 * its numeric LigaMagic marketplace ID.
 *
 * There is no LigaMagic endpoint that maps a store's domain to its ID — the
 * ID only exists embedded in the store's own page, in an inline
 * `EcomConversion.checkReferrer(<id>, ...)` call. Every
 * store site tested sits behind a real Cloudflare Turnstile challenge, so
 * this opens a real, foregrounded tab and waits for the real page to load —
 * if a challenge appears, the tab stays open and interactive so the user can
 * solve it themselves; this code never attempts to solve or bypass it.
 *
 * Resolved IDs are cached forever per domain (chrome.storage.local), so this
 * flow only ever runs once per store.
 */
function parseStoreUrl(rawUrl) {
  return new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
}

const stripWww = (hostname) => hostname.replace(/^www\./, "");

/**
 * Requests host permission for every URL in one shot. `chrome.permissions.
 * request` only works during a real user gesture (confirmed live — a
 * synthetic click throws "This function must be called during a user
 * gesture"), and content scripts don't have the `chrome.permissions` API at
 * all (confirmed live — `typeof chrome.permissions` is `undefined` there),
 * so this has to run here, triggered by a message from the content script's
 * click handler. That activation is fragile across the hop, so this does
 * zero `await`s before the `request()` call itself — no cache lookup, no
 * `contains()` pre-check, nothing — `chrome.permissions.request` must be the
 * very first async operation in this function. Cache-hit domains still get
 * included in the origins list (a harmless native no-op prompt for origins
 * already granted), which is a fine trade-off for reliability.
 */
async function handleRequestStorePermissions(rawUrls) {
  const origins = [];
  for (const rawUrl of rawUrls) {
    try {
      const url = parseStoreUrl(rawUrl);
      origins.push(`${url.protocol}//${url.hostname}/*`);
    } catch {
      // invalid URLs are reported per-line by resolveStoreUrl instead
    }
  }
  if (origins.length === 0) return { granted: true };

  try {
    const granted = await chrome.permissions.request({ origins });
    return { granted };
  } catch (err) {
    return { granted: false, error: err.message };
  }
}

async function handleResolveStoreUrl(rawUrl) {
  let url;
  try {
    url = parseStoreUrl(rawUrl);
  } catch {
    return { error: "URL inválida." };
  }
  const domain = stripWww(url.hostname);

  const cache = await loadStoreIdCache();
  const cached = Object.values(cache).find((e) => e.domain === domain);
  if (cached) return { ...cached, fromCache: true };

  const origin = `${url.protocol}//${url.hostname}/*`;
  const hasPermission = await chrome.permissions.contains({ origins: [origin] });
  if (!hasPermission) {
    return {
      error:
        "Sem permissão para acessar esse site (chame requestStorePermissions primeiro).",
    };
  }

  let tab;
  try {
    tab = await chrome.tabs.create({ url: url.href, active: true });
    const id = await pollForStoreId(tab.id);
    if (!id) {
      return {
        error:
          "Não consegui encontrar o ID da loja em 60s. Se apareceu uma verificação de segurança, tente de novo depois de resolvê-la.",
      };
    }
    // A page-scrape (handleScrapeStoresFromPage) may have already cached
    // this exact store by ID with a name but no domain yet — fill it in
    // instead of creating a duplicate entry.
    const name = cache[id]?.name ?? (await fetchStoreDetails(id)).name;
    const entry = { id, name, domain, addedAt: Date.now() };
    cache[id] = entry;
    await saveStoreIdCache(cache);
    return { ...entry, fromCache: false };
  } catch (err) {
    return { error: `Falha ao abrir a loja: ${err.message}` };
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/**
 * Polls the tab's own scripts for `EcomConversion.checkReferrer(<id>, ...)`,
 * the only place the store's LigaMagic ID appears. Only present once the
 * real page has loaded — a Cloudflare challenge page never contains it — so
 * this doubles as "wait until past the challenge" with no special-casing.
 */
async function pollForStoreId(tabId, timeoutMs = 60_000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const scripts = [...document.scripts].map((s) => s.textContent).join("\n");
          const m = scripts.match(/checkReferrer\s*\(\s*(\d+)/);
          return m ? m[1] : null;
        },
      });
      if (result) return result;
    } catch {
      // Tab mid-navigation or not yet scriptable — just retry.
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

/**
 * Same-origin, authenticated request; no CAPTCHA involved.
 * The store info modal's HTML includes both the display name and a
 * `store-url` link to the store's real external site — one fetch gets both,
 * no need to ever visit the store's own (Cloudflare-gated) domain just to
 * learn what it is. `domain` is null if the store has none on file.
 */
async function fetchStoreDetails(storeId) {
  try {
    const res = await fetch(
      `https://www.ligamagic.com.br/ajax/mp/actions.php?opc=getStoreData&id=${storeId}&origin=desktop&tcg=1`,
      { credentials: "include", headers: { "x-requested-with": "XMLHttpRequest" } },
    );
    const data = await res.json();
    const nameMatch = data.html?.match(/store-name b'>\s*([^<\n]+)/);
    const urlMatch = data.html?.match(/store-url'>\s*<a href='([^']+)'/);
    let domain = null;
    if (urlMatch) {
      try {
        domain = stripWww(new URL(urlMatch[1]).hostname);
      } catch {
        // malformed store-url value — leave domain null
      }
    }
    return { name: nameMatch ? nameMatch[1].trim() : `Loja ${storeId}`, domain };
  } catch {
    return { name: `Loja ${storeId}`, domain: null };
  }
}

/**
 * Installs a one-time wrapper around the page's own `CardsOrcamento.
 * pesquisar()` so that whenever the user clicks the SITE'S OWN "Pesquisar"
 * button (or "Pesquisar Novamente"), any checked custom stores get merged
 * into the request — without the extension ever firing a search on its own.
 * Adding/checking/removing a custom store only updates the working set
 * (see handleSyncCustomStoreIds); the real search still only happens when
 * the user explicitly asks the page to search, exactly like before this
 * feature existed.
 *
 * This mirrors the request shape `CardsOrcamento.pesquisar()` already sends,
 * supplying our own store ID list via `lojas.favoritas` — the same field
 * that normally carries the account's favorited stores — instead of relying
 * on the page's checkbox UI. When there are checked custom stores, this
 * replaces whatever store selection the native flow would have used with
 * exactly the custom set.
 *
 * Must run in the page's MAIN world — `CardsOrcamento`/`wizard` are page
 * globals, not reachable from the content script's isolated world.
 */
async function handleInstallSearchOverride(tabId) {
  if (tabId == null) return { error: "Aba de origem não encontrada." };
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      if (typeof CardsOrcamento === "undefined" || CardsOrcamento.__lgmWrapped) return;

      const originalPesquisar = CardsOrcamento.pesquisar.bind(CardsOrcamento);
      CardsOrcamento.pesquisar = function (payloadOverride) {
        const customIds = window.__lgmCustomStoreIds || [];
        if (customIds.length === 0) return originalPesquisar(payloadOverride);
        const payload = payloadOverride
          ? JSON.parse(JSON.stringify(payloadOverride))
          : JSON.parse(JSON.stringify(wizard.json));

        // Custom stores only make sense to inject under "Minhas Favoritas +
        // Buscar Lojas" (tipoFiltro "2"): that's the only mode where the
        // search is otherwise restricted to a store list at all. Under
        // "Todas Lojas" (tipoFiltro "1") every store is already included, so
        // forcing tipoFiltro/favoritas here wouldn't add the custom stores —
        // it would silently SHRINK the search down to just them, ignoring
        // whichever filter the user actually has selected right now.
        if (String(payload.lojas?.tipoFiltro) !== "2") return originalPesquisar(payloadOverride);

        payload.cards.forEach((c, i) => {
          c.chaveBusca = i + 1;
        });
        // Whatever the user ticked in the site's own "Lojas Favoritas" list
        // counts too: those checkboxes don't reach the request on their own
        // (the native flow sends the whole favourites list regardless), so
        // they'd otherwise be dropped the moment a custom store was added.
        const favoriteIds = [
          ...document.querySelectorAll('input[name="txt_lojafav[]"]:checked'),
        ].map((el) => el.value);
        const storeIds = [...new Set([...favoriteIds, ...customIds])];
        payload.lojas = {
          ...payload.lojas,
          tipoFiltro: "2",
          favoritas: storeIds,
          quantidadeLimite: String(storeIds.length),
        };
        return originalPesquisar(payload);
      };

      // checkList() runs validaBusca() BEFORE ever calling pesquisar() — when
      // "Minhas Favoritas" is selected, it independently requires at least
      // one native *checkbox* (.txt_lojafav_opc) to be checked, which has
      // nothing to do with our custom set and would block the search before
      // our pesquisar() wrapper ever runs. Only that specific message is
      // swallowed, and only while we actually have custom stores checked AND
      // "Minhas Favoritas" is the mode currently selected -- otherwise
      // (e.g. under "Todas Lojas", where this validation never fires anyway)
      // there's nothing to swallow, and checking the radio here keeps this
      // gate consistent with the pesquisar() override above rather than
      // reacting to leftover custom-store state from a filter that's no
      // longer selected. Every other validation (empty card list, 7000-char
      // limit, card numbering, etc.) still runs untouched.
      const originalValidaBusca = CardsOrcamento.validaBusca.bind(CardsOrcamento);
      CardsOrcamento.validaBusca = function (a) {
        const result = originalValidaBusca(a);
        const customIds = window.__lgmCustomStoreIds || [];
        const tipoFiltroAtual = document.querySelector('input[name="txt_tipo_filtro"]:checked')?.value;
        if (result && customIds.length > 0 && tipoFiltroAtual === "2" && /Lojas Favoritas/.test(result)) {
          return "";
        }
        return result;
      };

      CardsOrcamento.__lgmWrapped = true;
    },
  });
  return { ok: true };
}

/** Updates the MAIN-world global the pesquisar() wrapper reads at search time. */
async function handleSyncCustomStoreIds(storeIds, tabId) {
  if (tabId == null) return { error: "Aba de origem não encontrada." };
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (ids) => {
      window.__lgmCustomStoreIds = ids;
    },
    args: [Array.isArray(storeIds) ? storeIds : []],
  });
  return { ok: true };
}

/**
 * Reads the page's own `CardsOrcamento.item.resultado` — the object the
 * "Compra por Lista" results screen renders from, and the SAME object the
 * page's own "remove item" / "remove store" buttons mutate directly
 * (`delete this.resultado[a].cartas[e]` / `delete this.resultado[a]`). That
 * makes it the single source of truth for "what's actually still in the
 * results right now" — no separate tracking needed on our side for whatever
 * the user has removed.
 *
 * Must run in the page's MAIN world — `CardsOrcamento` is a page global.
 */
async function handleGetListaResultado(tabId) {
  if (tabId == null) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => CardsOrcamento?.item?.resultado ?? null,
    });
    return results[0]?.result ?? null;
  } catch {
    return null; // not a scriptable ligamagic.com.br page right now
  }
}

// ── Store ID cache ───────────────────────────────────────────────────────────
async function loadStoreIdCache() {
  const { storeIdCache } = await chrome.storage.local.get("storeIdCache");
  return storeIdCache ?? {};
}

async function saveStoreIdCache(cache) {
  await chrome.storage.local.set({ storeIdCache: cache });
}

async function handleRemoveStoreCacheEntry(id) {
  const cache = await loadStoreIdCache();
  delete cache[id];
  await saveStoreIdCache(cache);
  return { ok: true };
}

/**
 * Loads the bundled starter set of stores (stores-seed.json), so the store
 * picker is useful from the very first run instead of only after the user
 * has browsed enough card pages for the scraper to have found them. The seed
 * was itself collected by scraping `screenfilter.stores` off the listing
 * pages of a spread of staple cards.
 *
 * Whatever is already cached always wins; this only fills gaps (including
 * back-filling a domain onto an entry that hasn't resolved one yet), so it's
 * safe to re-run on every update without undoing anything the user has
 * discovered since.
 */
async function seedStoreIdCache() {
  const response = await fetch(chrome.runtime.getURL("stores-seed.json"));
  const seed = await response.json();
  const cache = await loadStoreIdCache();

  let added = 0;
  for (const { id, name, domain } of seed) {
    const existing = cache[id];
    if (existing) {
      if (!existing.domain && domain) existing.domain = domain;
      continue;
    }
    cache[id] = { id, name, domain: domain ?? null, addedAt: Date.now() };
    added++;
  }

  await saveStoreIdCache(cache);
  console.log("[LigaMagic Tracker]", `Store seed applied: ${added} new, ${seed.length} total.`);
}

// ── Store scraping (card listing pages, marketplace search, etc.) ──────────────
// How many still-domainless cache entries get a fetchStoreDetails() call per
// page visit. Each fetchStoreDetails() call is cheap (same-origin, no tab),
// but the whole batch still runs as one long-lived async chain off a
// chrome.tabs.onUpdated listener — and that's NOT the same as a tracked
// extension event the service worker's idle/lifetime timer accounts for, so
// a big batch risks the SW being torn down mid-loop with no error, silently
// abandoning whatever was left (confirmed live: with a cap of 25, only 3-6
// ever completed, consistently, across repeated tries — never more). Kept
// deliberately small and safely inside that budget; the rest of a large
// known-store list just fills in gradually over normal browsing instead of
// all at once, same as before.
const MAX_DOMAIN_RESOLUTIONS_PER_SCRAPE = 5;
let domainResolutionInProgress = false;

/**
 * Harvests every store LigaMagic's own `screenfilter.stores` client-side
 * object lists on the current page (populated on card listing pages,
 * `?view=cards/card&card=...&ed=...`, and possibly others — any page with
 * that global gets scraped, so this isn't hardcoded to one `view=`). That
 * object gives id+name for free, no network request needed.
 *
 * Domain isn't in `screenfilter.stores`, but it doesn't need to be: the
 * store info modal (`fetchStoreDetails`, opc=getStoreData) already returns
 * it same-origin, authenticated, instantly — no need to ever visit the
 * store's own (Cloudflare-gated) site just to learn its domain. This used
 * to open a background tab per store and watch a redirect via the
 * `webNavigation` permission; that's gone now, this is simpler and faster.
 */
async function handleScrapeStoresFromPage(tabId) {
  let scrapedStores;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        if (typeof screenfilter === "undefined" || !screenfilter.stores) return null;
        return Object.entries(screenfilter.stores)
          .filter(([, data]) => data?.lj_name)
          .map(([id, data]) => ({ id, name: data.lj_name }));
      },
    });
    scrapedStores = results[0]?.result;
  } catch {
    return; // not a scriptable ligamagic.com.br page right now — nothing to do
  }
  if (!scrapedStores || scrapedStores.length === 0) return;

  const cache = await loadStoreIdCache();
  let changed = false;
  for (const { id, name } of scrapedStores) {
    if (cache[id]) {
      if (cache[id].name !== name) {
        cache[id].name = name;
        changed = true;
      }
    } else {
      cache[id] = { id, name, domain: null, addedAt: Date.now() };
      changed = true;
    }
  }
  if (changed) await saveStoreIdCache(cache);

  // A single page load can fire this multiple times (e.g. several tabs
  // completing around the same moment), and each call would otherwise start
  // its own redundant pass over the same pending entries. Only one domain-
  // resolution batch runs at a time per service worker lifetime.
  if (domainResolutionInProgress) return;
  domainResolutionInProgress = true;
  try {
    const pending = Object.values(cache)
      .filter((e) => !e.domain)
      .slice(0, MAX_DOMAIN_RESOLUTIONS_PER_SCRAPE);
    for (const entry of pending) {
      const { domain } = await fetchStoreDetails(entry.id);
      if (!domain) continue;
      const freshCache = await loadStoreIdCache();
      if (freshCache[entry.id]) {
        freshCache[entry.id].domain = domain;
        await saveStoreIdCache(freshCache);
      }
    }
  } finally {
    domainResolutionInProgress = false;
  }
}

// ── Scryfall Tagger ──────────────────────────────────────────────────────────
/**
 * Scryfall Tagger's GraphQL endpoint (tagger.scryfall.com/graphql -- a
 * separate app from scryfall.com itself, run by the same team) is
 * Rails-CSRF-protected, and that protection checks the request's origin
 * against the token, not just the token's validity by itself. A background
 * service worker's own fetch() always carries the extension's
 * chrome-extension:// origin, which fails that check no matter how the
 * token was obtained -- confirmed by testing directly. Running the fetch
 * from inside an actual tagger.scryfall.com tab (via executeScript, which
 * only the background worker can call) makes it a same-origin request, the
 * same way the page's own JavaScript would make it.
 *
 * The tab is opened in the background (not focused) purely to host that
 * request, and closed as soon as it's done.
 */
async function pollForCardTags(tabId, set, number, timeoutMs = 15_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (set, number) => {
          const token = document.querySelector('meta[name="csrf-token"]')?.content;
          if (!token) return null; // page hasn't rendered yet -- caller retries

          const query = `
            query FetchCardTags($set: String!, $number: String!) {
              card: cardBySet(set: $set, number: $number) {
                taggings {
                  tag {
                    name
                    slug
                    namespace
                    status
                    ancestorTags { name slug namespace status }
                  }
                }
              }
            }
          `;
          const res = await fetch("https://tagger.scryfall.com/graphql", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
            body: JSON.stringify({ query, variables: { set, number } }),
          });
          const json = await res.json();
          const taggings = json?.data?.card?.taggings;
          if (!taggings) {
            return { error: json?.errors?.[0]?.message ?? "Card não encontrado no Scryfall Tagger." };
          }
          return { taggings };
        },
        args: [set, number],
      });
      if (result) return result;
    } catch {
      // Tab mid-navigation or not yet scriptable -- just retry.
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

/**
 * Fetches a card's community tags and keeps only "card" (oracle) tags,
 * dropping "artwork" (illustration) tags entirely.
 *
 * A tag can list "ancestorTags" -- broader tags it implies (e.g. "egg"
 * implies "sacrifice self"). Those inherited tags are included too, as long
 * as they're also in the "card" namespace.
 *
 * Tags carry a moderation "status" ("GOOD_STANDING", "REJECTED", etc.).
 * The Tagger site itself only displays GOOD_STANDING tags, so rejected ones
 * are filtered out here too to match what's actually shown on the card page.
 */
async function handleFetchCardTags(set, number) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: `https://tagger.scryfall.com/card/${set}/${number}`, active: false });
    const result = await pollForCardTags(tab.id, set, number);
    if (!result) return { error: "Scryfall Tagger demorou demais para responder." };
    if (result.error) return { error: result.error };

    const tags = new Map(); // slug -> name, de-duplicated
    result.taggings.forEach(({ tag }) => {
      if (tag.namespace !== "card" || tag.status !== "GOOD_STANDING") return;
      tags.set(tag.slug, tag.name);
      (tag.ancestorTags ?? []).forEach((ancestor) => {
        if (ancestor.namespace === "card" && ancestor.status === "GOOD_STANDING") {
          tags.set(ancestor.slug, ancestor.name);
        }
      });
    });

    return {
      tags: [...tags.entries()]
        .map(([slug, name]) => ({ slug, name }))
        .sort((a, b) => a.slug.localeCompare(b.slug)),
    };
  } catch (err) {
    return { error: err.message };
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ── Pending-prices backfill (Archidekt/Moxfield/Scryfall overlays) ─────────────
// Backfills missing prices via a single LigaMagic deck this extension owns
// per account, in a background tab. Landing on that deck's page is enough —
// scraper-deck.js (already declared as a content script for ligamagic.com.br)
// reads every card's price off it exactly like it does for any real deck, no
// per-card round trip needed. One batch at a time, never in parallel,
// matching the "no request bursts against LigaMagic" caution used everywhere
// else in this file.
//
// Unlike an earlier version of this feature, the deck is never deleted: the
// first ever backfill on an account creates it (via "?view=dks/novo",
// exactly like a normal deck) and stores its id (see
// loadPendingPricesDeck/savePendingPricesDeck); every later backfill edits
// that same deck's card list in place (via "?view=dks/editar&id=…", the same
// URL LigaMagic's own "Editar Deck" link on a deck's page uses — confirmed
// live to be the same `formNewDeck` form, same field names, same submit
// button, same success redirect, and the same "Preenchimento inválido"
// `#lst-error-dk` validation as creation) rather than creating (and
// deleting) a fresh one every run. That sidesteps the whole class of
// fragility a create-then-delete cycle has — a delete that fires but doesn't
// land, a tab closed mid-navigation, etc. — by never deleting at all.
//
// Before trusting a stored deck id, ensureManagedDeck re-verifies it live:
// the id's own "?view=dks/editar" page must still render (deck still exists
// and is owned by this account) AND its form's card-id/name must match what
// was recorded at creation — the same "is this actually still ours" spirit
// the old delete-safety check had, just applied to editing instead of
// deleting. Either check failing falls back to creating a fresh deck and
// overwriting the stored id, so a deck the user deleted by hand (or a
// corrupted/foreign id) never gets treated as ours.
// Always-on trace for the pending-prices backfill (the "Carregar preços
// pendentes" button) — visible in the service worker's own console
// (npm run ext:logs, or cdp-eval --sw), not gated by the showDebugLogs
// setting like the content-script overlays are: this only ever runs when
// the user explicitly clicked that button, and the service worker console
// isn't something a normal user stumbles into, so there's no "keep a real
// user's console quiet" reason to hide it behind a toggle here.
function pendingPricesLog(...args) {
  console.log("[LigaMagic Tracker | Pending Prices]", ...args);
}

const PENDING_PRICE_BATCH_SIZE = 100; // cards per deck edit
const PENDING_PRICE_MIN_CARDS = 7; // LigaMagic's own minimum for a "Livre" deck
const PENDING_PRICE_DECK_FORMAT = "22"; // "Livre (Sem formato definido)"
// Was 60s; the slow real case this originally sized for was a stuck/failed
// attempt (deck deleted, not logged in) silently timing out instead of
// failing fast — both are now caught immediately by isLoggedOutTab/
// ensureManagedDeck's own check rather than by waiting this out, so a much
// shorter ceiling is enough for the genuinely slow-but-working case
// (creation/edit itself is normally under a second even under Chrome's
// background-tab throttling).
const PENDING_PRICE_TAB_TIMEOUT_MS = 10_000;
const PENDING_PRICE_SCRAPE_SETTLE_MS = 2_500; // scraper-deck.js reads straight off the DOM — no per-card wait needed, just a moment to run
// Upper bound on how many times one batch re-submits after dropping cards
// LigaMagic flagged as unrecognized (see scrapeBatchViaManagedDeck). In
// practice one retry is enough — the form flags every unrecognized line in
// the same validation pass, not one at a time — this only guards against
// looping forever if that ever isn't true.
const PENDING_PRICE_MAX_INVALID_ROUNDS = 5;

/**
 * Name for the one managed deck this extension will ever create on an
 * account. Only called the very first time (see ensureManagedDeck) — once
 * the deck exists, its name is left alone forever, so this only needs to
 * avoid a fixed literal at that single moment, not vary run to run. If every
 * account running this extension created that deck under the exact same
 * name, the name alone would be enough to pick every extension user out of
 * LigaMagic's own data. Prefers contextName — the deck/page the missing
 * cards actually came from on that first run (e.g. the Moxfield deck being
 * viewed) — so the deck's name looks like an ordinary one a real player
 * might have typed, and varies by account. Falls back to the first card's
 * own name when there's no such context (Scryfall has no deck to name it
 * after).
 */
function buildTempDeckName(contextName, names) {
  const sanitized = (contextName ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (sanitized) return sanitized;
  return (names[0] ?? "Lista").slice(0, 60);
}

// ── Managed deck storage ─────────────────────────────────────────────────────
// Two flat values (not a list/registry — there is ever only one deck) holding
// the id and name of the single deck this extension manages per account.
// Kept as a pair rather than just the id so ensureManagedDeck can double-check
// "is this actually still our deck" against something more specific than the
// id alone (see the reasoning above the PENDING_PRICE_* constants) — the same
// role the old create-then-delete flow's "does the page still show our
// deck's distinctive name" check served.
const PENDING_PRICES_DECK_ID_KEY = "pendingPricesDeckId";
const PENDING_PRICES_DECK_NAME_KEY = "pendingPricesDeckName";

async function loadPendingPricesDeck() {
  const stored = await chrome.storage.local.get([PENDING_PRICES_DECK_ID_KEY, PENDING_PRICES_DECK_NAME_KEY]);
  const id = stored[PENDING_PRICES_DECK_ID_KEY];
  const name = stored[PENDING_PRICES_DECK_NAME_KEY];
  return id && name ? { id, name } : null;
}

async function savePendingPricesDeck({ id, name }) {
  await chrome.storage.local.set({
    [PENDING_PRICES_DECK_ID_KEY]: id,
    [PENDING_PRICES_DECK_NAME_KEY]: name,
  });
}

async function handleLoadPendingPrices(names, originTabId, contextName) {
  if (!Array.isArray(names) || names.length === 0) {
    pendingPricesLog("Called with no names — nothing to do.");
    return;
  }

  const unique = [...new Set(names)];
  pendingPricesLog(`Starting backfill for ${unique.length} card(s) (contextName="${contextName ?? ""}"):`, unique);
  let done = 0;
  const failedNames = [];

  for (let i = 0; i < unique.length; i += PENDING_PRICE_BATCH_SIZE) {
    const batch = unique.slice(i, i + PENDING_PRICE_BATCH_SIZE);
    pendingPricesLog(`Batch ${i / PENDING_PRICE_BATCH_SIZE + 1}: submitting ${batch.length} card(s) to the managed deck.`);
    try {
      // contextName only matters if this batch ends up creating the deck
      // (no valid stored one yet) — see buildTempDeckName/ensureManagedDeck.
      // Anything the deck form itself never recognized (after its own
      // front-face/back-face substitution retries — see
      // scrapeBatchViaManagedDeck) is reported as failed outright, with no
      // further per-card visit to LigaMagic. This used to open one LigaMagic
      // tab per still-unrecognized name as a last-resort resolution attempt
      // — removed (2026-08-27, explicit user instruction) because `dropped`
      // is not reliably small: a single batch can list dozens of names
      // LigaMagic will never recognize (e.g. a Scryfall grid full of
      // digital-only Alchemy cards, which a paper-only marketplace simply
      // doesn't carry under any face), and opening one LigaMagic page per
      // dropped name turns that into exactly the request burst this project
      // avoids deliberately (see "Nunca gerar rajadas de requisições" in the
      // dev instructions) — never worth it for one extra resolution attempt.
      const { dropped } = await scrapeBatchViaManagedDeck(batch, contextName);
      failedNames.push(...dropped);
      pendingPricesLog(
        dropped.length > 0
          ? `Batch ${i / PENDING_PRICE_BATCH_SIZE + 1}: ${batch.length - dropped.length}/${batch.length} accepted, ${dropped.length} dropped (LigaMagic never recognized): ${dropped.join(", ")}`
          : `Batch ${i / PENDING_PRICE_BATCH_SIZE + 1}: all ${batch.length} card(s) accepted onto the managed deck.`,
      );
    } catch (err) {
      if (err?.loggedOut) {
        // The session is signed out — every remaining batch would fail the
        // exact same way, so this stops here instead of grinding through
        // them first. A distinct signal rather than folding it into
        // failedNames: those cards aren't actually "not found on
        // LigaMagic", the whole attempt never got to ask.
        pendingPricesLog("Aborting: LigaMagic session is signed out.");
        if (originTabId != null) {
          chrome.tabs
            .sendMessage(originTabId, {
              action: "pendingPricesProgress",
              done: unique.length,
              total: unique.length,
              failedNames,
              loggedOut: true,
            })
            .catch((sendErr) => pendingPricesLog("Could not send loggedOut progress message to tab:", sendErr?.message));
        }
        return;
      }
      // Unexpected failure (not the "some cards unrecognized" case, which
      // scrapeBatchViaManagedDeck already handles and reports via `dropped`) —
      // best-effort: the whole batch stays missing rather than silently
      // looking "done" with nothing to show for it.
      pendingPricesLog(`Batch ${i / PENDING_PRICE_BATCH_SIZE + 1}: unexpected error, whole batch counted as failed —`, err);
      failedNames.push(...batch);
    }
    done += batch.length;
    if (originTabId == null) continue;
    // done === total (always true on the last batch) doubles as the
    // completion signal — the caller doesn't need a separate "done" message,
    // one message type is one less thing that can go missing.
    chrome.tabs
      .sendMessage(originTabId, { action: "pendingPricesProgress", done, total: unique.length, failedNames })
      .then(() => pendingPricesLog(`Progress message sent to tab ${originTabId}: ${done}/${unique.length} done, ${failedNames.length} failed so far.`))
      .catch((err) => pendingPricesLog(`Could not send progress message to tab ${originTabId} (tab navigated away or closed?):`, err?.message)); // calling tab may have navigated away or closed — nothing to report to
  }
  pendingPricesLog(`Backfill finished: ${unique.length - failedNames.length}/${unique.length} priced, ${failedNames.length} failed.`);
}

/** "1 Card A\n1 Card B\n…", padded up to the 7-card minimum by bumping the last line's quantity. */
function buildDecklistText(names) {
  const lines = names.map((n) => `1 ${n}`);
  const shortfall = PENDING_PRICE_MIN_CARDS - names.length;
  if (shortfall > 0) {
    const lastIdx = lines.length - 1;
    lines[lastIdx] = `${1 + shortfall} ${names[lastIdx]}`;
  }
  return lines.join("\n");
}

// Present in the header nav on every LigaMagic page for a signed-out
// visitor ("Efetuar login" -> ?view=logar), and confirmed live to be absent
// once authenticated. Both the deck-create and deck-edit forms render
// nothing but an "Ops! Você precisa estar logado..." message when signed
// out — same as a deleted/foreign deck ("form not found"), which is why
// this needs its own check: without it, a signed-out session silently
// retries/times out and reports the batch's cards as "not found on
// LigaMagic", which has nothing to do with the actual problem.
const LOGIN_LINK_SELECTOR = 'a[href*="view=logar"]';

function newLoggedOutError() {
  const err = new Error("LOGGED_OUT");
  err.loggedOut = true;
  return err;
}

async function pageIsLoggedOut(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (selector) => !!document.querySelector(selector),
    args: [LOGIN_LINK_SELECTOR],
  });
  return result === true;
}

/**
 * Opens the extension's stored managed deck in its edit page and verifies
 * live that it's still safe to treat as ours — the deck must still exist
 * (its "?view=dks/editar" form actually renders, which LigaMagic only does
 * for a deck this account owns) AND the form's own hidden deck-id field plus
 * its current name must match what was recorded when the deck was created.
 * Returns `{ tabId, deckId }` (the tab left open, positioned on the loaded
 * edit form) when both checks pass, or `null` when there's no stored deck at
 * all, or the ownership check fails — the caller falls back to creating a
 * fresh deck in that case, exactly like a first-ever run. Throws a
 * `loggedOut`-flagged error instead, without falling back, when the form is
 * missing because the session itself is signed out — falling back to
 * "create a new deck" would just fail the exact same way a second time.
 */
async function ensureManagedDeck() {
  const stored = await loadPendingPricesDeck();
  if (!stored) {
    pendingPricesLog("No managed deck stored yet — will create one.");
    return null;
  }

  let tab;
  try {
    tab = await chrome.tabs.create({
      url: `https://www.ligamagic.com.br/?view=dks/editar&id=${stored.id}`,
      active: false,
    });
    await waitForTabComplete(tab.id, PENDING_PRICE_TAB_TIMEOUT_MS);

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (expectedId, expectedName, loginSelector) => {
        const form = document.getElementById("formNewDeck");
        if (!form) {
          // deck deleted/not owned, or the session is signed out — the
          // caller tells these apart by whether the login link is present.
          return document.querySelector(loginSelector) ? "logged-out" : "not-found";
        }
        const iddeck = form.querySelector('input[name="iddeck"]')?.value;
        return iddeck === expectedId && form.deck_nome?.value === expectedName ? "ok" : "not-found";
      },
      args: [stored.id, stored.name, LOGIN_LINK_SELECTOR],
    });

    if (result === "ok") {
      pendingPricesLog(`Reusing existing managed deck #${stored.id} ("${stored.name}").`);
      return { tabId: tab.id, deckId: stored.id };
    }

    await chrome.tabs.remove(tab.id).catch(() => {});
    if (result === "logged-out") throw newLoggedOutError();
    pendingPricesLog(`Stored managed deck #${stored.id} no longer checks out (deleted, not owned, or renamed) — creating a new one.`);
    return null;
  } catch (err) {
    if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
    if (err?.loggedOut) throw err;
    pendingPricesLog(`Could not verify stored managed deck #${stored.id} — creating a new one instead. Error:`, err);
    return null;
  }
}

/**
 * Gets the current batch's prices onto the single deck this extension
 * manages for the account, creating it first if there isn't one yet (or the
 * stored one no longer checks out — see ensureManagedDeck). Retries with
 * unrecognized cards dropped when LigaMagic's own form rejects some of them
 * (see readInvalidDeckListLines) — identical validation on both the create
 * and the edit form, confirmed live. Returns `{ dropped }` — the names that
 * never made it onto the deck, empty when everything was accepted on the
 * first try.
 *
 * A transform/MDFC/split card's combined "Front // Back" name is frequently
 * the exact thing LigaMagic's own validation rejects — confirmed live across
 * a spread of real decks (e.g. "Azusa's Many Journeys // Likeness of the
 * Seeker", "Clearwater Pathway // Murkwater Pathway"): LigaMagic catalogues
 * these under the front face alone, the same class of mismatch already
 * documented for some cards in cardNameFromLinkRaw (overlay-moxfield.js).
 * Less commonly, neither the combined name nor the front face is right and
 * only the BACK face resolves — confirmed live on a Moxfield row where the
 * visible front-face text turned out to be a printing's cosmetic flavor name
 * (e.g. "Luca Stadium", a Final Fantasy crossover treatment of the plain,
 * single-faced "Strixhaven Stadium") rather than a real double-faced card's
 * front face at all; overlay-moxfield.js can't always tell those apart from
 * its own markup alone (see cardNameFromLinkRaw's own doc comment on why),
 * so this is where the ambiguity actually gets resolved — by asking
 * LigaMagic which reading it recognizes, in order, instead of guessing once.
 *
 * When a round flags a "//" name invalid, this substitutes just the front
 * face and gives it its own retry; if THAT also gets flagged, it substitutes
 * the back face for a third and final try; only then does it give up.
 * `substitutionOf` tracks, for a name currently mid-retry, which combined
 * name it came from and which stage it's at, so: (a) trying the back face
 * only happens once, not looping forever between the two, and (b) a
 * still-failing retry (or a still-open round-budget cutoff) gets reported
 * back under the name the caller actually asked about, not whichever
 * internal substitute was being tried. handleQueryPrices has the matching
 * other half for the common front-face case: a query for the combined name
 * that isn't cached directly also checks the front face alone, since that's
 * what actually ends up in the price cache once that substitution succeeds
 * (a successful back-face substitution needs no such help — handleSendPrices
 * already caches under whatever exact name LigaMagic's own scrape reports,
 * and a lone back-face name has nothing further to reconcile).
 */
async function scrapeBatchViaManagedDeck(names, contextName) {
  let currentNames = [...names];
  const droppedNames = [];
  const substitutionOf = new Map(); // substitute name -> { original, stage: "front" | "back" }

  const managed = await ensureManagedDeck();
  const isNew = managed === null;
  const tabId = managed
    ? managed.tabId
    : (await chrome.tabs.create({ url: "https://www.ligamagic.com.br/?view=dks/novo&tipo=2", active: false })).id;
  // Only matters if isNew — the deck's permanent name is decided once, right
  // here, and never touched again (see buildTempDeckName).
  const deckName = isNew ? buildTempDeckName(contextName, names) : null;

  try {
    if (isNew) {
      await waitForTabComplete(tabId, PENDING_PRICE_TAB_TIMEOUT_MS);
      // ensureManagedDeck already ruled this out for the edit-page path
      // (managed === null can also mean "no deck stored yet", not just
      // "signed out") — this is the create-page path's own check for the
      // same thing, since a signed-out ?view=dks/novo renders no form
      // either and would otherwise just retry/time out for no reason.
      if (await pageIsLoggedOut(tabId)) throw newLoggedOutError();
    }

    for (let round = 0; currentNames.length > 0 && round <= PENDING_PRICE_MAX_INVALID_ROUNDS; round++) {
      pendingPricesLog(`Round ${round}: submitting ${currentNames.length} name(s) to the ${isNew ? "create" : "edit"} form:`, currentNames);
      if (isNew) {
        await fillAndSubmitCreateForm(tabId, currentNames, deckName);
      } else {
        await fillAndSubmitEditForm(tabId, currentNames);
      }
      const outcome = await waitForDeckPageOrInvalidLines(tabId, PENDING_PRICE_TAB_TIMEOUT_MS);

      if (outcome.deckId) {
        pendingPricesLog(`Round ${round}: LigaMagic accepted the whole list — deck #${outcome.deckId}. Waiting ${PENDING_PRICE_SCRAPE_SETTLE_MS}ms for scraper-deck.js to read the prices off the page.`);
        if (isNew) await savePendingPricesDeck({ id: outcome.deckId, name: deckName });

        // scraper-deck.js runs automatically as soon as the deck page's card
        // list is in the DOM — a short settle is enough, no need to poll.
        await new Promise((r) => setTimeout(r, PENDING_PRICE_SCRAPE_SETTLE_MS));
        return { dropped: droppedNames };
      }

      if (outcome.invalidLineIndexes?.length) {
        pendingPricesLog(`Round ${round}: LigaMagic flagged ${outcome.invalidLineIndexes.length}/${currentNames.length} line(s) as unrecognized:`, outcome.invalidLineIndexes.map((i) => currentNames[i]));
        // Same line order as the decklist text this round submitted
        // (buildDecklistText emits exactly one line per name), so the
        // indexes map straight back onto currentNames.
        const retryNames = [];
        outcome.invalidLineIndexes.forEach((i) => {
          const flaggedName = currentNames[i];
          if (!flaggedName) return;
          const existing = substitutionOf.get(flaggedName);
          const original = existing?.original ?? flaggedName;

          if (!existing) {
            // First time this name has been flagged — if it's a combined
            // "Front // Back" name, give the front face its own shot before
            // giving up on it.
            const split = splitFrontBack(flaggedName);
            if (split) {
              pendingPricesLog(`  "${flaggedName}" rejected — retrying with just the front face "${split.front}".`);
              substitutionOf.set(split.front, { original, stage: "front", backFace: split.back });
              retryNames.push(split.front);
              return;
            }
          } else if (existing.stage === "front" && existing.backFace && existing.backFace !== flaggedName) {
            // The front face didn't work either — try the back face alone
            // before giving up (the "Luca Stadium" case above).
            pendingPricesLog(`  "${flaggedName}" (front face of "${original}") also rejected — retrying with the back face "${existing.backFace}".`);
            substitutionOf.set(existing.backFace, { original, stage: "back" });
            retryNames.push(existing.backFace);
            return;
          }

          // Either there was never a "//" to fall back on, or every face
          // this card has has already been tried — genuinely unrecognized.
          // Report it under the name the caller actually asked about.
          pendingPricesLog(`  "${flaggedName}" — giving up, reporting "${original}" as not found on LigaMagic.`);
          droppedNames.push(original);
        });
        currentNames = currentNames
          .filter((_, i) => !outcome.invalidLineIndexes.includes(i))
          .concat(retryNames);
        continue; // retry with the trimmed/substituted list — same tab, same deck
      }

      // Neither a landed deck page nor a readable "unrecognized cards"
      // signal within the timeout — an unexplained failure, not the
      // invalid-card case this function otherwise handles. Give up on
      // whatever's left rather than retrying blindly.
      pendingPricesLog(`Round ${round}: timed out after ${PENDING_PRICE_TAB_TIMEOUT_MS}ms with neither a deck page nor a readable "unrecognized cards" modal — giving up on the remaining ${currentNames.length} name(s). Current tab URL may help diagnose this — check tab ${tabId} live.`);
      break;
    }

    // Either every remaining card ended up flagged invalid, or the loop gave
    // up after an unexplained failure, or the round budget ran out on a
    // substitution retry still in flight — either way nothing left in
    // currentNames ever made it onto the deck this round. Reported under the
    // original combined name for anything that was a face substitute.
    droppedNames.push(...currentNames.map((n) => substitutionOf.get(n)?.original ?? n));
    pendingPricesLog(`scrapeBatchViaManagedDeck finished: ${droppedNames.length} dropped out of ${names.length} requested.`, droppedNames);
    return { dropped: droppedNames };
  } finally {
    chrome.tabs.remove(tabId).catch(() => {});
  }
}

/** Fills and submits the "?view=dks/novo" form to create the managed deck for the first time. */
async function fillAndSubmitCreateForm(tabId, names, deckName) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (decklist, formatValue, name) => {
      // Close any "Preenchimento inválido" modal left over from a previous
      // round so it doesn't stack on top of the next one. The modal's close
      // button only hides it, though -- #lst-error-dk (the actual line
      // markers readInvalidDeckListLines reads) stays in the DOM, so it's
      // removed here too: without this, a poll landing between this submit
      // and the new round's own response arriving would read last round's
      // markers against this round's (differently sized/ordered) decklist,
      // misattributing "invalid" to the wrong lines entirely.
      document.querySelector(".close-modal")?.click();
      document.getElementById("lst-error-dk")?.remove();

      const form = document.getElementById("formNewDeck");
      if (!form) return;
      form.deck_formato.value = formatValue;
      form.deck_nome.value = name;
      form.txt_deck.value = decklist;
      const priv = [...form.querySelectorAll('input[name="deck_privacidade"]')].find((r) => r.value === "1");
      if (priv) priv.checked = true;
      // The real submit button, not form.requestSubmit() — this form's own
      // submit handling only runs off the button's click event.
      form.querySelector('[name="btCadDeck"]')?.click();
    },
    args: [buildDecklistText(names), PENDING_PRICE_DECK_FORMAT, deckName],
  });
}

/**
 * Fills and submits the "?view=dks/editar" form for the single deck this
 * extension manages, replacing its entire card list with the current batch.
 * Every other field (name, format, privacy) is left exactly as the page
 * loaded it with — only the card list is meant to change between runs, the
 * deck's name in particular is set once at creation and never touched again
 * (see buildTempDeckName).
 */
async function fillAndSubmitEditForm(tabId, names) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (decklist) => {
      // See fillAndSubmitCreateForm's identical comment above -- same stale-
      // marker race applies to the edit form.
      document.querySelector(".close-modal")?.click();
      document.getElementById("lst-error-dk")?.remove();

      const form = document.getElementById("formNewDeck");
      if (!form) return;
      form.txt_deck.value = decklist;
      form.querySelector('[name="btCadDeck"]')?.click();
    },
    args: [buildDecklistText(names)],
  });
}

async function waitForTabComplete(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === "complete") return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/**
 * Polls the submitted "?view=dks/novo" (create) or "?view=dks/editar"
 * (edit) tab for one of two outcomes — confirmed live to behave identically
 * either way:
 *   - success: the URL becomes "?view=dks/deck&id=…" — returns { deckId }.
 *   - rejection: the form's own "Preenchimento inválido" validation flagged
 *     one or more lines — returns { invalidLineIndexes }, read via
 *     readInvalidDeckListLines.
 * Returns `{}` if neither happens before the timeout (a genuine, unexplained
 * hang — the caller treats that as a failure it won't retry).
 */
async function waitForDeckPageOrInvalidLines(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === "complete") {
      const match = tab.url?.match(/[?&]view=dks\/deck&id=(\d+)/);
      if (match) return { deckId: match[1] };

      const invalidLineIndexes = await readInvalidDeckListLines(tabId);
      if (invalidLineIndexes) return { invalidLineIndexes };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return {};
}

/**
 * Reads which lines of the deck form's card-list textarea LigaMagic's own
 * client-side validation flagged as unrecognized when the "Preenchimento
 * inválido" modal appears — the same validation on both the create and the
 * edit form. The signal lives in `#lst-error-dk`: one `<img>` per decklist
 * line, in the same order as the submitted text, using `redarrow.png` for a
 * flagged line and `spacer.gif` for an accepted one — confirmed live on both
 * forms by inspecting the DOM after a submit that included both recognized
 * and unrecognized card names. Returns 0-based line indexes (mapping 1:1
 * onto the names array a round submitted, since buildDecklistText emits
 * exactly one line per name), or null when the marker isn't present yet or
 * nothing was flagged. Relies on fillAndSubmitCreateForm/fillAndSubmitEditForm
 * removing `#lst-error-dk` before every resubmit -- without that, a poll
 * landing before a later round's own response arrives would read a stale
 * marker set left over from an earlier round instead of null, misattributing
 * "invalid" against that round's differently sized/ordered decklist.
 */
async function readInvalidDeckListLines(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const errDiv = document.getElementById("lst-error-dk");
        if (!errDiv) return null;
        const indexes = [...errDiv.querySelectorAll("img")]
          .map((img, i) => (img.src.includes("redarrow") ? i : -1))
          .filter((i) => i !== -1);
        return indexes.length > 0 ? indexes : null;
      },
    });
    return result ?? null;
  } catch {
    return null; // tab mid-navigation or not yet scriptable — caller keeps polling
  }
}

// ── Storage ────────────────────────────────────────────────────────────────────────
// Settings
const DEFAULT_SETTINGS = {
  overlayArchidekt: true,
  overlayMoxfield: true,
  overlayScryfall: true,
  openLigaMagicOnClick: true, // whether the BRL price in overlays (Archidekt/Moxfield/Scryfall) links to the card's LigaMagic page
  addScryfallTagsButton: true, // whether the "Carregar Tags" button is added to a card's prints box on Scryfall
  addScryfallFilterButton: true, // whether the default-filter button is added next to Scryfall's search field
  scryfallDefaultFilter: "sort:edhrec", // filter terms that button appends to the search
  disclaimerAcknowledged: false, // whether the user has dismissed the first-open hobby/non-affiliation disclaimer in the popup
  // Gates both createLogger's trace output and logNotShown's "why didn't
  // this render" warnings (see overlay-utils.js) in every injected overlay.
  // Off by default so a real user's console stays quiet; surfaced only via
  // a hidden checkbox in the popup footer (click the version number).
  showDebugLogs: false,
  defaultDeckView: "price", // deck page tab to auto-select on load; "" keeps LigaMagic's own default
  addPriceView: true, // whether the "Preço" deck visualization tab is injected at all
  addDeckGridPrices: true, // whether the deck page's native "Grid" view gets a Mín/Méd/Máx price block under each card
  addMeusDecksTab: true, // whether the "Meus Decks" tab is injected into the main menu
  addMeusPedidosTab: true, // whether the "Meus Pedidos" tab is injected next to it
  removeLeiloesTab: true, // whether the "Leilões" tab is removed from the main menu
  removeForumTab: true, // whether the "Fórum" tab is removed from the main menu
  replaceGerarImagemWithCopiarDeck: true, // whether "Copiar Deck" is added to deck pages
  removeGerarImagemButton: true, // whether the native "Gerar Imagem" button is removed — independent of the above, so both can be shown at once
  enableCustomStoreSearch: true, // whether the "Lojas Customizadas" section is injected into Compra por Lista
  addLoadDefaultsButton: true, // whether the "Carregar filtro padrão" button is injected into Compra por Lista
  rememberListaFilters: false, // reapply the last manual filter selection on load, instead of the configured defaults
  addCopyListaButton: true, // whether the "Copiar Lista de Compras" button is injected into Compra por Lista results
  addAnaliseEconomia: true, // whether the "Análise de Economia" button is injected into Compra por Lista results
  // Cached result of the last economy analysis, keyed by a cheap fingerprint
  // of the search result it was computed from (see hashResultado in
  // analise-economia.js), so reopening the modal on an unchanged result
  // doesn't rerun the solver. { hash, relatorio } | null
  analiseEconomiaCache: null,
  addCarrinhoCopyButton: true, // whether the "Copiar Lista" button is injected into the cart's shopping list
  addCardHoverLinks: true, // whether Scryfall/EDHREC buttons are added to the card-hover image tooltip
  addCardSearchContextMenu: true, // whether the "Pesquisar carta" right-click submenu is registered, browser-wide
  addEditionSearchButton: true, // whether the magnifying-glass badge is added next to edition icons on a card page
  // How "Copiar Lista de Compras" formats each card line, remembered across
  // uses so the panel reopens the way it was last left. `detalhado` swaps in
  // LigaMagic's own format and makes the other four inert (see
  // detailed-format.js).
  copyListaOptions: {
    detalhado: false,
    versao: false,
    qualidade: false,
    idioma: false,
    preco: false,
  },
  // Custom stores the user has added on the "Compra por Lista" page, on top of
  // (not replacing) whatever Todas Lojas/Minhas Favoritas is currently
  // selected. Persisted across reloads so the working set isn't lost.
  customStoreSelection: [], // { id, name, domain, checked }[]
  // Ships applying a sensible filter set out of the box: cards in Portuguese
  // and/or English, extras allowed, HP or better, and nothing that can't be
  // bought right now.
  listaCards: {
    idiomaMode: "escolher", // "" | "todos" | "escolher"
    idiomas: ["2", "8", "11"], // txt_idioma[] values (Inglês, Português, Português/Inglês), only used when idiomaMode === "escolher"
    extrasMode: "pode", // "" | "pode" | "sem" | "definir"
    extras: [], // txt_extras[] values, only used when extrasMode === "definir"
    qualidade: "5", // txt_qualidade value — (HP) Muito Usada ou superior; "" (don't touch)
    ignorarSemEstoque: true,
    ignorarPreOrder: true,
    // Snapshot captured live from the page when mode === "remember"; same
    // shape as the fields above (ignorarSemEstoque/ignorarPreOrder use null
    // for "no capture yet" instead of a default boolean).
    lastUsed: {
      idiomaMode: "",
      idiomas: [],
      extrasMode: "",
      extras: [],
      qualidade: "",
      ignorarSemEstoque: null,
      ignorarPreOrder: null,
    },
  },
};

async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}

// Saving is read-modify-write, so two writes in flight at once can lose an
// update: the second reads the settings before the first has stored them and
// then writes its own copy back over the top. That's easy to trigger from the
// popup, where one panel mixes plain checkboxes with the nested filter config
// — toggling two of them in quick succession is enough. Chaining the writes
// means each one reads what the previous just stored.
let settingsWrites = Promise.resolve();

// Every host this extension injects into — mirrors manifest.json's own
// host_permissions, used below to scope which open tabs are worth pushing a
// live settings change to.
const INJECTED_HOST_PATTERNS = [
  "*://*.ligamagic.com.br/*",
  "*://*.archidekt.com/*",
  "*://*.moxfield.com/*",
  "*://*.scryfall.com/*",
];

function saveSettings(partial) {
  settingsWrites = settingsWrites.then(async () => {
    const current = await loadSettings();
    const updated = { ...current, ...partial };
    await chrome.storage.local.set({ settings: updated });

    // Most settings are fine to only take effect on a tab's next reload,
    // same as it always has — but a couple are only useful if they reach
    // tabs already open: a debug-logging toggle (you're trying to catch
    // something live, not on the next reload) and the Scryfall default
    // filter (set from the gear panel on Scryfall's own page, see
    // overlay-scryfall-filter.js — the "Filtro padrão" button there needs to
    // pick up a popup-side edit without a reload, same as it already does
    // for an edit made locally through that same gear panel).
    // chrome.storage.onChanged isn't a working option for this: confirmed
    // empirically that a change written here never reaches a content
    // script's onChanged listener, even though the exact same listener
    // registered in this service worker's own context fires normally — so
    // this pushes the change directly to every open tab's content script
    // instead, the same way handleLoadPendingPrices already pushes its own
    // progress updates.
    //
    // showDebugLogs is always included whenever either value changes, not
    // just when it's the one that changed — overlay-utils.js's own listener
    // sets logsEnabled unconditionally off `msg.showDebugLogs` on every
    // "settingsChanged" message, so a message that omitted it (e.g. one
    // sent purely for a scryfallDefaultFilter change) would read as
    // `undefined === true` and silently turn logging off. Reading `updated`
    // (not `partial`) means this is always the account's real current
    // value, whether or not this particular save is what changed it.
    if ("showDebugLogs" in partial || "scryfallDefaultFilter" in partial) {
      const tabs = await chrome.tabs.query({ url: INJECTED_HOST_PATTERNS });
      const message = { action: "settingsChanged", showDebugLogs: updated.showDebugLogs };
      if ("scryfallDefaultFilter" in partial) message.scryfallDefaultFilter = updated.scryfallDefaultFilter;
      tabs.forEach((tab) => {
        if (tab.id == null) return;
        // Rejects harmlessly for a tab with no listener yet (mid-navigation,
        // content script not injected there for some other reason, etc.).
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      });
    }

    // Not a content-script setting -- chrome.contextMenus lives in this
    // service worker, so re-registering directly here is what makes the
    // checkbox take effect live instead of needing an extension reload.
    if ("addCardSearchContextMenu" in partial) {
      registerSearchCardContextMenu();
    }
  });
  return settingsWrites;
}

// A handful of real card names use a Latin ligature LigaMagic's own catalogue
// keeps as a single character (its href-encoded card name — see
// cardNameFromHref in content-utils.js — decodes to the literal "Æ"/"Œ"
// glyph), while Scryfall/Archidekt/Moxfield spell the same name out as two
// plain ASCII letters (confirmed live: LigaMagic's own deck-page href for
// "Aetherize" decodes to "Ætherize", U+00C6 — a query for the Scryfall
// spelling landed on a real, already-cached price under the wrong key and
// read as "not found"). Expanded before case-folding so either spelling
// collapses onto the same key.
const LIGATURE_EXPANSIONS = { æ: "ae", œ: "oe" };

function expandLigatures(name) {
  return name.replace(/[æœ]/gi, (ch) => {
    const expanded = LIGATURE_EXPANSIONS[ch.toLowerCase()];
    return ch === ch.toUpperCase() ? expanded.toUpperCase() : expanded;
  });
}

// Price cache — keyed by a case-insensitive normalization of the card name
// (see priceCacheKey), not the raw string. LigaMagic's own href-encoded card
// names (read by cardNameFromHref in content-utils.js, off whatever page
// happened to scrape the price) aren't always consistently cased against
// each other for the exact same card (confirmed live: the same deck page
// encoded "Bloodforged Battle-axe" and "Curious obsession" with a lowercase
// letter where the card's real name capitalizes it) — a plain exact-string
// cache key silently never matches the correctly-cased name every overlay
// (Archidekt/Moxfield/Scryfall) actually queries by, so a card can have a
// real cached price and still be reported as "not found". `name` inside each
// entry keeps the exact casing it was scraped with, for reference; nothing
// reads the cache by iterating its keys as display text (the popup's own
// "sent today" list is a separate, exact-cased structure — see
// stats.todayCards in handleSendPrices).
function priceCacheKey(name) {
  return expandLigatures(name.trim()).toLowerCase();
}

// Every entry ever scraped is kept indefinitely — priceColor() in
// overlay-utils.js is what ages a price into yellow/red as it gets older
// (< 7 days green, 7-30 yellow, > 30 red), so the cache itself has to
// actually hold prices from previous days for that to ever show anything
// but green. An earlier version of this function discarded everything not
// from today on every load — since handleSendPrices reads via this
// function and immediately writes the result back, that silently erased
// every older price the very next time any new card was scraped, which is
// why yellow/red were never seen in practice. Entries are small (well
// under a KB each) and there's no realistic number of unique card names
// that would threaten chrome.storage.local's quota, so there's no need to
// cap this by age or count.
async function loadPriceCache() {
  const { fetchedPrices } = await chrome.storage.local.get("fetchedPrices");
  return { prices: fetchedPrices?.prices ?? {} };
}

async function savePriceCache(cache) {
  await chrome.storage.local.set({ fetchedPrices: cache });
}

function getTodayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function loadStats() {
  const today = getTodayStr();
  const data = await chrome.storage.local.get("sentToday");
  let stats = data.sentToday ?? {
    todayDate: today,
    todayCards: {},
    totalUpdates: 0,
  };

  if (stats.todayDate !== today) {
    stats = {
      todayDate: today,
      todayCards: {},
      totalUpdates: stats.totalUpdates,
    };
    await chrome.storage.local.set({ sentToday: stats });
  }

  return stats;
}

async function saveStats(stats) {
  await chrome.storage.local.set({ sentToday: stats });
}
