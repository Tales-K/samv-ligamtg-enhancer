/**
 * Customizes the site's main navigation menu (.main-menu):
 *   - Injects a "Meus Decks" tab, linking straight to the logged-in user's
 *     own decks list, and a "Meus Pedidos" tab next to it for the
 *     marketplace order history.
 *   - Removes the "Leilões" and "Fórum" tabs.
 *
 * Each of the four is individually switchable from the popup.
 *
 * Depends on: content-utils.js (log, waitForElement, applySamvStyle)
 */

const MY_DECKS_URL = "/?view=dks/decks&myown=1";
const MY_ORDERS_URL = "/?view=mp/compras";
const LEILOES_HREF = "/?view=leilao/listar";
const FORUM_HREF = "/?view=forum/forum";

/**
 * Clones the existing "Decks" tab — the closest thing to a template the menu
 * offers — and inserts a copy pointing somewhere else, in the extension's
 * purple so it reads as ours.
 *
 * `afterHref` says which tab to sit behind, so the injected tabs keep a
 * stable order regardless of which of them are enabled. Returns true once
 * the tab is present (just injected or already there), false if the menu
 * hasn't rendered its "Decks" tab yet.
 */
function injectMenuTab(menu, { href, label, afterHref }) {
  if (menu.querySelector(`a[href="${href}"]`)) return true;

  const template = menu
    .querySelector('.menu-option a[href="/?view=dks/decks"]')
    ?.closest(".menu-option");
  if (!template) return false;

  const anchor = afterHref
    ? menu.querySelector(`.menu-option a[href="${afterHref}"]`)?.closest(".menu-option")
    : null;

  const tab = template.cloneNode(true);
  const link = tab.querySelector("a");
  link.setAttribute("href", href);
  link.textContent = label;
  applySamvStyle(tab);

  (anchor ?? template).insertAdjacentElement("afterend", tab);
  log(`Injected "${label}" tab into main menu.`);
  return true;
}

/**
 * Drops one of the site's own tabs. Returns true once it's gone (just
 * removed or never there to begin with).
 */
function removeMenuTab(menu, href, label) {
  const option = menu.querySelector(`.menu-option a[href="${href}"]`)?.closest(".menu-option");
  if (option) {
    option.remove();
    log(`Removed "${label}" tab from main menu.`);
  }
  return true;
}

function applyMenuCustomizations(settings) {
  const menu = document.querySelector(".main-menu");
  if (!menu) return false;

  const steps = [
    settings.addMeusDecksTab === false ||
      injectMenuTab(menu, { href: MY_DECKS_URL, label: "Meus Decks" }),
    settings.addMeusPedidosTab === false ||
      injectMenuTab(menu, { href: MY_ORDERS_URL, label: "Meus Pedidos", afterHref: MY_DECKS_URL }),
    settings.removeLeiloesTab === false || removeMenuTab(menu, LEILOES_HREF, "Leilões"),
    settings.removeForumTab === false || removeMenuTab(menu, FORUM_HREF, "Fórum"),
  ];
  return steps.every(Boolean);
}

function initMenuCustomizations() {
  chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
    waitForElement(() => applyMenuCustomizations(settings ?? {}));
  });
}

initMenuCustomizations();
