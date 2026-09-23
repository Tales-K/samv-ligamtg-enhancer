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
 *   { action: "resolveStoreId", id: string }
 *     → looks up a store the user typed the numeric LigaMagic ID of directly
 *       (see handleResolveStoreId) — cache hit first, otherwise one
 *       same-origin opc=getStoreData request (no permission prompt, no tab,
 *       unlike resolveStoreUrl: the ID is already LigaMagic's own, there's no
 *       external site to visit)
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
 *   { action: "scrapeStoresFromLista", stores: { id: string, name: string }[] }
 *     → merges stores harvested from a "Compra por Lista" result (see
 *       lista-store-scraper.js) into the same known-store cache
 *       handleScrapeStoresFromPage feeds elsewhere (see
 *       mergeScrapedStoresIntoCache) — this page never carries the
 *       screenfilter.stores global that scraper reads, so it needs its own
 *       harvest off window.CardsOrcamento.item.resultado instead
 *     → resolves with { ok: boolean }
 *
 *   { action: "getListaFiltros" }
 *     → reads the page's own current idioma/extras/qualidade/estoque/
 *       pré-venda selections off wizard.json.caracteristicas, and whether
 *       the user's own list pinned exact per-card editions (see
 *       handleGetListaFiltros) — used by Super Pesquisa to auto-replicate
 *       the user's exact filters (and whether to pin exact versions) in the
 *       second tab it opens, with no question asked
 *     → resolves with { caracteristicas, usouVersoesExatas }
 *
 *   { action: "startSuperPesquisa", payload: { targetLines: string[], filtros, baselineComReorg } }
 *     → fire-and-forget, same reasoning as loadPendingPrices below: opens a
 *       second, BACKGROUNDED (active: false — this tab is never meant to be
 *       looked at directly, see "superPesquisaFocusTab" below for the one
 *       path that changes that) Compra por Lista tab and drives it through
 *       TWO searches — a wide discovery search (the user's real cards at
 *       their true per-line ceiling plus public-deck padding, budgeted to
 *       SUPER_PESQUISA_DISCOVERY_TARGET_TOTAL_QTY total quantity units,
 *       unrestricted by store) whose result doubles as a (card × store)
 *       price/stock map, then a second, clean search of just the user's real
 *       cards at their real quantities, scoped to the stores a plan built
 *       from that map picks rather than to every store the first search
 *       surfaced (see planejarLojasDaCompra) — then asks that same second
 *       tab to apply every viable "economia por reorganização" for real on
 *       that clean result and report the resulting total back (see
 *       "superPesquisaApplyReorgAndReport"/"superPesquisaReorgApplied"
 *       below) — can take a genuine while, no response channel is kept open
 *       for it
 *     → result travels back to the ORIGIN tab as its own
 *       { action: "superPesquisaResult", ok, secondTabId?, totalComReorgDepois?,
 *       economia?, lojas?: {id,nome}[], error? } message once the whole
 *       thing finishes (including the second tab's own reorganização pass);
 *       the origin tab's own content script (super-pesquisa.js) is what
 *       turns this into the "Sim / Não / Sim numa nova aba" decision prompt
 *
 *   { action: "superPesquisaApplyReorgAndReport", context: "discovery" | "applyToOrigin" }
 *     → background → whichever tab just landed a real-quantity, store-scoped
 *       search (the second tab after phase 2, OR the origin tab after the
 *       user clicks "Sim" — see "superPesquisaApplyToOrigin" below): asks it
 *       to apply every viable reorganização for real and report the
 *       resulting money total back — this file never builds any UI of its
 *       own off this, that's entirely the content script's job
 *     → fire-and-forget, no response expected here either — see
 *       "superPesquisaReorgApplied" below for how it reports back
 *
 *   { action: "superPesquisaReorgApplied", context, totalComReorgDepois }
 *     → a tab's own content script → background, once it's done applying
 *       reorganizações for real. This re-reads that same tab's now-final
 *       resultado itself (handleGetListaResultado) to harvest the real
 *       store list a purchase there would use (post-reorg closures
 *       included, via harvestStores) — the content script only ever reports
 *       the money total, never the store list, since this file already has
 *       a page-reading primitive for that and re-deriving it independently
 *       would just be the same read done twice. context "discovery" relays
 *       a decision prompt to the run's origin tab as "superPesquisaResult"
 *       above (looked up via superPesquisaContextByTabId, keyed by the
 *       second tab's own id); context "applyToOrigin" instead confirms the
 *       change back to that same tab as "superPesquisaAppliedHere" below,
 *       since by then the user is already looking at it
 *     → fire-and-forget
 *
 *   { action: "superPesquisaApplyToOrigin", secondTabId }
 *     → the ORIGIN tab's own content script → background, sent when the user
 *       clicks "Sim" on the decision prompt: replays the exact scoped search
 *       a Super Pesquisa run already found savings in (cached targetLines/
 *       filtros/storeIds from superPesquisaContextByTabId, keyed by
 *       secondTabId) directly on the origin tab, then asks it to apply
 *       reorganização too (see "superPesquisaApplyReorgAndReport" above) —
 *       this never redoes the discovery pass, just the one real search
 *     → fire-and-forget; reports back to the SAME (origin) tab as
 *       { action: "superPesquisaAppliedHere", ok, totalComReorgDepois?,
 *       lojas?, error? }
 *
 *   { action: "superPesquisaFocusTab", secondTabId }
 *     → the ORIGIN tab's own content script → background, sent when the user
 *       clicks "Sim numa nova aba" on the decision prompt: brings that
 *       already-finished second tab to the front (chrome.tabs.update
 *       active: true) instead of redoing its search a third time — it
 *       already holds the exact scoped, reorganização-applied result
 *     → fire-and-forget, no response
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
// A long-lived port the content script opens for the duration of a Super
// Pesquisa run (see super-pesquisa.js). Its only purpose is staying
// connected: MV3 tears down an idle service worker (and everything running
// inside it, including any in-flight async chain) after a short window with
// no activity it tracks as "in use", and a run of several
// chrome.tabs.update/executeScript calls interleaved with plain
// setTimeout-based waits doesn't reliably count -- a connected
// runtime.connect() port does. Confirmed live (2026-09-13): without this,
// Super Pesquisa's background orchestration silently stalled forever
// partway through its first tab navigation, with no error anywhere,
// because the service worker was torn down mid-task.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "superPesquisaKeepAlive") return;
  port.onMessage.addListener(() => {});
});

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
  if (request.action === "loadPedidoItens") {
    handleLoadPedidoItens(sender.tab?.id, request.cod).then(sendResponse);
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
  if (request.action === "resolveStoreId") {
    handleResolveStoreId(request.id).then(sendResponse);
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
  if (request.action === "scrapeStoresFromLista") {
    handleScrapeStoresFromLista(request.stores).then(sendResponse);
    return true;
  }
  if (request.action === "getListaFiltros") {
    handleGetListaFiltros(sender.tab?.id).then(sendResponse);
    return true;
  }
  if (request.action === "startSuperPesquisa") {
    // Fire-and-forget, same reasoning as loadPendingPrices just below: this
    // opens and drives a whole second tab through two searches, which can
    // take a genuine while — the result travels back to the calling tab as
    // its own chrome.tabs.sendMessage instead (see handleStartSuperPesquisa).
    handleStartSuperPesquisa(request.payload, sender.tab?.id);
    return false;
  }
  if (request.action === "superPesquisaReorgApplied") {
    handleSuperPesquisaReorgApplied(request, sender.tab?.id);
    return false;
  }
  if (request.action === "superPesquisaApplyToOrigin") {
    handleSuperPesquisaApplyToOrigin(request.secondTabId, sender.tab?.id);
    return false;
  }
  if (request.action === "superPesquisaFocusTab") {
    handleSuperPesquisaFocusTab(request.secondTabId);
    return false;
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
/**
 * Runs the purchases page's own item loader for one store of an order.
 *
 * The POST it makes carries a token only the page can mint (its own
 * sale.getTokenUrl()), so this drives the site's function in the page world
 * instead of rebuilding the request here. sale.getItens only writes the
 * result into "#venda_<cod>" and never touches that block's visibility, so
 * the order stays collapsed or expanded exactly as the user left it.
 *
 * Called once per store, awaited by the caller between stores -- never as a
 * parallel fan-out.
 */
async function handleLoadPedidoItens(tabId, cod) {
  if (tabId == null) return { error: "sem aba de origem" };
  if (!/^\d+$/.test(String(cod))) return { error: `código de pedido inválido: ${cod}` };
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (codigo) => {
        if (typeof sale !== "undefined" && typeof sale.getItens === "function") {
          sale.getItens(codigo);
        }
      },
      args: [Number(cod)],
    });
    return { ok: true };
  } catch (erro) {
    return { error: String(erro) };
  }
}

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
 *
 * Returns null for an ID with no matching store — the endpoint answers that
 * with 200 and an "Loja não identificada" HTML fragment rather than an HTTP
 * error, so the absence of a `store-name` block is the only signal.
 */
