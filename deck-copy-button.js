/**
 * Replaces the deck page's "Gerar Imagem" button with "Copiar Deck" (unless
 * disabled via the "replaceGerarImagemWithCopiarDeck" setting): instead of
 * generating a commander image, it copies the deck's card list to the
 * clipboard in plain MTG text format ("<qty> <name>", one per line).
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
 * Swaps the "Gerar Imagem" button for our own "Copiar Deck" one. No-ops if
 * there's nothing to replace (some decks don't render it).
 *
 * The replacement is a brand new element rather than a clone of the
 * original, and deliberately does NOT carry the "tab-gerar-img" class. That
 * class is what the page keys its image-modal binding off: reusing it meant
 * the page re-attached that handler to our button after we'd put it in
 * place, so clicking "Copiar Deck" copied the deck *and* popped the "Imagem
 * do Deck" modal. Neither dropping the inline onclick nor cloning the node
 * helps, since the binding happens after we're done.
 *
 * Nothing is lost by leaving the class off: every bit of the button's
 * styling comes from "tab-comprar" (the same class the sibling "Comprar
 * Deck" button uses on its own), verified by comparing computed styles with
 * and without it.
 */
function replaceGerarImagemButton(deckId) {
  const tabBar = document.getElementById("deck-tab");
  const original = tabBar?.querySelector(".tab-comprar.tab-gerar-img");
  if (!original) return;

  // If the page re-rendered its own button back in next to ours, drop it
  // rather than ending up with two.
  if (tabBar.querySelector("[data-copy-deck-button]")) {
    original.remove();
    return;
  }

  const button = document.createElement("div");
  button.className = "tab-comprar";
  button.dataset.copyDeckButton = "1";
  button.textContent = "Copiar Deck";
  applySamvStyle(button);
  button.addEventListener("click", () => copyDeckList(deckId, button));
  original.replaceWith(button);

  log('Replaced "Gerar Imagem" with "Copiar Deck".');
}

function initDeckCopyButton() {
  if (typeof isDeckPage !== "function" || !isDeckPage()) return;
  const deckId = new URLSearchParams(location.search).get("id");
  if (!deckId) return;

  const tryInit = () => {
    // Both must be present before we act — replaceGerarImagemButton() only
    // runs once (inside the async settings callback below), so if #deck-tab
    // isn't ready yet, nothing would ever retry it once this returns true.
    if (!document.getElementById(`dk-val-1-${deckId}`)) return false;
    if (!document.getElementById("deck-tab")) return false;

    chrome.runtime.sendMessage({ action: "getSettings" }, (settings) => {
      if (settings?.replaceGerarImagemWithCopiarDeck !== false) {
        replaceGerarImagemButton(deckId);
      }
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
