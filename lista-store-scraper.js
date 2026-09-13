/**
 * Harvests every store's { id, name } off "Compra por Lista" results
 * (?view=cards/lista) into the extension's own known-store cache -- the
 * same one screenfilter.stores scraping already feeds on card listing pages
 * (see handleScrapeStoresFromPage in background.js). This page never
 * carries that global, so without this, every store a search here turns up
 * would otherwise never enrich that cache at all.
 *
 * Data source: window.CardsOrcamento.item.resultado -- the same object
 * getListaResultado already reads for the Análise de Economia feature.
 * Each block's `loja` (store ID) and `nomeLoja` (name) are core listing
 * data, present as soon as the search itself returns results -- well
 * before any store's own shipping fee finishes its separate async
 * calculation -- so, unlike analise-economia.js and frete-caro-alert.js,
 * this never needs to wait on frete.
 *
 * No settings toggle and no FEATURES.md entry, matching
 * handleScrapeStoresFromPage's own precedent: this is background
 * enrichment of internal state (the known-store cache), not a feature with
 * its own visible surface.
 *
 * Depends on: content-utils.js (sendMessage), lista-defaults.js (isListaCardsPage)
 */

let ultimoHashLojasEscaneadas = null;

/**
 * Idempotent per distinct set of {id, name} pairs -- re-running this on
 * every DOM mutation is cheap since the hash check below short-circuits
 * before ever messaging the background worker for anything unchanged.
 */
async function tentarEscanearLojasDaLista() {
  const resultado = await sendMessage({ action: "getListaResultado" });
  if (!resultado || Object.keys(resultado).length === 0) return;

  const lojas = Object.values(resultado)
    .filter(Boolean)
    .filter((bloco) => bloco.loja != null && bloco.nomeLoja)
    .map((bloco) => ({ id: String(bloco.loja), name: bloco.nomeLoja }));
  if (lojas.length === 0) return;

  const hash = lojas
    .map((l) => `${l.id}:${l.name}`)
    .sort()
    .join("|");
  if (hash === ultimoHashLojasEscaneadas) return;
  ultimoHashLojasEscaneadas = hash;

  sendMessage({ action: "scrapeStoresFromLista", stores: lojas });
}

function initListaStoreScraper() {
  if (!isListaCardsPage()) return;

  // "Pesquisar Novamente" replaces the whole results section (with a fresh
  // #btn-finalizar) rather than mutating it in place, same as the other
  // Compra por Lista content scripts rely on -- checking for it first is a
  // cheap guard against messaging the background worker on every unrelated
  // mutation this page makes.
  const tentar = () => {
    if (document.getElementById("btn-finalizar")) tentarEscanearLojasDaLista();
  };
  tentar();
  new MutationObserver(tentar).observe(document.body, { childList: true, subtree: true });
}

initListaStoreScraper();
