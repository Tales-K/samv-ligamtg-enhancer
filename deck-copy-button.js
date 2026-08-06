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
 * Depends on: content-utils.js (log, cardNameFromHref, showCopiedFeedback),
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
 * Rewires the existing "Gerar Imagem" button in place. No-ops if it's
 * already been replaced, or if it isn't there to begin with (some decks may
 * not render it).
 *
 * Removing the inline onclick attribute alone isn't enough: the page also
 * binds its own click handler(s) to this element via JS (opening its image
 * modal), which `removeAttribute("onclick")` doesn't touch. Cloning the node
 * drops every previously attached listener — inline and JS-bound alike —
 * leaving a clean element to attach our own handler to. stopPropagation is
 * added as a second safety net in case the page instead uses an
 * event-delegated listener on an ancestor (keyed off the shared
 * "tab-gerar-img" class, which we intentionally keep for styling).
 */
function replaceGerarImagemButton(deckId) {
  const tabBar = document.getElementById("deck-tab");
  const original = tabBar?.querySelector(".tab-comprar.tab-gerar-img");
  if (!original || original.dataset.copyDeckReplaced) return;

  const button = original.cloneNode(true);
  button.removeAttribute("onclick");
  button.textContent = "Copiar Deck";
  button.dataset.copyDeckReplaced = "1";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    copyDeckList(deckId, button);
  });
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