async function fetchStoreDetailsIfExists(storeId) {
  const res = await fetch(
    `https://www.ligamagic.com.br/ajax/mp/actions.php?opc=getStoreData&id=${storeId}&origin=desktop&tcg=1`,
    { credentials: "include", headers: { "x-requested-with": "XMLHttpRequest" } },
  );
  const data = await res.json();
  const nameMatch = data.html?.match(/store-name b'>\s*([^<\n]+)/);
  if (!nameMatch) return null;

  const urlMatch = data.html?.match(/store-url'>\s*<a href='([^']+)'/);
  let domain = null;
  if (urlMatch) {
    try {
      domain = stripWww(new URL(urlMatch[1]).hostname);
    } catch {
      // malformed store-url value — leave domain null
    }
  }
  return { name: nameMatch[1].trim(), domain };
}

/**
 * Wraps fetchStoreDetailsIfExists for callers that already know the ID
 * belongs to a real store (found via screenfilter scraping or a successful
 * URL resolve) and just want its domain filled in — a generic placeholder
 * name on any hiccup (network error, unexpected markup) beats losing a whole
 * batch resolution pass over one entry.
 */
async function fetchStoreDetails(storeId) {
  try {
    return (await fetchStoreDetailsIfExists(storeId)) ?? { name: `Loja ${storeId}`, domain: null };
  } catch {
    return { name: `Loja ${storeId}`, domain: null };
  }
}

/**
 * Looks up a store by the numeric LigaMagic ID the user typed directly into
 * the custom-store search field, instead of a name (picked from the known-
 * stores dropdown) or a URL (resolved via resolveStoreUrl). Cache hit first;
 * otherwise a single getStoreData request — same-origin and already covered
 * by this extension's own host_permissions, so unlike resolveStoreUrl this
 * never needs a permission prompt or a visible tab.
 */
async function handleResolveStoreId(rawId) {
  const id = String(rawId ?? "").trim();
  if (!/^\d+$/.test(id)) return { error: "ID inválido." };

  const cache = await loadStoreIdCache();
  if (cache[id]) return { ...cache[id], fromCache: true };

  let details;
  try {
    details = await fetchStoreDetailsIfExists(id);
  } catch (err) {
    return { error: `Falha ao consultar a loja: ${err.message}` };
  }
  if (!details) return { error: "Loja não encontrada para esse ID." };

  const entry = { id, name: details.name, domain: details.domain, addedAt: Date.now() };
  cache[id] = entry;
  await saveStoreIdCache(cache);
  return { ...entry, fromCache: false };
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
          // quantidadeLimite caps how many stores a single split purchase can
          // span in the RESULT -- it has nothing to do with how many stores
          // are in `favoritas` above. It's the same "Até N lojas" <select>
          // (id="txt_max_lojas") the native UI shows, whose only valid values
          // are 1-20 or "0" for "sem limite" -- confirmed live (2026-09-14)
          // that sending storeIds.length here (e.g. "22") makes the backend
          // reject the whole request as invalid data. "0" keeps every one of
          // the scoped stores eligible, same as leaving the native select on
          // its default.
          quantidadeLimite: "0",
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
  await mergeScrapedStoresIntoCache(scrapedStores);
}

/**
 * Merges freshly-harvested { id, name } pairs into the persistent store
 * cache -- adding new entries, refreshing a name that changed -- then runs
 * the same capped, throttled domain-resolution follow-up regardless of
 * which scraper found them (handleScrapeStoresFromPage's screenfilter.stores
 * harvest, or handleScrapeStoresFromLista's own harvest off "Compra por
 * Lista" results): both hand over nothing but id+name, since domain never
 * comes for free from either source.
 */
async function mergeScrapedStoresIntoCache(scrapedStores) {
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

/**
 * Harvests every store's { id, name } straight from the "Compra por Lista"
 * results a content script already read off window.CardsOrcamento.item.
 * resultado (see lista-store-scraper.js) -- that page never carries the
 * screenfilter.stores global handleScrapeStoresFromPage reads elsewhere, so
 * without this those results never enrich the known-store cache at all.
 */
async function handleScrapeStoresFromLista(stores) {
  if (!Array.isArray(stores)) return { ok: false };
  await mergeScrapedStoresIntoCache(stores);
  return { ok: true };
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

// ── Super Pesquisa ───────────────────────────────────────────────────────────
/**
 * "Super Pesquisa" opens a second, focused Compra por Lista tab and searches
 * the user's current card list padded with cards pulled from a few recent
 * public decks (a mix of formats), with no cap on how many stores the plan
 * can use. The padding is never bought — it exists only to make LigaMagic's
 * own store-selection algorithm consider a much wider slice of the
 * marketplace than a small list alone ever surfaces. Confirmed live
 * (2026-09-13): the exact same 5 cards, searched alone with no store-count
 * cap, settled on 2 stores; padded with ~45 unrelated staples under the same
 * settings, those same 5 cards spread across 4 different stores, including
 * one that never appeared at all in the small search.
 *
 * Once that wider store set is known, a second, CLEAN search runs — just the
 * user's real cards, no padding — scoped to exactly those discovered stores
 * via the same custom-store-search mechanism the "Buscar Lojas" bar already
 * uses (handleInstallSearchOverride/handleSyncCustomStoreIds). That keeps the
 * final numbers (price, frete) real and un-inflated by padding, and lets
 * LigaMagic's own optimizer — not a hand-rolled one — work out the actual
 * best split within that pool: it already handles stock limits, quantity
 * splitting across stores, and per-store minimums correctly, none of which
 * this feature tries to reimplement.
 *
 * Opening/driving a second tab isn't something a content script can do on
 * its own (chrome.tabs is background-only) — super-pesquisa.js just captures
 * the calling tab's current card list, baseline cost and filters, and hands
 * them here.
 */

// LigaMagic's own hard limit on a single Compra por Lista search — confirmed
// live 2026-09-13: a 111-line list is rejected outright ("A pesquisa é
// limitada em 110 cards."), a 110-line one searches normally, all 110 lines
// matched. Not documented anywhere on the site itself.
//
// This counts DISTINCT LINES in the submitted list (one per card name,
// regardless of its own quantity), not total copies bought or lines in a
// finished purchase. Confirmed live (2026-09-14): a 99-line Super Pesquisa
// search whose quantities summed to 209 copies, then split by LigaMagic's
// own optimizer across 28 different stores into 157 separate purchase
// lines, went through with no rejection -- both of those far larger numbers
// come from stock-splitting and per-line quantity after the search already
// succeeded, not from the search request itself, which only ever saw 99
// lines. The original 2026-09-13 test happened to use one copy per line, so
// line count and total quantity were the same number there and couldn't
// tell the two apart; this run resolves that ambiguity.
const SUPER_PESQUISA_MAX_CARDS = 110;

// LigaMagic's own per-line quantity ceiling for a single card in one search
// -- confirmed live: the site rejects a single line asking for more than
// this (8 for a nonbasic card, 40 for a basic land). The discovery phase
// below pushes the user's own real cards straight to this ceiling on
// purpose (see SUPER_PESQUISA_DISCOVERY_TARGET_TOTAL_QTY) instead of a
// scaled-down "stress" fraction of it.
const SUPER_PESQUISA_MAX_QTY_NORMAL = 8;
const SUPER_PESQUISA_MAX_QTY_BASIC = 40;

// Total quantity the discovery-phase search aims for, summed across every
// line -- not the number of lines. Being conservative here matters:
// confirmed live (2026-09-14) that pushing the total too high makes
// LigaMagic's own search API return an outright error
// ({"status":"error","message":"Erro interno ao processar a lista."} at
// ~1040 total units, all 110 lines maxed to 8/40) or just never come back
// within this extension's own timeout (~650 total units, at 105 lines of
// qty 5 plus 5 basic-land lines of qty 25). 400 is a deliberately lower
// target than either failure point. Rather than scaling every line's
// quantity by a fixed multiplier and hoping the total lands somewhere safe,
// the discovery line list is built to add up to close to this number on
// purpose: the user's own cards first, raised toward their per-line ceiling
// only as far as this budget allows (see superPesquisaLinhasDeDescoberta --
// a 100-card list would ask for ~800 units if every line went straight to
// its ceiling), then however many public-deck padding lines fit in whatever
// budget is left.
const SUPER_PESQUISA_DISCOVERY_TARGET_TOTAL_QTY = 400;

// Checked against the user's OWN target lines, to decide whether one of
// them should use the basic-land ceiling instead of the regular one. No
// longer used to inject extra synthetic basic-land lines into discovery
// (removed 2026-09-15): a store that simply doesn't stock basics could
// still be the best match for the cards the user actually wants, and
// injecting basics into every discovery search gave such a store no way to
// show up unless it also happened to sell basics.
const SUPER_PESQUISA_BASIC_LANDS = ["Plains", "Island", "Swamp", "Mountain", "Forest"];

// Recent decks of a mix of formats, so the padding isn't all one archetype's
// staples — format ids match the site's own "Decks" nav menu links
// (?filtro_formato=1 is Standard, =9 is Commander, etc.).
const SUPER_PESQUISA_PADDING_FORMATS = [
  { id: 9, label: "Commander" },
  { id: 1, label: "Standard" },
];
const SUPER_PESQUISA_DECKS_PER_FORMAT = 4; // how many recent decks to try per format before moving to the next one
const SUPER_PESQUISA_TAB_TIMEOUT_MS = 15_000;
// After "Próximo" on the card-list step, LigaMagic validates every line
// against its own catalog server-side and silently rewrites recognized ones
// to its own catalog display name in place (this is the site's own list
// parser doing its normal job on whatever plain-text list it's handed --
// nothing this codebase writes or rewrites), before the "Pesquisar" button
// for the next step appears. Confirmed live (2026-09-14): for a plain
// 22-card list, that alone ran well past SUPER_PESQUISA_TAB_TIMEOUT_MS's
// 15s -- a tab that had been sitting there long enough to look permanently
// stuck turned out to still complete on its own once given more time,
// landing on a fully matched, error-free list with "Pesquisar" ready. Kept
// as its own constant rather than just reusing SUPER_PESQUISA_TAB_TIMEOUT_MS
// for this wait too, since that one's still the right, short timeout for an
// actual page load.
const SUPER_PESQUISA_VALIDATE_TIMEOUT_MS = 90_000;
// A padded ~110-card search is a genuinely heavy call — confirmed live it
// takes well past the few seconds a small search does.
const SUPER_PESQUISA_SEARCH_TIMEOUT_MS = 60_000;
// How many times a search retries after dropping card names LigaMagic
// rejected outright, before giving up — approved by the user (2026-09-13) as
// a one-shot fallback, not a loop: a public deck's own card should almost
// always already be a name the marketplace recognizes, since it's the same
// database, but an unusual spelling or a promo-only name can still slip
// through.
const SUPER_PESQUISA_MAX_RETRIES = 1;

function superPesquisaLog(...args) {
  console.log("[LigaMagic Tracker | Super Pesquisa]", ...args);
}

/**
 * The run is long (two full searches plus a public-deck crawl, minutes in
 * practice) and happens on a tab the user isn't looking at, so the origin
 * tab gets told which step it's on as it goes -- see
 * buildSuperPesquisaDecisionBody in super-pesquisa.js for where this lands
 * on screen. Order matches handleStartSuperPesquisa's own flow; the last
 * one is finished by the second tab's content script, not here.
 */
const SUPER_PESQUISA_ETAPAS = [
  "abrindo a aba de pesquisa",
  "montando a lista de descoberta com decks públicos",
  "pesquisa de descoberta, sem restringir lojas",
  "escolhendo a melhor combinação de lojas",
  "pesquisa final, só com suas cartas nas lojas escolhidas",
  "aplicando as economias e fechando a conta",
];

function superPesquisaProgresso(originTabId, etapa) {
  superPesquisaLog(`Etapa ${etapa} de ${SUPER_PESQUISA_ETAPAS.length}: ${SUPER_PESQUISA_ETAPAS[etapa - 1]}`);
  if (originTabId == null) return;
  chrome.tabs
    .sendMessage(originTabId, {
      action: "superPesquisaProgresso",
      etapa,
      total: SUPER_PESQUISA_ETAPAS.length,
      descricao: SUPER_PESQUISA_ETAPAS[etapa - 1],
    })
    .catch(() => {}); // aba de origem pode ter sido fechada ou navegada
}

/**
 * Reads two things from the page's own wizard state, fresh:
 *   - caracteristicas: the general idioma/extras/qualidade/estoque/pré-venda
 *     filter panel, so the second tab's searches replicate it exactly.
 *   - usouVersoesExatas: whether the user's own submitted list pinned a
 *     specific edition/idioma/qualidade/extras/número per card (typed inline
 *     tags), rather than relying only on that general panel — read straight
 *     off wizard.json.cards[i].edicao/idioma/qualidade/extras/sNumber, which
 *     LigaMagic itself leaves empty per card whenever no such tag was typed
 *     for it (confirmed live 2026-09-13). Lets Super Pesquisa auto-replicate
 *     whichever the user actually did, instead of asking.
 */
async function handleGetListaFiltros(tabId) {
  if (tabId == null) return { caracteristicas: null, usouVersoesExatas: false };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        if (typeof wizard === "undefined") return { caracteristicas: null, usouVersoesExatas: false };
        const cards = wizard.json?.cards ?? [];
        const pinado = (c) =>
          Boolean(c.edicao || c.idioma || c.qualidade || c.sNumber || (Array.isArray(c.extras) && c.extras.length > 0));
        return {
          caracteristicas: wizard.json?.caracteristicas ?? null,
          usouVersoesExatas: cards.some(pinado),
        };
      },
    });
    return results[0]?.result ?? { caracteristicas: null, usouVersoesExatas: false };
  } catch {
    return { caracteristicas: null, usouVersoesExatas: false }; // not a scriptable ligamagic.com.br page right now
  }
}

/** Pokes the same filters directly into the new tab's own wizard state — bypassing the UI, same style handleSyncCustomStoreIds already uses for the custom-store list. */
async function applyListaFiltros(tabId, filtros) {
  if (!filtros) return;
  await chrome.scripting
    .executeScript({
      target: { tabId },
      world: "MAIN",
      func: (f) => {
        if (typeof wizard !== "undefined" && wizard.json) {
          wizard.json.caracteristicas = { ...wizard.json.caracteristicas, ...f };
        }
      },
      args: [filtros],
    })
    .catch(() => {});
}

/** "1 Card Name" / "1 card name [qualidade=...]..." → "card name", for de-duplicating padding against the user's own cards regardless of which list format was chosen. */
function cardNameFromLine(line) {
  return line
    .replace(/^\d+\s+/, "")
    .split("[")[0]
    .trim()
    .toLowerCase();
}

/** Swaps just the leading quantity of a "qty name..." line, keeping the name and any exact-version "[...]" tag untouched. */
function lineWithQty(line, qty) {
  return line.replace(/^\d+\s+/, `${qty} `);
}

function superPesquisaTetoDaLinha(line) {
  const isBasic = SUPER_PESQUISA_BASIC_LANDS.some((nome) => nome.toLowerCase() === cardNameFromLine(line));
  return isBasic ? SUPER_PESQUISA_MAX_QTY_BASIC : SUPER_PESQUISA_MAX_QTY_NORMAL;
}

/**
 * Raises the user's own discovery lines toward their per-line ceiling only as
 * far as SUPER_PESQUISA_DISCOVERY_TARGET_TOTAL_QTY has room for.
 *
 * Inflating quantities is what makes LigaMagic's own store picker reach past
 * the two or three stores a small list settles into (a store holding a single
 * copy can't cover a line asking for eight), but sending every line straight
 * to its ceiling only fits while the list is small: at 8 per nonbasic line
 * (40 per basic), a 100-card list asks for ~800 units on its own, twice the
 * budget and past the point where the site's own search API starts timing out
 * or erroring outright (see that constant).
 *
 * So the quantity isn't per-line at all, it's a shared floor: every line is
 * raised to the same number, never below what the user actually wants and
 * never above its own ceiling, and the floor climbs as high as the budget
 * allows. A small list still reaches the ceiling exactly like before; a
 * 100-card one lands on a smaller shared multiple instead of blowing through
 * the budget. A list whose real quantities alone already exceed the budget is
 * left at those real quantities -- asking for less than the user wants would
 * make the discovery's own stock picture wrong.
 */
function superPesquisaLinhasDeDescoberta(targetLines) {
  const tetos = targetLines.map(superPesquisaTetoDaLinha);
  const reais = targetLines.map((line) => parseInt(line, 10) || 1);
  const quantidades = (piso) => reais.map((real, i) => Math.min(tetos[i], Math.max(real, piso)));
  const somar = (qtds) => qtds.reduce((soma, qtd) => soma + qtd, 0);

  let piso = 1;
  while (piso < SUPER_PESQUISA_MAX_QTY_BASIC && somar(quantidades(piso + 1)) <= SUPER_PESQUISA_DISCOVERY_TARGET_TOTAL_QTY) {
    piso++;
  }

  const qtds = quantidades(piso);
  return {
    linhas: targetLines.map((line, i) => lineWithQty(line, qtds[i])),
    totalQty: somar(qtds),
    piso,
  };
}

async function fetchRecentDeckIds(tabId, formatId, timeoutMs) {
  await chrome.tabs.update(tabId, { url: `https://www.ligamagic.com.br/?view=dks/decks&filtro_formato=${formatId}` });
  if (!(await waitForTabComplete(tabId, timeoutMs))) return [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const links = [...document.querySelectorAll('a[href*="view=dks/deck&id="]')];
        return [...new Set(links.map((a) => (a.getAttribute("href").match(/id=(\d+)/) ?? [])[1]).filter(Boolean))];
      },
    });
    return results[0]?.result ?? [];
  } catch {
    return [];
  }
}

