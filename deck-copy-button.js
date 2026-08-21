/**
 * Adds a "Copiar Deck" button to the deck page's tab bar (gated by the
 * "replaceGerarImagemWithCopiarDeck" setting) and/or removes the native
 * "Gerar Imagem" button (gated by "removeGerarImagemButton", independently —
 * either can be on without the other, so e.g. both buttons can be shown at
 * once). "Copiar Deck" copies the deck's card list to the clipboard in plain
 * MTG text format ("<qty> <name>", one per line) instead of generating a
 * commander image. Not every deck has "Gerar Imagem" to begin with (see
 * applyDeckButtonSettings' own doc comment), so adding "Copiar Deck" was
 * changed to never depend on finding one to replace.
 *
 * Mainboard + Sideboard are included; Maybeboard is skipped since those
 * cards aren't actually part of the deck (same board data — and the same
 * "not counted" rule — deck-view.js uses for the price total/tooltip).
 *
 * Depends on: content-utils.js (log, cardNameFromHref, showCopiedFeedback,
 * applySamvStyle),
 * scraper-deck.js (isDeckPage), deck-view.js (getDeckBoards)
 */

function buildDeckListText(deckId) {
  const boards = getDeckBoards(deckId).filter(
    (board) => board.label.toLowerCase() !== "maybeboard",
  );

  const lines = [];
  boards.forEach((board) => {
    board.el.querySelectorAll(":scope > .deck-line").forEach((row) => {
      const link = row.querySelector(".deck-card a");
      if (!link) return;
      const name = cardNameFromHref(link.getAttribute("href"));
      if (!name) return;
      const qty = parseInt(row.querySelector(".deck-qty")?.textContent?.trim(), 10) || 1;
      lines.push(`${qty} ${name}`);
    });
  });
  return lines.join("\n");
}

async function copyDeckList(deckId, button) {
  const text = buildDeckListText(deckId);
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    log("Copiar Deck: clipboard write failed —", err.message);
    return;
  }

  showCopiedFeedback(button);
  log(`Deck list copied to clipboard (${text.split("\n").length} card line(s)).`);
}

/**
 * Applies both independent deck-tab-bar settings: optionally removes the
 * native "Gerar Imagem" button, optionally adds our own "Copiar Deck" one —
 * neither depends on the other being on, so a user who wants both buttons
 * visible at once just leaves "remove Gerar Imagem" off. They used to be one
 * combined "replace" action; split apart because always removing "Gerar
 * Imagem" as a side effect of adding "Copiar Deck" wasn't something everyone
 * wants, and because gating "Copiar Deck" on finding "Gerar Imagem" first
 * meant it silently never appeared on a deck that doesn't render one to
 * begin with. Confirmed live: LigaMagic only shows "Gerar Imagem" for a deck
 * that has an actual format set — a deck created as "Livre (Sem formato
 * definido)" (e.g. this extension's own managed pending-prices deck) never
 * gets one, even with this extension fully disabled. Appending "Copiar
 * Deck" at the end of the tab bar puts it where "Gerar Imagem" always was
 * (the last child) either way, so a deck that does have it — and keeps it —
 * sees "Copiar Deck" land right after it, same as a plain in-place swap
 * would have.
 *
 * The new button is a brand new element rather than a clone/reuse of the
 * original "Gerar Imagem", and deliberately does NOT carry the
 * "tab-gerar-img" class. That class is what the page keys its image-modal
 * binding off: reusing it meant the page re-attached that handler to our
 * button after we'd put it in place, so clicking "Copiar Deck" copied the
 * deck *and* popped the "Imagem do Deck" modal. Neither dropping the inline
 * onclick nor cloning the node helps, since the binding happens after we're
 * done. Nothing is lost by leaving the class off: every bit of the button's
 * styling comes from "tab-comprar" (the same class the sibling "Comprar
 * Deck" button uses on its own), verified by comparing computed styles with
 * and without it.
 */
function applyDeckButtonSettings(deckId, addCopyButton, removeGerarImagem) {
  const tabBar = document.getElementById("deck-tab");
  if (!tabBar) return;

  // Idempotent either way — also covers the page re-rendering its own
  // "Gerar Imagem" back in after we already removed it once.
  if (removeGerarImagem) {
    tabBar.querySelector(".tab-comprar.tab-gerar-img")?.remove();
  }

  if (!addCopyButton) return;
  if (tabBar.querySelector("[data-copy-deck-button]")) return; // already added

  const button = document.createElement("div");
  button.className = "tab-comprar";
  button.dataset.copyDeckButton = "1";
  button.textContent = "Copiar Deck";
  applySamvStyle(button);
  button.addEventListener("click", () => copyDeckList(deckId, button));
  tabBar.appendChild(button);

  log('Added "Copiar Deck" button.');
}

function initDeckCopyButton() {
  if (typeof isDeckPage !== "function" || !isDeckPage()) return;
  const deckId = new URLSearchParams(location.search).get("id");
  if (!deckId) return;

  const tryInit = () => {
    // Both must be present before we act — applyDeckButtonSettings() only
    // runs once (inside the async settings callback below), so if #deck-tab
    // isn't ready yet, nothing would ever retry it once this returns true.
    if (!document.getElementById(`dk-val-1-${deckId}`)) return false;
    if (!document.getElementById("deck-tab")) return false;

    chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
      applyDeckButtonSettings(
        deckId,
        settings?.replaceGerarImagemWithCopiarDeck !== false,
        settings?.removeGerarImagemButton !== false,
      );
    });
    return true;
  };

  if (tryInit()) return;

  const observer = new MutationObserver(() => {
    if (tryInit()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Give up after 15 s to avoid leaking the observer.
  setTimeout(() => observer.disconnect(), 15_000);
}

initDeckCopyButton();
