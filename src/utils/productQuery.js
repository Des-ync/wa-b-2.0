/**
 * Detects natural-language product inquiries that aren't cart actions:
 *   "Do you have spicy rice?"     -> { type: 'availability', term: 'spicy rice' }
 *   "Anything below 50 cedis?"    -> { type: 'price_below', max: 50 }
 *   "What's over 100 cedis?"      -> { type: 'price_above', min: 100 }
 *   "Between 20 and 50 cedis"     -> { type: 'price_between', min: 20, max: 50 }
 *   "How much is delivery?"       -> { type: 'delivery_fee' }
 * Returns null when the text doesn't look like a question — callers fall
 * back to their existing typed-product-add / unknown-text handling.
 */

const NUMBER_RE = '(\\d+(?:\\.\\d+)?)';

const BETWEEN_RE = new RegExp(`between\\s+${NUMBER_RE}\\s+and\\s+${NUMBER_RE}`, 'i');
const BELOW_RE = new RegExp(`(?:below|under|less than|cheaper than|not more than|max(?:imum)?)\\s+(?:gh[c¢s]?\\s*)?${NUMBER_RE}`, 'i');
const ABOVE_RE = new RegExp(`(?:above|over|more than|greater than|at least)\\s+(?:gh[c¢s]?\\s*)?${NUMBER_RE}`, 'i');

// "how much is delivery", "delivery fee/cost/charge", "shipping cost",
// "cost of delivery", "do you deliver" — a question about the delivery
// charge itself, not a specific area (that's handled by showing the zone
// list, since we have no reliable way to parse an arbitrary place name).
const DELIVERY_FEE_RE = /\b(?:how much (?:is|for|does)?\s*(?:the\s*)?delivery\s*(?:cost|fee|charge)?|delivery\s*(?:fee|cost|charge|price)|shipping\s*(?:fee|cost)|cost of (?:delivery|shipping)|do you deliver)\b/i;

// "do you have X", "do you sell X", "is there X", "any X", "got any X",
// "you have X" (optionally trailing "?"). Captures the product term.
const AVAILABILITY_RE = /\b(?:do you (?:have|sell|carry)|is there|are there any|got any|you got|you have|any)\s+(.+?)\s*\??$/i;

function detectProductQuery(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const between = BETWEEN_RE.exec(raw);
  if (between) {
    const a = parseFloat(between[1]);
    const b = parseFloat(between[2]);
    return { type: 'price_between', min: Math.min(a, b), max: Math.max(a, b) };
  }

  const below = BELOW_RE.exec(raw);
  if (below) return { type: 'price_below', max: parseFloat(below[1]) };

  const above = ABOVE_RE.exec(raw);
  if (above) return { type: 'price_above', min: parseFloat(above[1]) };

  if (DELIVERY_FEE_RE.test(raw)) return { type: 'delivery_fee' };

  const avail = AVAILABILITY_RE.exec(raw);
  if (avail) {
    const term = avail[1].trim().replace(/^(any|some)\s+/i, '');
    if (term.length >= 2 && term.length <= 60) return { type: 'availability', term };
  }

  return null;
}

module.exports = { detectProductQuery };