/** Same "dk-val-1-*" board scraper-deck.js already reads, generalized to any deck id (own or public — it's a plain DOM read either way) and paired with quantity for a directly search-ready "N Name" line. */
async function fetchDeckLines(tabId, deckId, timeoutMs) {
  await chrome.tabs.update(tabId, { url: `https://www.ligamagic.com.br/?view=dks/deck&id=${deckId}` });
  if (!(await waitForTabComplete(tabId, timeoutMs))) return [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const rows = [...document.querySelectorAll('[id^="dk-val-1-"] .deck-line')];
        const cards = [];
        for (const row of rows) {
          const qtyEl = row.querySelector(".deck-qty");
          const link = row.querySelector(".deck-card a");
          if (!qtyEl || !link) continue;
          const qty = parseInt(qtyEl.textContent.trim(), 10) || 1;
          const name = link.getAttribute("data-lc-name");
          if (name) cards.push({ qty, name });
        }
        return cards;
      },
    });
    return results[0]?.result ?? [];
  } catch {
    return [];
  }
}

/**
 * Pulls cards from a handful of recent public decks, across
 * SUPER_PESQUISA_PADDING_FORMATS, until `neededCount` distinct new lines are
 * collected or every format's decks are exhausted. Reads straight off the
 * public "Decks" browser (?view=dks/decks) and individual deck pages — the
 * exact same pages/markup a person browsing them manually would see; nothing
 * is created, edited, favorited, or otherwise written to any account.
 */
