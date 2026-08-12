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
});

// ── Core logic ───────────────────────────────────────────────────────────────
async function handleSendPrices(cards) {
  if (!Array.isArray(cards) || cards.length === 0) {
    return { error: "No cards provided." };
  }

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
    cache.prices[c.name] = {
      name: c.name,
      priceMin: c.priceMin,
      priceAvg: c.priceAvg,
      priceMax: c.priceMax,
      updatedAt,
    };
  });
  stats.totalUpdates += newCards.length;
  await saveStats(stats);
  await savePriceCache(cache);

  return {
    newCount: newCards.length,
    message: `${newCards.length} card(s) saved locally.`,
  };
}

async function handleQueryPrices(names) {
  if (!Array.isArray(names) || names.length === 0) {
    return { error: "No card names provided." };
  }

  // Purely a local lookup — only cards this browser has itself scraped on
  // LigaMagic today are present in the cache. There is no remote fallback.
  const cache = await loadPriceCache();

  // Return only the names that were requested.
  const prices = {};
  names.forEach((n) => {
    if (cache.prices[n]) prices[n] = cache.prices[n];
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

// ── Storage ────────────────────────────────────────────────────────────────────────
// Settings
const DEFAULT_SETTINGS = {
  overlayArchidekt: true,
  overlayMoxfield: true,
  overlayScryfall: true,
  openLigaMagicOnClick: true, // whether the BRL price in overlays (Archidekt/Moxfield/Scryfall) links to the card's LigaMagic page
  addScryfallTagsButton: true, // whether the "Carregar Tags" button is added to a card's prints box on Scryfall
  addScryfallFilterButton: true, // whether the default-filter button is added next to Scryfall's search field
  scryfallDefaultFilter: "", // filter terms that button appends to the search (e.g. "sort:edhrec")
  disclaimerAcknowledged: false, // whether the user has dismissed the first-open hobby/non-affiliation disclaimer in the popup
  defaultDeckView: "price", // deck page tab to auto-select on load; "" keeps LigaMagic's own default
  addPriceView: true, // whether the "Preço" deck visualization tab is injected at all
  addMeusDecksTab: true, // whether the "Meus Decks" tab is injected into the main menu
  addMeusPedidosTab: true, // whether the "Meus Pedidos" tab is injected next to it
  removeLeiloesTab: true, // whether the "Leilões" tab is removed from the main menu
  removeForumTab: true, // whether the "Fórum" tab is removed from the main menu
  replaceGerarImagemWithCopiarDeck: true, // whether "Gerar Imagem" becomes "Copiar Deck" on deck pages
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

function saveSettings(partial) {
  settingsWrites = settingsWrites.then(async () => {
    const current = await loadSettings();
    await chrome.storage.local.set({ settings: { ...current, ...partial } });
  });
  return settingsWrites;
}

// Price cache — keyed by card name. Only entries with updatedAt = today are
// kept; stale entries are pruned on every load so the cache never grows beyond
// the cards scraped today.
async function loadPriceCache() {
  const today = getTodayStr();
  const { fetchedPrices } = await chrome.storage.local.get("fetchedPrices");
  if (!fetchedPrices) return { prices: {} };
  const prices = Object.fromEntries(
    Object.entries(fetchedPrices.prices ?? {}).filter(
      ([, row]) => row.updatedAt?.slice(0, 10) === today,
    ),
  );
  return { prices };
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
