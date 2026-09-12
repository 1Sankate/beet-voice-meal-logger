/**
 * Text normalisation shared by the food resolver and the unit resolver.
 *
 * Everything the agent sends us arrives as loose speech ("two Rotis", "a katori
 * of daal"), so every lookup key in this service is compared in normalised form.
 */

/** lowercase, strip accents and punctuation, collapse whitespace. */
export function normalize(input) {
  return String(input ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const IRREGULAR = new Map([
  ['rotis', 'roti'],
  ['chapatis', 'chapati'],
  ['idlis', 'idli'],
  ['dosas', 'dosa'],
  ['katoris', 'katori'],
  ['glasses', 'glass'],
  ['pieces', 'piece'],
]);

/** Naive singulariser — enough for food and unit words, no library needed. */
export function singularize(word) {
  const w = String(word ?? '');
  if (IRREGULAR.has(w)) return IRREGULAR.get(w);
  if (w.length <= 3) return w;
  if (/(ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
  if (/ies$/.test(w)) return `${w.slice(0, -3)}y`;
  if (/[^s]s$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Filler words that carry no food meaning: "a katori of dal" -> "katori dal". */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'some', 'my', 'i', 'had', 'ate', 'with', 'and',
  'plain', 'one', 'two', 'three', 'four', 'five', 'six', 'half',
]);

/** Normalised, singularised, stopword-free token list. */
export function tokens(input, { keepStopwords = false } = {}) {
  return normalize(input)
    .split(' ')
    .filter(Boolean)
    .map(singularize)
    .filter((t) => keepStopwords || !STOPWORDS.has(t));
}
