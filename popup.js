const IS_LOCAL = false; // set to false in production builds

// ── DOM ──────────────────────────────────────────────────────────────────────
const todayCountEl = document.getElementById("todayCount");
const totalCountEl = document.getElementById("totalCount");
const todayListEl = document.getElementById("todayList");
const knownStoresListEl = document.getElementById("knownStoresList");

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtPrice(value) {
  return value != null ? `R$ ${value.toFixed(2).replace(".", ",")}` : "—";
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Render ────────────────────────────────────────────────────────────────────
/**
 * Shared shape for every list in this popup: empty-state message, or one row
 * per entry via `rowHtml(entry)` (returns a full `<div class="...">...</div>`
 * string, wrapper class included).
 */
function renderList(container, entries, { emptyMessage, rowHtml }) {
  if (entries.length === 0) {
    container.innerHTML = `<div class="empty-msg">${emptyMessage}</div>`;
    return;
  }
  container.innerHTML = entries.map(rowHtml).join("");
}

function renderTodayList(todayCards) {
  const entries = Object.entries(todayCards).sort((a, b) => b[1].sentAt - a[1].sentAt);
  todayCountEl.textContent = entries.length;
  renderList(todayListEl, entries, {
    emptyMessage: "Nenhum card enviado hoje.",
    rowHtml: ([name, info]) => `
      <div class="card-item">
        <span class="card-name" title="${name}">${name}</span>
        <div class="card-meta">
          <span class="card-price">${fmtPrice(info.priceMin)}</span>
          <span class="card-time">${fmtTime(info.sentAt)}</span>
        </div>
      </div>
    `,
  });
}

async function refreshStats() {
  const { sentToday: stats } = await chrome.storage.local.get("sentToday");
  totalCountEl.textContent = stats ? stats.totalUpdates.toLocaleString() : "0";
  renderTodayList(stats?.todayCards ?? {});
}

// Stores known either from adding a custom store on the "Compra por Lista"
// page or from scraping card listing pages (store-search-override.js /
// handleScrapeStoresFromPage in background.js) — listed here so they can be
// reviewed/removed without needing to re-visit those pages. `domain` is null
// for scraped stores whose domain hasn't been resolved in the background yet.
function renderKnownStores(cache) {
  const entries = Object.values(cache).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  renderList(knownStoresListEl, entries, {
    emptyMessage: "Nenhuma loja mapeada ainda.",
    // Most stores are known by id+name only; their domain fills in later, if
    // ever. Those simply show no domain rather than announcing its absence.
    rowHtml: (entry) => `
        <div class="store-item">
          <span class="store-name" title="${entry.name}">${entry.name}</span>
          <span class="store-meta">
            ${entry.domain ? `<span class="store-domain" title="${entry.domain}">${entry.domain}</span>` : ""}
            <button class="store-remove" data-id="${entry.id}" title="Remover">×</button>
          </span>
        </div>
      `,
  });
}

async function refreshKnownStores() {
  const { storeIdCache } = await chrome.storage.local.get("storeIdCache");
  renderKnownStores(storeIdCache ?? {});
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  refreshStats();
  refreshKnownStores();

  const versionEl = document.getElementById("appVersion");
  if (versionEl) versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

  if (IS_LOCAL) {
    const clearStorageBtn = document.getElementById("clearStorageBtn");
    clearStorageBtn.style.display = "inline-block";
    clearStorageBtn.addEventListener("click", async () => {
      await chrome.storage.local.remove(["sentToday", "fetchedPrices"]);
      await refreshStats();
    });
  }

  knownStoresListEl.addEventListener("click", async (e) => {
    const id = e.target.dataset.id;
    if (!id) return;
    await new Promise((resolve) =>
      chrome.runtime.sendMessage({ action: "removeStoreCacheEntry", id }, resolve),
    );
    await refreshKnownStores();
  });

  document.getElementById("clearStoreCacheBtn").addEventListener("click", async () => {
    await new Promise((resolve) => chrome.runtime.sendMessage({ action: "clearStoreCache" }, resolve));
    await refreshKnownStores();
  });

  // ── Settings ────────────────────────────────────────────────────────────────
  const checkboxIds = [
    "overlayArchidekt",
    "overlayMoxfield",
    "overlayScryfall",
    "openLigaMagicOnClick",
    "addPriceView",
    "addMeusDecksTab",
    "addMeusPedidosTab",
    "removeLeiloesTab",
    "removeForumTab",
    "replaceGerarImagemWithCopiarDeck",
    "rememberListaFilters",
    "addLoadDefaultsButton",
    "enableCustomStoreSearch",
    "addCopyListaButton",
    "addCarrinhoCopyButton",
  ];
  const selectIds = ["defaultDeckView"];

  // Load saved settings and populate checkboxes / selects.
  chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
    checkboxIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.checked = settings[id] ?? false;
    });
    selectIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = settings[id] ?? "";
    });
    syncFiltersCardVisibility();
  });

  // Persist any checkbox change immediately.
  checkboxIds.forEach((id) => {
    document.getElementById(id)?.addEventListener("change", (e) => {
      chrome.runtime.sendMessage({
        action: "saveSettings",
        settings: { [id]: e.target.checked },
      });
    });
  });

  // The filter fields only mean anything while the button that applies them
  // is around, so the whole card follows that toggle.
  document
    .getElementById("addLoadDefaultsButton")
    .addEventListener("change", syncFiltersCardVisibility);

  // Persist any select change immediately.
  selectIds.forEach((id) => {
    document.getElementById(id)?.addEventListener("change", (e) => {
      chrome.runtime.sendMessage({
        action: "saveSettings",
        settings: { [id]: e.target.value },
      });
    });
  });

  initListaCardsSettings();
  initDisclaimer();
});

