/**
 * Deterministic fuzzy product search — typo tolerance + a small synonym
 * dictionary for common Ghanaian food names. No LLM: this only ever narrows
 * down to products that already exist in the shop's own catalog, so it can't
 * hallucinate a product or pull the bot out of business context.
 */

// A modest, extensible starting set. Add to these arrays as merchants report
// customers using terms the search doesn't catch yet.
const SYNONYMS = {
  jollof: ['jalof', 'jollof rice', 'jolof'],
  waakye: ['waachy', 'waakey', 'wakye', 'waatchy'],
  kelewele: ['kelly welly', 'kelewele', 'kelawele'],
  banku: ['bankuu', 'bunku'],
  fufu: ['foofoo', 'fufuo'],
  'red red': ['redred', 'beans and plantain'],
  kenkey: ['kenkay', 'dokono'],
  gari: ['garri'],
  chicken: ['chiken', 'chikin'],
  fish: ['fis'],
  soda: ['coke', 'cola', 'soft drink', 'minerals'],
  drink: ['beverage', 'refreshment']
};

// Reverse lookup: any synonym or the canonical term itself → canonical term.
const SYNONYM_TO_CANONICAL = new Map();
for (const [canonical, list] of Object.entries(SYNONYMS)) {
  SYNONYM_TO_CANONICAL.set(canonical, canonical);
  for (const s of list) SYNONYM_TO_CANONICAL.set(s, canonical);
}

function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ɔ/g, 'o')
    .replace(/ɛ/g, 'e')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Expand a normalized phrase to include any canonical synonym it maps to. */
function expandSynonyms(normalized) {
  const terms = new Set([normalized]);
  const canonical = SYNONYM_TO_CANONICAL.get(normalized);
  if (canonical) terms.add(canonical);
  // Also try each individual word, in case "spicy jollof" should still hit "jollof".
  for (const word of normalized.split(' ')) {
    const c = SYNONYM_TO_CANONICAL.get(word);
    if (c) terms.add(c);
  }
  return [...terms];
}

/**
 * Levenshtein edit distance — small inputs only (product names / search
 * terms), so the classic O(n*m) DP table is plenty fast.
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/** How many typos to tolerate, scaled to how long the word is. */
function typoBudget(len) {
  if (len <= 3) return 0;
  if (len <= 6) return 1;
  return 2;
}

/**
 * Score a product name against a search term: 0 = no match.
 * Higher is better. Exact/substring beats synonym beats fuzzy.
 */
function scoreProductName(searchTerm, productName) {
  const term = normalizeForMatch(searchTerm);
  const name = normalizeForMatch(productName);
  if (!term || !name) return 0;

  if (name === term) return 100;
  if (name.includes(term) || term.includes(name)) return 80;

  const termVariants = expandSynonyms(term);
  for (const variant of termVariants) {
    if (variant !== term && (name.includes(variant) || variant.includes(name))) return 70;
  }

  // Fuzzy: compare the search term against each word in the product name,
  // and against the whole name, taking the best (lowest-distance) result.
  const nameWords = name.split(' ');
  let bestDistance = Infinity;
  for (const word of [name, ...nameWords]) {
    const d = levenshtein(term, word);
    if (d < bestDistance) bestDistance = d;
  }
  const budget = typoBudget(term.length);
  if (bestDistance <= budget) return Math.max(10, 60 - bestDistance * 15);

  return 0;
}

/**
 * Rank products by how well they match a search term.
 * products: [{ id, name, ... }] — any extra fields pass through untouched.
 * Returns products sorted best-first, capped at maxResults, score > 0 only.
 */
function fuzzyMatchProducts(searchTerm, products, { maxResults = 5 } = {}) {
  return products
    .map(p => ({ product: p, score: scoreProductName(searchTerm, p.name) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(r => r.product);
}

module.exports = { normalizeForMatch, levenshtein, scoreProductName, fuzzyMatchProducts, SYNONYMS };