/**
 * Fisher-Yates shuffle -- used below so a repeated Super Pesquisa run can
 * pick a different sample of the SAME already-fetched "recent decks" list
 * instead of always the newest SUPER_PESQUISA_DECKS_PER_FORMAT ones. Zero
 * extra requests: fetchRecentDeckIds already returns every deck id linked
 * off that one page load (~40, confirmed live), and this only changes which
 * of those already-in-hand ids get used, not how many pages get fetched.
 */
function shuffleArray(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function pickPaddingDecks(tabId, neededCount, excludeNamesLower) {
  const padding = [];
  const seen = new Set(excludeNamesLower);

  for (const format of SUPER_PESQUISA_PADDING_FORMATS) {
    if (padding.length >= neededCount) break;
    const deckIds = await fetchRecentDeckIds(tabId, format.id, SUPER_PESQUISA_TAB_TIMEOUT_MS);
    superPesquisaLog(`${format.label}: ${deckIds.length} recent deck(s) found.`);

    for (const deckId of shuffleArray(deckIds).slice(0, SUPER_PESQUISA_DECKS_PER_FORMAT)) {
      if (padding.length >= neededCount) break;
      const cards = await fetchDeckLines(tabId, deckId, SUPER_PESQUISA_TAB_TIMEOUT_MS);
      for (const { qty, name } of cards) {
        if (padding.length >= neededCount) break;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        padding.push(`${qty} ${name}`);
      }
    }
  }
  return padding;
}

/**
 * Waits (rather than just checking once) for the "recuperar última lista?"
 * popup to show up right after a fresh page load, and dismisses it via its
 * real "Ignorar Lista" button the moment it does — calling its internal
 * clearLembrarDecisaoOpcional()/show() directly instead empties the
 * textarea (confirmed live), so this always drives the actual button. Its
 * buttons are plain `<input type="button">` elements, whose label lives in
 * `.value`, not `.textContent` (confirmed live 2026-09-13 -- textContent is
 * always empty on these, which silently no-op'd this dismiss whenever the
 * popup actually appeared).
 *
 * Must run BEFORE fillCardListStep, never after: this popup's own dismiss
 * handler resets the wizard's step-1 model, not just the visible textarea
 * -- confirmed live (2026-09-13) that clicking it after cards were already
 * typed and submitted wipes them, so the very next "Pesquisar" click fails
 * with the site's own "Preencha sua Lista de Cards" validation error. A
 * fixed check immediately after navigation isn't reliable either: on a
 * loaded page this popup can render asynchronously, slightly after that
 * check already ran and found nothing -- hence polling for a few seconds
 * instead of a single look.
 */
async function waitAndDismissCardsFromStoragePopupIfAny(tabId, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let dismissed = false;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const popup = document.getElementById("popup-cards-from-storage");
          if (!popup || getComputedStyle(popup).display === "none") return false;
          [...popup.querySelectorAll(".botao")].find((b) => (b.value ?? b.textContent).trim() === "Ignorar Lista")?.click();
          return true;
        },
      });
      dismissed = results[0]?.result ?? false;
    } catch {
      dismissed = false; // tab mid-navigation — keep polling
    }
    if (dismissed) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/**
 * Polls until the wizard's next step actually has a visible search button —
 * replaces an earlier fixed 800ms settle-time that a heavier, ~110-card list
 * could outlast (confirmed live 2026-09-13: the button just wasn't there yet
 * at that fixed checkpoint).
 *
 * Found by the site's own id (#btPesquisar), not by its label: the label is
 * not a stable identifier (this extension itself adds a second line to it
 * saying which store scope is selected, and "Pesquisar" is also the label of
 * the custom-store bar's own button right there on the same page).
 */
async function waitForPesquisarStepReady(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let ready = false;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const botao = document.getElementById("btPesquisar");
          return !!botao && botao.offsetParent !== null;
        },
      });
      ready = results[0]?.result ?? false;
    } catch {
      ready = false; // tab mid-navigation — keep polling
    }
    if (ready) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function fillCardListStep(tabId, cardListText) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (text) => {
      const ta = document.getElementById("card_list");
      if (!ta) return;
      ta.value = text;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new Event("change", { bubbles: true }));
      const proximo = [...document.querySelectorAll(".botao")].find(
        (b) => b.textContent.trim() === "Próximo" && b.offsetParent !== null,
      );
      proximo?.click();
    },
    args: [cardListText],
  });
}

/**
 * With no `scopedStoreIds`: raises "Quantidade Máxima de Lojas" to unlimited
 * (both in wizard.json directly and via the visible field, since it's
 * unclear from the outside whether something re-derives one from the other
 * right before pesquisar() fires) under "Todas Lojas", the default filter,
 * so this search sees every store on the platform with nothing excluded by
 * construction — this is the discovery search.
 *
 * With `scopedStoreIds`: installs the same custom-store-search override the
 * "Buscar Lojas" bar already uses (handleInstallSearchOverride /
 * handleSyncCustomStoreIds — see store-search-override.js for the manual
 * side of this) and switches the page to "Minhas Favoritas + Buscar Lojas",
 * the only filter mode that override actually intercepts, so the search
 * only considers exactly the stores a prior discovery search surfaced —
 * this is the final, real-quantity search.
 *
 * Either way, clicks "Pesquisar" last.
 */
