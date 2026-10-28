/**
 * How old a cached LigaMagic price can be and still count as current.
 *
 * One definition shared by everything that judges a price's age: the
 * green/yellow/red colour the overlays paint (priceColor in
 * overlay-utils.js) and the "is there anything left to fetch" check behind
 * every "Carregar preços pendentes" / "Carregar valores mínimos" button. A
 * price stops being green at the same moment it starts counting as pending,
 * so the colour on screen and the button's count can never disagree.
 *
 * Loaded ahead of the files that use it in every content-script bundle that
 * needs it (see manifest.json) -- the LigaMagic bundle as well as each
 * overlay site's.
 */

const PRICE_FRESH_MAX_AGE_MS = 7 * 86_400_000; // 7 days

/** True while a price updated at `updatedAt` is still current (shown green). */
function isPriceFresh(updatedAt) {
  if (!updatedAt) return false;
  return Date.now() - new Date(updatedAt).getTime() < PRICE_FRESH_MAX_AGE_MS;
}
