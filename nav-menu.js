/**
 * Customizes the site's main navigation menu (.main-menu):
 *   - Injects a "Meus Decks" tab, linking straight to the logged-in user's
 *     own decks list (unless disabled via the "addMeusDecksTab" setting).
 *   - Removes the "Leilões" tab (unless disabled via the "removeLeiloesTab"
 *     setting).
 *
 * Depends on: content-utils.js (log, waitForElement, applySamvStyle)
 */

const MY_DECKS_URL = "/?view=dks/decks&myown=1";
const LEILOES_HREF = "/?view=leilao/listar";

/**
 * Clones the existing "Decks" tab and inserts a "Meus Decks" tab right
 * after it. Returns true once the tab is present (either just injected or
 * already there), false if the menu hasn't rendered yet.
 */
function injectMyDecksTab(menu) {
  if (menu.querySelector('a[href*="myown=1"]')) return true;

  const decksOption = menu
    .querySelector('.menu-option a[href="/?view=dks/decks"]')
    ?.closest(".menu-option");
  if (!decksOption) return false;

  const tab = decksOption.cloneNode(true);
  const link = tab.querySelector("a");
  link.setAttribute("href", MY_DECKS_URL);
  link.textContent = "Meus Decks";
  applySamvStyle(tab);

  decksOption.insertAdjacentElement("afterend", tab);
  log('Injected "Meus Decks" tab into main menu.');
  return true;
}

/**
 * Removes the "Leilões" tab from the menu. Returns true once it's gone
 * (either just removed or already absent), false if the menu hasn't
 * rendered yet.
 */
function removeLeiloesTab(menu) {
  const leiloesOption = menu
    .querySelector(`.menu-option a[href="${LEILOES_HREF}"]`)
    ?.closest(".menu-option");
  if (leiloesOption) {
    leiloesOption.remove();
    log('Removed "Leilões" tab from main menu.');
  }
  return true;
}

function applyMenuCustomizations(settings) {
  const menu = document.querySelector(".main-menu");
  if (!menu) return false;

  const decksDone = settings.addMeusDecksTab === false ? true : injectMyDecksTab(menu);
  const leiloesDone = settings.removeLeiloesTab === false ? true : removeLeiloesTab(menu);
  return decksDone && leiloesDone;
}

function initMenuCustomizations() {
  chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
    waitForElement(() => applyMenuCustomizations(settings ?? {}));
  });
}

initMenuCustomizations();