async function submitSearchStep(tabId, scopedStoreIds) {
  if (scopedStoreIds && scopedStoreIds.length > 0) {
    await handleInstallSearchOverride(tabId);
    await handleSyncCustomStoreIds(scopedStoreIds, tabId);
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const radio = document.querySelector('input[name="txt_tipo_filtro"][value="2"]');
        if (radio && !radio.checked) {
          radio.checked = true;
          radio.dispatchEvent(new Event("change", { bubbles: true }));
        }
      },
    });
  } else {
    // "Todas Lojas" has to be set explicitly, not inherited: LigaMagic
    // remembers this radio per account across page loads, so a discovery
    // pass that only assumed it would silently run inside the account's
    // favourites instead of the whole marketplace -- which is the exact
    // opposite of what a discovery pass is for. Measured live (2026-09-16):
    // the same discovery list found 3 stores inherited vs. 50 forced.
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const radio = document.querySelector('input[name="txt_tipo_filtro"][value="1"]');
        if (radio && !radio.checked) {
          radio.checked = true;
          radio.dispatchEvent(new Event("change", { bubbles: true }));
        }
      },
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        if (typeof wizard !== "undefined" && wizard.json?.lojas) {
          wizard.json.lojas.quantidadeLimite = "0";
        }
      },
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const maxLojas = document.getElementById("txt_max_lojas");
        if (maxLojas) {
          maxLojas.value = "0";
          maxLojas.dispatchEvent(new Event("change", { bubbles: true }));
        }
      },
    });
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // Pelo id do próprio site, não pelo rótulo -- ver waitForPesquisarStepReady.
      document.getElementById("btPesquisar")?.click();
    },
  });
}

/** Reads which "Tipo de Busca" radio (txt_tipo_filtro) is currently selected -- LigaMagic remembers this choice across page loads for the account, so a scoped search that has to force it to "2" (Minhas Favoritas + Buscar Lojas, see submitSearchStep) needs to restore whatever was selected before, or it silently overwrites the account's own remembered default from then on. */
async function readTipoFiltroAtual(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.querySelector('input[name="txt_tipo_filtro"]:checked')?.value ?? null,
  });
  return results[0]?.result ?? null;
}

/** Counterpart to readTipoFiltroAtual -- puts the radio back (firing the same "change" event submitSearchStep's own forcing relies on) once a search is over, so only that one search ever moved it, never the account's remembered default. */
async function restaurarTipoFiltro(tabId, valor) {
  if (valor == null) return;
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (valorRestaurar) => {
      const radio = document.querySelector(`input[name="txt_tipo_filtro"][value="${valorRestaurar}"]`);
      if (radio && !radio.checked) {
        radio.checked = true;
        radio.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    args: [valor],
  });
}

/** Polls "#main_calculando_fretes" (the same indicator analise-economia.js's own freteAindaCalculando() reads) until shipping cost has finished calculating for every assigned store, or the timeout elapses. */
async function waitForFreteCalculado(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let done = false;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const indicador = document.getElementById("main_calculando_fretes");
          return !indicador || indicador.classList.contains("d-none");
        },
      });
      done = results[0]?.result ?? false;
    } catch {
      done = false; // tab mid-navigation — keep polling
    }
    if (done) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * Waits for one Compra por Lista search to settle into either outcome:
 *   - success: "#btn-finalizar" renders (results are in).
 *   - rejected: an error modal shows ("Ops! ..."), either the 110-card cap
 *     or one or more card names LigaMagic didn't recognize.
 * The modal concatenates every unrecognized name with no separator between
 * them, so this doesn't try to split them apart — it just returns the raw
 * blob, and the caller (which already has its own list of submitted lines)
 * checks each of ITS OWN names for membership instead, sidestepping the
 * parsing problem entirely.
 */
async function waitForSearchOutcome(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let result = null;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          if (document.getElementById("btn-finalizar")) return { ok: true };
          const modal = [...document.querySelectorAll(".modal")].find(
            (m) => m.offsetParent !== null && /Ops!/.test(m.textContent),
          );
          if (!modal) return null;
          const text = modal.textContent.trim();
          const notFoundMatch = text.match(/Cards não encontrados([\s\S]*?)Verifique/);
          return notFoundMatch
            ? { ok: false, notFoundBlob: notFoundMatch[1].toLowerCase() }
            : { ok: false, error: text.slice(0, 300) };
        },
      });
      result = results[0]?.result ?? null;
    } catch {
      result = null; // tab mid-navigation — keep polling
    }
    if (result) return result;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, error: "timeout" };
}

/**
 * Drives one full Compra por Lista search on `tabId` from a fresh page load
 * through to a read-back `resultado`: navigate, (re)apply filters, fill the
 * card list, advance, submit (unrestricted, or scoped to `scopedStoreIds` —
 * see submitSearchStep), and wait for the outcome — retrying once
 * (SUPER_PESQUISA_MAX_RETRIES) by dropping any card name the site rejected
 * outright.
 */
async function driveSuperPesquisaSearch(tabId, initialLines, { filtros, scopedStoreIds } = {}) {
  let lines = [...initialLines];
  // LigaMagic remembers the "Tipo de Busca" radio (Todas Lojas vs. Minhas
  // Favoritas) per account across page loads, and both halves of a Super
  // Pesquisa force it: discovery to "Todas Lojas", the scoped pass to
  // "Minhas Favoritas". Whatever the user had picked is captured once, on
  // the first attempt that gets far enough for the radio to exist, and put
  // back in the finally below -- on every exit, not just the successful one.
  // Restoring only on success (which is what this used to do) meant any
  // failed scoped search left the account stuck on "Minhas Favoritas"
  // permanently, and every later discovery pass inherited it.
  let tipoFiltroAntes = null;
  let capturouTipoFiltro = false;

  try {
    for (let attempt = 0; attempt <= SUPER_PESQUISA_MAX_RETRIES; attempt++) {
      await chrome.tabs.update(tabId, { url: "https://www.ligamagic.com.br/?view=cards/lista" });
      if (!(await waitForTabComplete(tabId, SUPER_PESQUISA_TAB_TIMEOUT_MS))) {
        return { ok: false, error: "A aba não terminou de carregar." };
      }

      await applyListaFiltros(tabId, filtros);

      await waitAndDismissCardsFromStoragePopupIfAny(tabId);
      await fillCardListStep(tabId, lines.join("\n"));
      if (!(await waitForPesquisarStepReady(tabId, SUPER_PESQUISA_VALIDATE_TIMEOUT_MS))) {
        return { ok: false, error: "A etapa de pesquisa não ficou pronta a tempo." };
      }

      if (!capturouTipoFiltro) {
        tipoFiltroAntes = await readTipoFiltroAtual(tabId);
        capturouTipoFiltro = true;
      }
      await submitSearchStep(tabId, scopedStoreIds);

      const outcome = await waitForSearchOutcome(tabId, SUPER_PESQUISA_SEARCH_TIMEOUT_MS);
      if (outcome.ok) {
        // "#btn-finalizar" rendering only means results exist, not that every
        // assigned store's shipping fee has finished calculating -- confirmed
        // live (2026-09-13) that reading resultado right away can catch a
        // store's frete as still null, which any total computed from it would
        // silently treat as zero, understating the real cost and reporting a
        // false "savings" that doesn't survive a moment later once frete
        // settles.
        await waitForFreteCalculado(tabId, SUPER_PESQUISA_SEARCH_TIMEOUT_MS);
        const resultado = await handleGetListaResultado(tabId);
        return { ok: true, resultado };
      }

      if (outcome.notFoundBlob && attempt < SUPER_PESQUISA_MAX_RETRIES) {
        const before = lines.length;
        lines = lines.filter((line) => !outcome.notFoundBlob.includes(cardNameFromLine(line)));
        if (lines.length === before) {
          return { ok: false, error: "Cards não reconhecidos pela pesquisa, mas não foi possível identificar quais." };
        }
        superPesquisaLog(`Pesquisa rejeitou ${before - lines.length} card(s) não reconhecido(s), tentando de novo sem eles.`);
        continue;
      }
      return { ok: false, error: outcome.error ?? "Erro desconhecido na pesquisa." };
    }
    return { ok: false, error: "Excedeu o número de tentativas." };
  } finally {
    if (capturouTipoFiltro) {
      // Never let a restore failure (tab already closed, page navigated
      // away) replace whatever this function was actually returning.
      try {
        await restaurarTipoFiltro(tabId, tipoFiltroAntes);
      } catch {
        // nothing left to restore on -- the tab is gone
      }
    }
  }
}