function syncFiltersCardVisibility() {
  const enabled = document.getElementById("addLoadDefaultsButton").checked;
  document.getElementById("lcFiltersCard").style.display = enabled ? "" : "none";
}

// ── First-open disclaimer ───────────────────────────────────────────────────
function initDisclaimer() {
  const modal = document.getElementById("disclaimerModal");
  const ackBtn = document.getElementById("disclaimerAckBtn");
  const feedback = document.getElementById("quizFeedback");

  chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
    if (!settings?.disclaimerAcknowledged) modal.style.display = "flex";
  });

  document.querySelectorAll(".quiz-opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.value === "1") {
        feedback.textContent = "Isso aí, o Anel Solar custa 1 mana genérica. Pode entrar.";
        feedback.className = "quiz-feedback is-right";
        document.getElementById("quizOptions").style.display = "none";
        ackBtn.style.display = "block";
      } else {
        feedback.textContent = "Quase — o Anel Solar custa só 1 mana genérica. Dá uma conferida ali em cima.";
        feedback.className = "quiz-feedback is-wrong";
      }
    });
  });

  ackBtn.addEventListener("click", () => {
    modal.style.display = "none";
    chrome.runtime.sendMessage({
      action: "saveSettings",
      settings: { disclaimerAcknowledged: true },
    });
  });
}

// ── "Compra por Lista" defaults ─────────────────────────────────────────────
/**
 * Mirrors the page's own radio mutual-exclusivity: picking a custom
 * language/extras list always forces the mode to "escolher"/"definir";
 * switching the mode away from that clears the corresponding checkboxes.
 */
function initListaCardsSettings() {
  const idiomaModeEl = document.getElementById("lcIdiomaMode");
  const idiomasListEl = document.getElementById("lcIdiomasList");
  const extrasModeEl = document.getElementById("lcExtrasMode");
  const extrasListEl = document.getElementById("lcExtrasList");
  const qualidadeEl = document.getElementById("lcQualidade");
  const ignorarSemEstoqueEl = document.getElementById("lcIgnorarSemEstoque");
  const ignorarPreOrderEl = document.getElementById("lcIgnorarPreOrder");
  const idiomaChecks = [...document.querySelectorAll(".lc-idioma-chk")];
  const extraChecks = [...document.querySelectorAll(".lc-extra-chk")];

  // "lastUsed" is captured live on the LigaMagic page itself (not editable
  // here) — keep whatever was last loaded so saving this form never wipes it.
  let lastUsed = {};

  function updateIdiomaVisibility() {
    idiomasListEl.style.display = idiomaModeEl.value === "escolher" ? "" : "none";
  }

  function updateExtrasVisibility() {
    extrasListEl.style.display = extrasModeEl.value === "definir" ? "" : "none";
  }

  function collectConfig() {
    return {
      idiomaMode: idiomaModeEl.value,
      idiomas: idiomaChecks.filter((el) => el.checked).map((el) => el.dataset.value),
      extrasMode: extrasModeEl.value,
      extras: extraChecks.filter((el) => el.checked).map((el) => el.dataset.value),
      qualidade: qualidadeEl.value,
      ignorarSemEstoque: ignorarSemEstoqueEl.checked,
      ignorarPreOrder: ignorarPreOrderEl.checked,
      lastUsed,
    };
  }

  function saveConfig() {
    chrome.runtime.sendMessage({
      action: "saveSettings",
      settings: { listaCards: collectConfig() },
    });
  }

  // Load saved settings and populate the whole section.
  chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
    const lc = settings?.listaCards ?? {};
    lastUsed = lc.lastUsed ?? {};
    idiomaModeEl.value = lc.idiomaMode ?? "";
    extrasModeEl.value = lc.extrasMode ?? "";
    qualidadeEl.value = lc.qualidade ?? "";
    ignorarSemEstoqueEl.checked = lc.ignorarSemEstoque ?? true;
    ignorarPreOrderEl.checked = lc.ignorarPreOrder ?? true;

    const wantedIdiomas = new Set(lc.idiomas ?? []);
    idiomaChecks.forEach((el) => (el.checked = wantedIdiomas.has(el.dataset.value)));
    const wantedExtras = new Set(lc.extras ?? []);
    extraChecks.forEach((el) => (el.checked = wantedExtras.has(el.dataset.value)));

    updateIdiomaVisibility();
    updateExtrasVisibility();
  });

  qualidadeEl.addEventListener("change", saveConfig);
  ignorarSemEstoqueEl.addEventListener("change", saveConfig);
  ignorarPreOrderEl.addEventListener("change", saveConfig);

  idiomaModeEl.addEventListener("change", () => {
    if (idiomaModeEl.value !== "escolher") {
      idiomaChecks.forEach((el) => (el.checked = false));
    }
    updateIdiomaVisibility();
    saveConfig();
  });

  idiomaChecks.forEach((el) => {
    el.addEventListener("change", () => {
      if (el.checked && idiomaModeEl.value !== "escolher") {
        idiomaModeEl.value = "escolher";
        updateIdiomaVisibility();
      }
      saveConfig();
    });
  });

  extrasModeEl.addEventListener("change", () => {
    if (extrasModeEl.value !== "definir") {
      extraChecks.forEach((el) => (el.checked = false));
    }
    updateExtrasVisibility();
    saveConfig();
  });

  extraChecks.forEach((el) => {
    el.addEventListener("change", () => {
      if (el.checked && extrasModeEl.value !== "definir") {
        extrasModeEl.value = "definir";
        updateExtrasVisibility();
      }
      saveConfig();
    });
  });
}
