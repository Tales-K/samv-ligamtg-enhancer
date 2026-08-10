/**
 * Applies filter values to the "Compra por Lista" page (?view=cards/lista)
 * — but only for the simple search step (div.passo-lista-cards.busca-simples),
 * never for "Busca Detalhada" — according to the "listaCards.mode" setting:
 *
 *   "off"      — do nothing.
 *   "defaults" — apply the fixed values configured in the popup.
 *   "remember" — reapply whatever was last manually selected on this page,
 *                and keep capturing future manual changes for next time.
 *
 * All target fields (Idiomas, Extras, Qualidade, and the two bottom
 * checkboxes) are expected inside that container; a document-wide fallback
 * is used only if a field isn't found there, in case some of them turn out
 * to be siblings rather than nested inside it.
 *
 * In "defaults"/initial "remember" mode, values are applied at most once per
 * page load — the user's own edits afterward are never touched or reverted.
 *
 * Depends on: content-utils.js (log, waitForElement, applySamvStyle,
 * showCopiedFeedback)
 */

function isListaCardsPage() {
  const params = new URLSearchParams(location.search);
  return params.get("view") === "cards/lista";
}

function findField(container, selector) {
  return container.querySelector(selector) ?? document.querySelector(selector);
}

/**
 * Forces a checkbox to the desired state and notifies listeners. Unlike
 * el.click(), this can't be short-circuited by other click handlers on the
 * page — it always lands on the exact state we want, in both directions.
 */
function setChecked(el, desired) {
  if (!el || desired == null || el.checked === desired) return;
  el.checked = desired;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Selects a radio via a real click (needed so the page's own onclick
 * handler fires — that's what reveals the Idiomas/Extras checkbox lists,
 * and what runs the page's own "clean the other mode's checkboxes" logic).
 */
function setSelected(el) {
  if (!el || el.checked) return;
  el.click();
}

function setSelectValue(el, value) {
  if (!el || !value || el.value === value) return;
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Selects the given mode radio, then sets the checkbox list to match
 * `wantedValues`. The checkbox step is deferred to the next tick whenever a
 * click actually happened, so any page-side reveal/reset logic triggered by
 * that click gets a chance to settle first instead of racing with it —
 * otherwise (e.g. coming from "Sem extras") the page can wipe our checkbox
 * state out right after we set it.
 */
function applyRadioAndChecks(container, radioEl, checkboxSelector, wantedValues) {
  const wasAlreadySelected = !radioEl || radioEl.checked;
  setSelected(radioEl);

  const applyChecks = () => {
    const wanted = new Set(wantedValues ?? []);
    container.querySelectorAll(checkboxSelector).forEach((cb) => {
      setChecked(cb, wanted.has(cb.value));
    });
  };

  if (wasAlreadySelected) applyChecks();
  else setTimeout(applyChecks, 0);
}

function applyListaCardsValues(container, cfg) {
  // Idiomas
  if (cfg.idiomaMode === "todos") {
    setSelected(findField(container, "#carac-idioma1"));
  } else if (cfg.idiomaMode === "escolher") {
    applyRadioAndChecks(
      container,
      findField(container, "#carac-idioma2"),
      'input[name="txt_idioma[]"]',
      cfg.idiomas,
    );
  }

  // Extras
  if (cfg.extrasMode === "pode") {
    setSelected(findField(container, 'input[name="addExtra"][value="1"]'));
  } else if (cfg.extrasMode === "sem") {
    setSelected(findField(container, 'input[name="addExtra"][value="2"]'));
  } else if (cfg.extrasMode === "definir") {
    applyRadioAndChecks(
      container,
      findField(container, 'input[name="addExtra"][value="3"]'),
      'input[name="txt_extras[]"]',
      cfg.extras,
    );
  }

  // Qualidade
  setSelectValue(findField(container, "#txt_qualidade"), cfg.qualidade);

  // Bottom checkboxes
  setChecked(
    findField(container, 'input[name="ignorar-cards-sem-estoque"]'),
    cfg.ignorarSemEstoque,
  );
  setChecked(
    findField(container, 'input[name="ignorar-cards-pre-order"]'),
    cfg.ignorarPreOrder,
  );
}

// ── "Remember last used" mode ─────────────────────────────────────────────
function captureCurrentState(container) {
  const idiomaMode = findField(container, "#carac-idioma1")?.checked
    ? "todos"
    : findField(container, "#carac-idioma2")?.checked
      ? "escolher"
      : "";
  const idiomas = [...container.querySelectorAll('input[name="txt_idioma[]"]:checked')].map(
    (el) => el.value,
  );

  const extraValue = container.querySelector('input[name="addExtra"]:checked')?.value;
  const extrasMode = { 1: "pode", 2: "sem", 3: "definir" }[extraValue] ?? "";
  const extras = [...container.querySelectorAll('input[name="txt_extras[]"]:checked')].map(
    (el) => el.value,
  );

  const qualidade = findField(container, "#txt_qualidade")?.value ?? "";
  const ignorarSemEstoque =
    findField(container, 'input[name="ignorar-cards-sem-estoque"]')?.checked ?? null;
  const ignorarPreOrder =
    findField(container, 'input[name="ignorar-cards-pre-order"]')?.checked ?? null;

  return { idiomaMode, idiomas, extrasMode, extras, qualidade, ignorarSemEstoque, ignorarPreOrder };
}

function watchAndRememberSelections(container) {
  let saveTimer = null;
  container.addEventListener("change", () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      // listaCards is a nested object — round-trip through the current
      // settings so we only overwrite `lastUsed`, not the sibling fields.
      chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
        const listaCards = { ...(settings?.listaCards ?? {}), lastUsed: captureCurrentState(container) };
        chrome.runtime.sendMessage({ action: "saveSettings", settings: { listaCards } });
      });
    }, 300);
  });
}

