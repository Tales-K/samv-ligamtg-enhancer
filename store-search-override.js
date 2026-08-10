/**
 * Injects a compact "add a store by URL" bar right above the native "Lojas
 * Favoritas" checkbox list on the "Compra por Lista" page
 * (?view=cards/lista), plus a growing checklist of every custom store added
 * so far. Search stays scoped to exactly the checked stores — the account's
 * real favorited stores are never touched.
 *
 * How: resolves the pasted URL to a LigaMagic store ID (background.js —
 * cached forever per domain after the first resolve, which may need a real,
 * user-visible browser tab to get past the store's own bot-check), then adds
 * it to the checklist. Adding/checking/removing a store never fires a search
 * by itself — it only updates the working set that background.js's
 * `CardsOrcamento.pesquisar()` wrapper picks up. The real search still only
 * happens when the user clicks the site's own "Pesquisar" button, exactly
 * like before this feature existed.
 *
 * Styling reuses the site's own classes where possible (`.botao` for the
 * button, matching the "Procurar" button in Busca Detalhada) instead of
 * hand-rolled colors, so it doesn't drift from the site's own look.
 *
 * Depends on: content-utils.js (log, waitForElement, sendMessage, getSettings,
 * applySamvStyle, SAMV_PURPLE),
 * lista-defaults.js (isListaCardsPage)
 */

function saveCustomStoreSelection(list) {
  return sendMessage({ action: "saveSettings", settings: { customStoreSelection: list } });
}

// Matches the site's own "Quantidade Máxima de Lojas" <select class="select">
// border/radius/font so our custom dropdown reads as the same kind of control.
const INPUT_BORDER_STYLE = "border: 1px solid #999; border-radius: 1px; font-size: 12px;";

// Compact, content-sized input so the button sits right next to it instead
// of stretching across the whole column (which pushed the button far from
// where the user is actually typing).
const STORE_INPUT_WIDTH = "230px";

function buildBar() {
  const wrap = document.createElement("div");
  wrap.id = "lgm-custom-store-bar-wrap";
  wrap.style.marginBottom = "10px";
  wrap.innerHTML = `
    <div id="lgm-custom-store-bar" style="display: inline-flex; gap: 4px; align-items: center;">
      <div style="position: relative; width: ${STORE_INPUT_WIDTH};">
        <input type="text" id="lgm-custom-store-input" autocomplete="off"
          placeholder="nome ou link"
          style="width: 100%; box-sizing: border-box; padding: 6px 2px; font-family: inherit; ${INPUT_BORDER_STYLE}">
        <div id="lgm-known-stores-dropdown"
          style="display: none; position: absolute; top: 100%; left: 0; right: 0; z-index: 50;
            background: #fff; border-top: none; max-height: 180px; overflow-y: auto; ${INPUT_BORDER_STYLE}"></div>
      </div>
      <div class="botao" id="lgm-custom-store-add-btn" style="cursor: pointer; white-space: nowrap;">Pesquisar</div>
    </div>
    <div id="lgm-custom-store-status" style="font-size: 11px; margin-top: 4px;"></div>
    <div id="lgm-custom-store-checklist" style="margin-top: 6px; display: flex; flex-direction: column; gap: 2px;"></div>
    <hr style="margin: 10px 0; border: none; border-top: 1px solid #ddd;">
  `;
  return wrap;
}

let knownStores = []; // [{ id, name, domain: string|null }], sorted alphabetically by name

/**
 * Most stores are discovered by ID+name only (see background.js), and their
 * domain is filled in later, if ever. A store without one shows just its
 * name — saying so out loud is noise the user can't act on.
 */
function domainSuffix(domain) {
  return domain ? ` <span style="opacity: 0.6;">(${domain})</span>` : "";
}