// ── Plano de compra a partir do mapa de ofertas da descoberta ────────────────
/**
 * The discovery pass doesn't just reveal WHICH stores exist -- its result
 * carries, for every store it surfaced, that store's own offers (price and
 * stock) for every searched line, including the ones it wasn't assigned to
 * sell. That is a real (card × store) price map, and throwing it away to
 * re-ask LigaMagic to optimize over all of those stores at once leaves money
 * on the table: measured live (2026-09-16) on a 22-card deck, the site's own
 * answer over the 50 discovered stores was R$ 834,12 → R$ 820,69, while
 * choosing the stores from this same map first and only then searching came
 * out at R$ 803,00.
 *
 * The reason the narrower search wins is shipping. LigaMagic already picks
 * the cheapest store per card within whatever pool it's given (confirmed
 * live: card subtotals match to the cent), so there is nothing to gain on
 * prices -- but each store added to the pool is another shipping fee it may
 * decide to pay. Deciding the pool here, with the fees counted in, is the
 * whole gain.
 */
const SUPER_PESQUISA_PLANO_TENTATIVAS = 150;
const SUPER_PESQUISA_PLANO_OFERTAS_POR_CARTA = 8;

/**
 * The (card × store) offer map for the user's REAL cards only -- the
 * discovery list also carried padding nobody is buying, and those lines'
 * offers would drag the plan toward stores that are only good for cards
 * that were never wanted.
 *
 * Returns null when any wanted card has no offer at all in the result: a
 * plan built without it would scope the final search to stores that can't
 * supply it, which is worse than not planning. Callers fall back to the
 * whole discovered pool in that case.
 */