/**
 * Adds a "Carregar filtro padrão" button directly above the site's own
 * "Mudar para Busca Detalhada" link, applying the values configured in the
 * popup on demand. Useful whenever the filters aren't applied automatically
 * (mode "off"/"remember") or the user has since changed them by hand and
 * wants to get back to their own defaults.
 *
 * That link is `position: absolute; top: 0; right: 0` inside the step's
 * content box, so it is out of the normal flow entirely — a button inserted
 * before it in the markup lands under the filters block instead, next to
 * "Adicione a lista de cards". Both are therefore stacked inside one
 * absolutely positioned corner box that takes over the link's spot, letting
 * ordinary flow put ours on top without hardcoding any offsets.
 */
function injectLoadDefaultsButton(container) {
  if (container.querySelector("#lgm-load-defaults-btn")) return;

  const detailedLink = container.querySelector(".change-input-type-btn");
  if (!detailedLink) return;

  const button = document.createElement("div");
  button.id = "lgm-load-defaults-btn";
  button.className = "botao";
  button.textContent = "Carregar filtro padrão";
  button.title = "Aplicar os filtros configurados nas opções da extensão";
  button.style.cssText = "cursor: pointer; white-space: nowrap;";
  applySamvStyle(button);

  button.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
      const cfg = settings?.listaCards;
      if (!cfg) return;
      applyListaCardsValues(container, cfg);
      showCopiedFeedback(button, "Filtro aplicado!");
      log("Applied Compra por Lista default filters on demand.");
    });
  });

  const corner = document.createElement("div");
  corner.id = "lgm-lista-corner";
  corner.style.cssText =
    "position: absolute; top: 0; right: 0; display: flex; flex-direction: column; align-items: flex-end; gap: 4px;";

  detailedLink.replaceWith(corner);
  corner.append(button, detailedLink);
  // Now that it lives inside the corner box, the link stacks below our
  // button in normal flow instead of pinning itself to the same corner.
  detailedLink.style.setProperty("position", "static");
}

let listaCardsApplied = false;

function tryApplyListaCardsDefaults() {
  if (listaCardsApplied) return true;

  const container = document.querySelector(
    "div.passo-lista-cards.busca-simples.passo-atual",
  );
  if (!container || !container.querySelector('input[name="carac-idioma"]')) return false;

  // Mark as applied immediately — this must run at most once per page load,
  // regardless of what the fetched settings turn out to be.
  listaCardsApplied = true;
  injectLoadDefaultsButton(container);

  chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
    const cfg = settings?.listaCards;
    if (!cfg || cfg.mode === "off") return;

    if (cfg.mode === "defaults") {
      applyListaCardsValues(container, cfg);
      log("Applied Compra por Lista default filters.");
    } else if (cfg.mode === "remember") {
      if (cfg.lastUsed) {
        applyListaCardsValues(container, cfg.lastUsed);
        log("Applied last-used Compra por Lista filters.");
      }
      watchAndRememberSelections(container);
    }
  });

  return true;
}

function initListaCardsDefaults() {
  if (!isListaCardsPage()) return;
  waitForElement(tryApplyListaCardsDefaults);
}

initListaCardsDefaults();