// All known stores go in the dropdown, not just the ones with a resolved
// domain — the ID (from screenfilter.stores scraping, see background.js) is
// all that's actually needed to add a store to the search, and picking one
// from here adds it directly (see handleKnownStorePick), skipping the
// URL/domain resolve pipeline entirely.
async function loadKnownStores() {
  const cache = await sendMessage({ action: "getStoreCache" });
  knownStores = Object.values(cache ?? {})
    .map(({ id, name, domain }) => ({ id, name, domain }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

function renderKnownStoresDropdown(filterText = "") {
  const dropdown = document.getElementById("lgm-known-stores-dropdown");
  const needle = filterText.trim().toLowerCase();
  const matches = needle
    ? knownStores.filter(
        (s) => s.name.toLowerCase().includes(needle) || s.domain?.toLowerCase().includes(needle),
      )
    : knownStores;

  if (matches.length === 0) {
    dropdown.style.display = "none";
    return;
  }

  dropdown.innerHTML = matches
    .map(
      (s) => `
      <div class="lgm-known-store-option" data-id="${s.id}" data-name="${s.name}" data-domain="${s.domain ?? ""}"
        style="padding: 4px 6px; font-size: 12px; cursor: pointer;">
        ${s.name}${domainSuffix(s.domain)}
      </div>`,
    )
    .join("");
  dropdown.style.display = "block";
}

function hideKnownStoresDropdown() {
  document.getElementById("lgm-known-stores-dropdown").style.display = "none";
}

function renderChecklist(list) {
  const container = document.getElementById("lgm-custom-store-checklist");
  if (!container) return;
  container.innerHTML = "";
  list.forEach((entry) => {
    const row = document.createElement("label");
    row.style.cssText = "display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer;";
    row.innerHTML = `
      <input type="checkbox" data-id="${entry.id}" ${entry.checked ? "checked" : ""}>
      <span>${entry.name}${domainSuffix(entry.domain)}</span>
      <button type="button" data-remove-id="${entry.id}" title="Remover"
        style="border: none; background: none; cursor: pointer; color: inherit; opacity: 0.6;">×</button>
    `;
    container.appendChild(row);
  });
}

/** Only updates the working set the native Pesquisar button will pick up — never fires a search. */
function syncCustomStoreIds(list) {
  const checkedIds = list.filter((e) => e.checked).map((e) => e.id);
  return sendMessage({ action: "syncCustomStoreIds", storeIds: checkedIds });
}

/**
 * Every checklist mutation (add, remove, toggle) is the same shape: load the
 * current list, let `mutateFn` change it, save + re-render + sync. `mutateFn`
 * gets the current list and returns the list to persist (mutated in place or
 * a new array, either works).
 */
async function updateCustomStoreSelection(mutateFn) {
  const settings = await getSettings();
  const list = mutateFn(settings?.customStoreSelection ?? []);
  await saveCustomStoreSelection(list);
  renderChecklist(list);
  await syncCustomStoreIds(list);
  return list;
}

/** Adds (or re-checks, if already present) one store in the checklist — shared by both the URL-resolve and known-store-pick paths. */
async function addStoreToChecklist({ id, name, domain }) {
  const entry = { id, name, domain: domain ?? null, checked: true };
  await updateCustomStoreSelection((list) => {
    const existingIndex = list.findIndex((e) => e.id === id);
    if (existingIndex >= 0) list[existingIndex] = entry;
    else list.push(entry);
    return list;
  });
  log(`Custom store added: ${entry.name}${entry.domain ? ` (${entry.domain})` : ""}.`);
}

/** Picking a known store from the dropdown needs no network at all — the ID (and domain, if resolved) is already cached. */
async function handleKnownStorePick(option) {
  const input = document.getElementById("lgm-custom-store-input");
  hideKnownStoresDropdown();
  input.value = "";
  await addStoreToChecklist({
    id: option.dataset.id,
    name: option.dataset.name,
    domain: option.dataset.domain || null,
  });
}

/**
 * True for anything shaped like a domain — "sualoja.com.br", with the
 * scheme, "www." and any path all optional. The field takes store names too,
 * and those are picked from the dropdown; only something that could actually
 * be a store's address is worth sending off to be resolved, which costs a
 * permission prompt and possibly a visible tab.
 */
function looksLikeUrl(text) {
  return /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(text);
}

/** Progress messages read as normal text; anything that went wrong shows in red. */
function setStatus(statusEl, text, { isError = false } = {}) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#c0392b" : "";
}

async function handleAddClick() {
  const input = document.getElementById("lgm-custom-store-input");
  const statusEl = document.getElementById("lgm-custom-store-status");
  const url = input.value.trim();
  if (!url) return;

  hideKnownStoresDropdown();

  if (!looksLikeUrl(url)) {
    setStatus(statusEl, "Escolha uma loja da lista ou digite o link dela (ex.: sualoja.com.br).", { isError: true });
    return;
  }

  // requestStorePermissions must be the very first await here — no prior
  // lookups — the permission prompt only works during a real user gesture
  // and even a couple of milliseconds of unrelated awaits before it is
  // enough to lose that activation (confirmed live, see background.js).
  setStatus(statusEl, "Pedindo permissão…");
  const permissionResult = await sendMessage({ action: "requestStorePermissions", urls: [url] });
  if (!permissionResult?.granted) {
    const reason = permissionResult?.error ? ` (${permissionResult.error})` : "";
    setStatus(statusEl, `Permissão negada${reason}`, { isError: true });
    return;
  }

  setStatus(statusEl, "Resolvendo loja…");
  const resolved = await sendMessage({ action: "resolveStoreUrl", url });
  if (!resolved?.id) {
    setStatus(statusEl, `Erro: ${resolved?.error ?? "desconhecido"}`, { isError: true });
    return;
  }

  await addStoreToChecklist(resolved);
  await loadKnownStores();
  input.value = "";
  setStatus(statusEl, "");
}

async function handleChecklistClick(event) {
  const removeId = event.target.dataset.removeId;
  if (!removeId) return;
  await updateCustomStoreSelection((list) => list.filter((e) => e.id !== removeId));
}

async function handleChecklistChange(event) {
  const id = event.target.dataset.id;
  if (id == null) return;
  await updateCustomStoreSelection((list) => {
    const entry = list.find((e) => e.id === id);
    if (entry) entry.checked = event.target.checked;
    return list;
  });
}

function wireKnownStoresDropdown(input) {
  input.addEventListener("focus", () => renderKnownStoresDropdown(input.value));
  input.addEventListener("input", () => renderKnownStoresDropdown(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleAddClick();
    else if (e.key === "Escape") hideKnownStoresDropdown();
  });

  const dropdown = document.getElementById("lgm-known-stores-dropdown");
  // mousedown (not click) + preventDefault so this fires before the input's
  // own blur hides the dropdown — otherwise blur wins the race and the
  // click never lands.
  dropdown.addEventListener("mousedown", (e) => {
    const option = e.target.closest(".lgm-known-store-option");
    if (!option) return;
    e.preventDefault();
    handleKnownStorePick(option);
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#lgm-custom-store-bar-wrap")) hideKnownStoresDropdown();
  });
}

/**
 * "Minhas Favoritas" is the option our search bar hangs off, so its label
 * says what it now also does — the site's own wording, plus our part in the
 * extension's purple so it reads as an addition rather than native text.
 */
function labelFavoritesRadio() {
  const title = [...document.querySelectorAll(".radio-card-title")].find(
    (el) => el.textContent.trim() === "Minhas Favoritas",
  );
  if (!title) return;

  const suffix = document.createElement("span");
  suffix.textContent = " + Buscar Lojas";
  suffix.style.setProperty("color", SAMV_PURPLE, "important");
  title.appendChild(suffix);
}

function injectCustomStoreBar() {
  if (document.getElementById("lgm-custom-store-bar-wrap")) return true;

  const favoritesBlock = document.getElementById("mp_store_favorites");
  if (!favoritesBlock) return false;

  labelFavoritesRadio();

  const bar = buildBar();
  favoritesBlock.insertAdjacentElement("afterbegin", bar);

  const addBtn = document.getElementById("lgm-custom-store-add-btn");
  applySamvStyle(addBtn);
  addBtn.addEventListener("click", handleAddClick);
  wireKnownStoresDropdown(document.getElementById("lgm-custom-store-input"));

  const checklist = document.getElementById("lgm-custom-store-checklist");
  checklist.addEventListener("click", handleChecklistClick);
  checklist.addEventListener("change", handleChecklistChange);

  loadKnownStores();
  sendMessage({ action: "installSearchOverride" });
  getSettings().then((settings) => {
    const list = settings?.customStoreSelection ?? [];
    renderChecklist(list);
    syncCustomStoreIds(list); // page just (re)loaded — the MAIN-world global starts empty
  });

  log("Injected custom store search bar above Lojas Favoritas.");
  return true;
}

function initCustomStoreSearch() {
  if (typeof isListaCardsPage !== "function" || !isListaCardsPage()) return;

  chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
    if (settings?.enableCustomStoreSearch === false) return;
    waitForElement(injectCustomStoreBar);
  });
}

initCustomStoreSearch();