function mapaDeOfertasDaDescoberta(resultado, targetLines) {
  // Acentos fora dos dois lados: o resultado do site devolve o nome em
  // português já sem eles ("Custodia de Tamiyo"), e a lista de onde saem as
  // targetLines nem sempre passou pelo mesmo caminho -- casar as duas formas
  // cruas perderia carta por um cedilha.
  const chaveNome = (nome) =>
    (nome ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();

  const desejadas = new Map(); // nome normalizado -> índice da carta
  const cartas = [];
  for (const line of targetLines) {
    const nome = chaveNome(cardNameFromLine(line));
    if (desejadas.has(nome)) continue;
    desejadas.set(nome, cartas.length);
    cartas.push({ nome, qtd: parseInt(line, 10) || 1, ofertas: [] });
  }

  const lojas = [];
  const indicePorBloco = new Map();
  for (const bloco of Object.values(resultado ?? {})) {
    if (!bloco || bloco.loja == null) continue;
    // Uma loja que o site listou mas cujo frete ele nunca calculou não pode
    // entrar no plano -- sem o frete não dá pra comparar o custo de abri-la.
    // Só ela sai, não o plano inteiro: se ela era a única fonte de alguma
    // carta, essa carta fica sem oferta e o plano cai fora logo abaixo.
    if (typeof bloco.frete !== "number" || Number.isNaN(bloco.frete)) continue;
    const j = lojas.length;
    lojas.push({ id: String(bloco.loja), nome: bloco.nomeLoja, frete: Math.round(bloco.frete * 100) });
    indicePorBloco.set(bloco, j);

    for (const carta of bloco.cartas ?? []) {
      if (!carta) continue;
      const estoque = carta.iQuant ?? 0;
      if (estoque <= 0) continue;
      const alvo = desejadas.get(chaveNome(carta.nomeInglesSA)) ?? desejadas.get(chaveNome(carta.nomePortuguesSA));
      if (alvo === undefined) continue; // carta de preenchimento
      cartas[alvo].ofertas.push([j, Math.round(carta.preco * 100), estoque]);
    }
  }

  for (const carta of cartas) {
    if (carta.ofertas.length === 0) return null;
    carta.ofertas.sort((a, b) => a[1] - b[1]);
  }
  return { cartas, lojas };
}

/**
 * Which stores to actually buy from. Choosing the set is facility location
 * (each store's shipping is a fixed cost paid only if it's used), so it's
 * NP-hard and an exact search is out of the question here -- a branch and
 * bound over the real 47-store map took minutes. What IS cheap is that,
 * once the set is fixed, the best split is just filling each card from the
 * cheapest offers inside it: the cards never compete for anything (stock is
 * per offer, and no store has an overall item limit), so there is no flow
 * problem to solve, and a whole set can be priced in one pass over the
 * offers.
 *
 * That makes local search the right tool: a greedy construction, then
 * add/drop/swap until nothing improves, repeated from random starts.
 * Validated against brute force on 38 random sub-maps of the real data --
 * identical answer on all 38 -- and against the two full maps whose optimum
 * was proven separately, also identical, in about 100ms.
 *
 * Cards with no reachable offer are priced at `penalidade` instead of
 * rejecting the set outright, so the greedy construction can still compare
 * two incomplete sets and make progress; anything still incomplete at the
 * end is reported as no plan.
 */
function escolherLojasDoPlano(cartas, fretes, tentativas = SUPER_PESQUISA_PLANO_TENTATIVAS) {
  const aberta = new Uint8Array(fretes.length);
  let semente = 1;
  const rand = () => ((semente = (semente * 1664525 + 1013904223) >>> 0) / 4294967296);

  let penalidade = 0;
  for (const carta of cartas) penalidade += (carta.ofertas[carta.ofertas.length - 1]?.[1] ?? 0) * carta.qtd;
  penalidade = penalidade * 4 + 1;

  const custo = (conj) => {
    aberta.fill(0);
    let total = 0;
    for (const j of conj) {
      aberta[j] = 1;
      total += fretes[j];
    }
    for (const carta of cartas) {
      let falta = carta.qtd;
      for (const [loja, preco, estoque] of carta.ofertas) {
        if (!aberta[loja]) continue;
        const usar = estoque < falta ? estoque : falta;
        total += usar * preco;
        falta -= usar;
        if (falta === 0) break;
      }
      if (falta > 0) total += penalidade * falta;
    }
    return total;
  };

  // Só as lojas que estão entre as mais baratas de alguma carta: nenhuma
  // outra entra num conjunto ótimo, e cortá-las encolhe muito a vizinhança.
  const candidatasSet = new Set();
  for (const carta of cartas) {
    let vistas = 0;
    let ultima = -1;
    for (const [loja] of carta.ofertas) {
      if (loja === ultima) continue;
      ultima = loja;
      candidatasSet.add(loja);
      if (++vistas >= SUPER_PESQUISA_PLANO_OFERTAS_POR_CARTA) break;
    }
  }
  const candidatas = [...candidatasSet];

  const buscaLocal = (inicial) => {
    const conj = new Set(inicial);
    let melhor = custo([...conj]);
    for (let passe = 0; passe < 40; passe++) {
      let mudou = false;
      for (const j of candidatas) {
        const tinha = conj.has(j);
        if (tinha) conj.delete(j);
        else conj.add(j);
        const c = custo([...conj]);
        if (c < melhor) {
          melhor = c;
          mudou = true;
        } else if (tinha) conj.add(j);
        else conj.delete(j);
      }
      for (const dentro of [...conj]) {
        let trocou = false;
        for (const fora of candidatas) {
          if (conj.has(fora)) continue;
          conj.delete(dentro);
          conj.add(fora);
          const c = custo([...conj]);
          if (c < melhor) {
            melhor = c;
            mudou = true;
            trocou = true;
            break;
          }
          conj.add(dentro);
          conj.delete(fora);
        }
        if (trocou) break;
      }
      if (!mudou) break;
    }
    return { custo: melhor, conj };
  };

  const guloso = new Set();
  let atual = custo([]);
  for (;;) {
    let passo = null;
    for (const j of candidatas) {
      if (guloso.has(j)) continue;
      guloso.add(j);
      const c = custo([...guloso]);
      guloso.delete(j);
      if (passo === null || c < passo.c) passo = { j, c };
    }
    if (!passo || passo.c >= atual) break;
    guloso.add(passo.j);
    atual = passo.c;
  }

  let melhor = buscaLocal(guloso);
  for (let t = 0; t < tentativas; t++) {
    const inicial = new Set();
    const alvo = 2 + Math.floor(rand() * 8);
    while (inicial.size < alvo && inicial.size < candidatas.length) {
      inicial.add(candidatas[Math.floor(rand() * candidatas.length)]);
    }
    const r = buscaLocal(inicial);
    if (r.custo < melhor.custo) melhor = r;
  }
  if (melhor.custo >= penalidade) return null; // sobrou carta sem loja

  // Aloca de verdade: uma loja aberta da qual nada acaba sendo comprado não
  // pode ir pra busca final, ou o site ganha a chance de reabri-la.
  aberta.fill(0);
  for (const j of melhor.conj) aberta[j] = 1;
  const usadas = new Set();
  let cards = 0;
  for (const carta of cartas) {
    let falta = carta.qtd;
    for (const [loja, preco, estoque] of carta.ofertas) {
      if (!aberta[loja]) continue;
      const usar = estoque < falta ? estoque : falta;
      if (usar <= 0) continue;
      usadas.add(loja);
      cards += usar * preco;
      falta -= usar;
      if (falta === 0) break;
    }
  }
  const lojas = [...usadas];
  const frete = lojas.reduce((soma, j) => soma + fretes[j], 0);
  return { lojas, cards, frete, total: cards + frete };
}

/**
 * The stores the final search should be restricted to, chosen from the
 * discovery's own offer map rather than "all of them". Returns null when the
 * map can't be built or no viable set exists, so the caller keeps the old
 * behaviour of searching the whole discovered pool.
 */
function planejarLojasDaCompra(resultado, targetLines) {
  const mapa = mapaDeOfertasDaDescoberta(resultado, targetLines);
  if (!mapa) return null;
  const escolha = escolherLojasDoPlano(
    mapa.cartas,
    mapa.lojas.map((l) => l.frete),
  );
  if (!escolha || escolha.lojas.length === 0) return null;
  return {
    storeIds: escolha.lojas.map((j) => mapa.lojas[j].id),
    nomes: escolha.lojas.map((j) => mapa.lojas[j].nome),
    // Estimativa, não promessa: o frete de cada loja muda conforme o que se
    // compra nela (peso e valor declarado), e os fretes deste mapa vieram da
    // descoberta, onde cada loja carregava uma cesta bem maior. Medido ao
    // vivo (2026-09-16): os cards batem no centavo, os fretes vieram ~4%
    // acima. O número que o usuário vê é sempre o da busca final, nunca este.
    totalEstimado: escolha.total / 100,
  };
}

/** Every distinct LigaMagic store ID present in a resultado -- `bloco.loja` is the numeric store ID, same one `txt_lojafav[]` checkboxes use. */
function harvestStoreIds(resultado) {
  const ids = new Set();
  for (const bloco of Object.values(resultado ?? {})) {
    if (bloco?.loja != null) ids.add(String(bloco.loja));
  }
  return [...ids];
}

/** Every distinct store (id + display name) present in a resultado -- unlike harvestStoreIds above, this also keeps `bloco.nomeLoja` for display, e.g. the "compre nas lojas X, Y, Z" line in the Super Pesquisa decision prompt. */
function harvestStores(resultado) {
  const byId = new Map();
  for (const bloco of Object.values(resultado ?? {})) {
    if (bloco?.loja != null) byId.set(String(bloco.loja), bloco.nomeLoja ?? String(bloco.loja));
  }
  return [...byId.entries()].map(([id, nome]) => ({ id, nome }));
}

/**
 * Per-second-tab context for an in-flight (or already-finished) Super
 * Pesquisa run: the origin tab to report back to, and the exact
 * real-quantity search (targetLines/filtros) phase 2 used. Once phase 2 and
 * its reorganização pass land, storeIds/totalComReorgDepois get filled in
 * too (see handleSuperPesquisaReorgApplied) so a later "Sim" click (see
 * handleSuperPesquisaApplyToOrigin) can replay that exact scoped search on
 * the origin tab without redoing the discovery pass. Deliberately NOT
 * cleared just because the decision prompt was dismissed ("Não") — the
 * whole point of keeping it around is letting the user reopen the same
 * result later (via the Análise de Economia modal) without paying for
 * another search. Cleared only on outright failure (the catch block below).
 */
const superPesquisaContextByTabId = new Map();

async function handleStartSuperPesquisa(payload, originTabId) {
  const { targetLines, filtros, baselineComReorg } = payload ?? {};
  if (!Array.isArray(targetLines) || targetLines.length === 0) return;

  const reportBack = (message) => {
    if (originTabId == null) return;
    chrome.tabs.sendMessage(originTabId, { action: "superPesquisaResult", ...message }).catch(() => {});
  };

  let tab;
  try {
    superPesquisaProgresso(originTabId, 1);
    // Backgrounded on purpose: this tab exists to run a search, not to be
    // looked at -- see "superPesquisaFocusTab" for the one path (the user
    // explicitly asking for it) that ever brings it to the front.
    tab = await chrome.tabs.create({ url: "https://www.ligamagic.com.br/?view=cards/lista", active: false });
    superPesquisaContextByTabId.set(tab.id, { originTabId, targetLines, filtros, baselineComReorg });
    if (!(await waitForTabComplete(tab.id, SUPER_PESQUISA_TAB_TIMEOUT_MS))) {
      throw new Error("A aba não terminou de carregar.");
    }

    // Phase 1 — discovery: the user's real cards, each pushed straight to
    // its own true per-line ceiling (SUPER_PESQUISA_MAX_QTY_NORMAL/BASIC),
    // plus as much public-deck padding -- at that same nonbasic ceiling -- as
    // fits under SUPER_PESQUISA_DISCOVERY_TARGET_TOTAL_QTY's total-quantity
    // budget (see that constant for why a budget instead of a per-line
    // multiplier, and why this no longer injects synthetic basic-land
    // lines). Searched under "Todas Lojas" (no store restriction). The
    // padding is never bought -- it exists only to make LigaMagic's own
    // store-selection algorithm consider a much wider slice of the
    // marketplace than the user's own small list alone ever surfaces.
    // Confirmed live (2026-09-13): the exact same 5 cards, searched alone,
    // settled on 2 stores; padded with ~45 unrelated staples under the same
    // settings, those same 5 cards spread across 4 different stores,
    // including one that never appeared at all in the small search.
    const usedNames = new Set(targetLines.map(cardNameFromLine));

    const alvo = superPesquisaLinhasDeDescoberta(targetLines);
    const discoveryTargetLines = alvo.linhas;
    const realTotalQty = alvo.totalQty;

    // Padding always comes from public decklists (never basics), so it
    // always uses the nonbasic ceiling -- however many lines of it fit
    // within BOTH what's left of the total-quantity budget and what's left
    // of the SUPER_PESQUISA_MAX_CARDS line-count cap, whichever runs out
    // first.
    const remainingQtyBudget = Math.max(0, SUPER_PESQUISA_DISCOVERY_TARGET_TOTAL_QTY - realTotalQty);
    const remainingLineSlots = Math.max(0, SUPER_PESQUISA_MAX_CARDS - targetLines.length);
    const neededPadding = Math.min(remainingLineSlots, Math.floor(remainingQtyBudget / SUPER_PESQUISA_MAX_QTY_NORMAL));

    superPesquisaProgresso(originTabId, 2);
    const rawPadding = neededPadding > 0 ? await pickPaddingDecks(tab.id, neededPadding, usedNames) : [];
    const paddingLines = rawPadding.map((line) => lineWithQty(line, SUPER_PESQUISA_MAX_QTY_NORMAL));

    const discoveryLines = [...discoveryTargetLines, ...paddingLines];
    const totalQty = realTotalQty + rawPadding.length * SUPER_PESQUISA_MAX_QTY_NORMAL;
    superPesquisaLog(
      `Descoberta: ${targetLines.length} carta(s) do usuário (até ${alvo.piso} un. por linha) + ` +
        `${rawPadding.length} de preenchimento ` +
        `(${discoveryLines.length}/${SUPER_PESQUISA_MAX_CARDS} linhas, ${totalQty}/` +
        `${SUPER_PESQUISA_DISCOVERY_TARGET_TOTAL_QTY} unidades no total).`,
    );
    if (totalQty > SUPER_PESQUISA_DISCOVERY_TARGET_TOTAL_QTY) {
      superPesquisaLog(
        `A lista do usuário sozinha já pede ${realTotalQty} unidades, acima do alvo de ` +
          `${SUPER_PESQUISA_DISCOVERY_TARGET_TOTAL_QTY} — mantidas as quantidades reais, sem preenchimento.`,
      );
    }

    superPesquisaProgresso(originTabId, 3);
    const discovery = await driveSuperPesquisaSearch(tab.id, discoveryLines, { filtros });
    if (!discovery.ok) throw new Error(discovery.error ?? "Falha na pesquisa de descoberta.");

    // Phase 2 — the real search: just the user's real cards, at their real
    // quantities, no padding, scoped via the same custom-store-search
    // mechanism the "Buscar Lojas" bar already uses
    // (handleInstallSearchOverride/handleSyncCustomStoreIds), so the final
    // numbers (price, frete) are real and un-inflated by padding.
    //
    // Scoped to the stores a plan built from the discovery's own offer map
    // picks (see planejarLojasDaCompra), not to every store the discovery
    // surfaced. Handing LigaMagic the whole pool means paying for whichever
    // stores IT decides to spread the purchase over, and each one is another
    // shipping fee; picking the pool here, with the fees counted in, is
    // where the saving comes from. When no plan can be built (a wanted card
    // has no offer in the map, or some store's frete hadn't settled), this
    // falls back to the old behaviour of searching the whole pool.
    //
    // This can still miss a genuinely good store that never showed up in the
    // padding-driven discovery pass; that tradeoff is deliberate here,
    // favoring one lean, real-quantity search plus a small, targeted one
    // over repeatedly poking at an already-placed result one card at a time,
    // which forces LigaMagic's own frete recalculation on every single edit.
    superPesquisaProgresso(originTabId, 4);
    const storeIds = harvestStoreIds(discovery.resultado);
    const plano = planejarLojasDaCompra(discovery.resultado, targetLines);
    if (plano) {
      superPesquisaLog(
        `Descoberta encontrou ${storeIds.length} loja(s); o plano escolheu ${plano.storeIds.length} ` +
          `(${plano.nomes.join(", ")}), estimando R$ ${plano.totalEstimado.toFixed(2)}.`,
      );
    } else {
      superPesquisaLog(
        `Descoberta encontrou ${storeIds.length} loja(s); sem plano viável a partir do mapa de ofertas, ` +
          `refazendo a pesquisa restrita a todas elas.`,
      );
    }

    superPesquisaProgresso(originTabId, 5);
    let final = await driveSuperPesquisaSearch(tab.id, targetLines, {
      filtros,
      scopedStoreIds: plano ? plano.storeIds : storeIds,
    });
    if (!final.ok && plano) {
      // O plano sai de um retrato do mercado que pode ter envelhecido entre
      // as duas buscas (estoque acabou, loja saiu do ar). Em vez de desistir,
      // repete do jeito antigo, com todas as lojas da descoberta.
      superPesquisaLog(`Busca restrita ao plano falhou (${final.error}) -- repetindo com todas as lojas da descoberta.`);
      final = await driveSuperPesquisaSearch(tab.id, targetLines, { filtros, scopedStoreIds: storeIds });
    }
    if (!final.ok) throw new Error(final.error ?? "Falha na pesquisa final.");

    superPesquisaProgresso(originTabId, 6);
    superPesquisaLog("Pesquisa concluída — pedindo pra própria aba aplicar reorganização.");
    // From here on, the second tab's own content script (super-pesquisa.js,
    // injected automatically like on any other ligamagic.com.br page) takes
    // over: applying every viable "economia por reorganização" for real is a
    // UI/DOM concern, not something this service worker can or should do
    // directly. It reports back via "superPesquisaReorgApplied", handled
    // below.
    await chrome.tabs.sendMessage(tab.id, { action: "superPesquisaApplyReorgAndReport", context: "discovery" });
  } catch (err) {
    superPesquisaLog("Falhou —", err.message);
    if (tab?.id != null) superPesquisaContextByTabId.delete(tab.id);
    reportBack({ ok: false, error: err.message });
  }
}



/**
 * A tab (the second, backgrounded one after its own phase 2 -- context
 * "discovery" -- or the origin tab right after a "Sim" replay -- context
 * "applyToOrigin") just finished applying every viable reorganização for
 * real. This re-reads that same tab's now-final resultado itself
 * (handleGetListaResultado) to harvest the real store list a purchase there
 * would use (post-reorg closures included) -- the content script only ever
 * reports the money total, never the store list, since this file already
 * has the page-reading primitive for that.
 *
 * "discovery" relays a decision prompt to the run's origin tab (looked up
 * via superPesquisaContextByTabId, keyed by this tab's own id) as
 * "superPesquisaResult"; "applyToOrigin" instead confirms the change back to
 * this SAME tab as "superPesquisaAppliedHere", since by then the user is
 * already looking at it.
 */
async function handleSuperPesquisaReorgApplied(request, senderTabId) {
  if (senderTabId == null) return;
  const { context, totalComReorgDepois } = request;
  const resultado = await handleGetListaResultado(senderTabId);
  const lojas = harvestStores(resultado);

  if (context === "applyToOrigin") {
    chrome.tabs
      .sendMessage(senderTabId, { action: "superPesquisaAppliedHere", ok: true, totalComReorgDepois, lojas })
      .catch(() => {});
    return;
  }

  const ctx = superPesquisaContextByTabId.get(senderTabId);
  if (!ctx) return;
  ctx.storeIds = lojas.map((l) => l.id);
  ctx.totalComReorgDepois = totalComReorgDepois;

  const economia = (ctx.baselineComReorg ?? 0) - totalComReorgDepois;
  superPesquisaLog(
    `Concluído: base R$ ${(ctx.baselineComReorg ?? 0).toFixed(2)} -> R$ ${totalComReorgDepois.toFixed(2)} ` +
      `(economia R$ ${economia.toFixed(2)}, ${lojas.length} loja(s)).`,
  );
  if (ctx.originTabId != null) {
    chrome.tabs
      .sendMessage(ctx.originTabId, {
        action: "superPesquisaResult",
        ok: true,
        secondTabId: senderTabId,
        totalComReorgDepois,
        economia,
        lojas,
      })
      .catch(() => {});
  }
}

/**
 * The user clicked "Sim" on the decision prompt: replays the exact scoped
 * search a Super Pesquisa run already found savings in (cached
 * targetLines/filtros/storeIds from superPesquisaContextByTabId, keyed by
 * the second tab's own id) directly on the tab the user is currently
 * looking at, instead of redoing the discovery pass. Reports back to that
 * SAME (origin) tab once done -- see handleSuperPesquisaReorgApplied's
 * "applyToOrigin" branch.
 */
async function handleSuperPesquisaApplyToOrigin(secondTabId, originTabId) {
  if (originTabId == null) return;
  const ctx = secondTabId != null ? superPesquisaContextByTabId.get(secondTabId) : null;
  if (!ctx?.storeIds) {
    chrome.tabs
      .sendMessage(originTabId, {
        action: "superPesquisaAppliedHere",
        ok: false,
        error: "O resultado da Super Pesquisa não está mais disponível.",
      })
      .catch(() => {});
    return;
  }
  try {
    const result = await driveSuperPesquisaSearch(originTabId, ctx.targetLines, {
      filtros: ctx.filtros,
      scopedStoreIds: ctx.storeIds,
    });
    if (!result.ok) throw new Error(result.error ?? "Falha ao repetir a pesquisa nesta aba.");
    await chrome.tabs.sendMessage(originTabId, { action: "superPesquisaApplyReorgAndReport", context: "applyToOrigin" });
  } catch (err) {
    chrome.tabs.sendMessage(originTabId, { action: "superPesquisaAppliedHere", ok: false, error: err.message }).catch(() => {});
  }
}

/** The user clicked "Sim numa nova aba": brings the already-finished second tab to the front instead of redoing its search a third time -- it already holds the exact scoped, reorganização-applied result. */
function handleSuperPesquisaFocusTab(secondTabId) {
  if (secondTabId == null) return;
  chrome.tabs.update(secondTabId, { active: true }).catch(() => {});
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
  addBuyModalPriceGrouping: true, // whether the "Comprar Deck" modal shows each card's price and groups them by price band
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
  addAnaliseEconomia: true, // whether the "Análise de Economia" button (whose modal also hosts the "Super Pesquisa" button) is injected into Compra por Lista results
  addMinPriceColumn: true, // whether the "Preço Mínimo" column and its "Carregar valores mínimos" button/summary rows are added to Compra por Lista results
  addFreteCaroAlert: true, // whether an expensive store's shipping fee is highlighted on Compra por Lista results
  freteCaroLimiar: 35, // shipping fee (R$) above which a store is flagged as expensive, both by addFreteCaroAlert and inside the Análise de Economia modal
  // Cached result of the last economy analysis, keyed by a cheap fingerprint
  // of the search result it was computed from (see hashResultado in
  // analise-economia.js), so reopening the modal on an unchanged result
  // doesn't rerun the solver. { hash, relatorio } | null
  analiseEconomiaCache: null,
  addCarrinhoCopyButton: true, // whether the "Copiar Lista" button is injected into the cart's shopping list
  addComprasCopyButton: true, // whether the "Copiar" button is added to each order on the purchases screen
  addCardHoverLinks: true, // whether Scryfall/EDHREC buttons are added to the card-hover image tooltip
  addCardSearchContextMenu: true, // whether the "Pesquisar carta" right-click submenu is registered, browser-wide
  addEditionSearchButton: true, // whether the magnifying-glass badge is added next to edition icons on a card page
  addEdhrecLigaMagicButton: true, // whether a "Ver no LigaMagic" link is added to a commander page's card panel on EDHREC
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
