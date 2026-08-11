/**
 * Keeps the "Compra por Lista" page usable when its store filter is set to
 * "Minhas Favoritas" while the account has no favourited stores.
 *
 * When that filter is active the page restores the previous selection by
 * writing to the "marcar todas" favourites checkbox, which is only rendered
 * when there is at least one favourite store. With none, that write happens
 * against a missing element and the page's own start-up script stops there,
 * leaving later page code that depends on it unable to run.
 *
 * This drops the (necessarily empty) favourites list from the restore call
 * in exactly that situation, so the rest of the page start-up carries on.
 * Nothing else about the filter is touched.
 *
 * Runs in the page's MAIN world at document_start: `PassoFiltroLojas` is a
 * page global, and the wrapper has to be in place before the page's own
 * ready handler restores the step.
 */
(() => {
  const GLOBAL_NAME = "PassoFiltroLojas";
  const SELECT_ALL_FAVORITES = "#txt_lojafav_all";
  let stored;

  function wrapUpdateScreen(value) {
    if (!value || typeof value.updateScreen !== "function" || value.__lgmFavGuard) return value;

    const originalUpdateScreen = value.updateScreen;
    value.updateScreen = function (lojas) {
      const restoringWithoutFavorites =
        lojas && lojas.favoritas && !document.querySelector(SELECT_ALL_FAVORITES);
      const safeLojas = restoringWithoutFavorites ? { ...lojas, favoritas: null } : lojas;
      return originalUpdateScreen.call(this, safeLojas);
    };
    value.__lgmFavGuard = true;
    return value;
  }

  // The page declares `PassoFiltroLojas` with `var`, which assigns through an
  // accessor already installed on window rather than replacing it.
  Object.defineProperty(window, GLOBAL_NAME, {
    configurable: true,
    get: () => stored,
    set: (value) => {
      stored = wrapUpdateScreen(value);
    },
  });
})();
