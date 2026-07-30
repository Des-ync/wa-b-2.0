/**
 * Declarative request validation, generalized from the hand-rolled
 * validateProductBody / validateVariantBody / validateAddonBody in
 * product.routes.js.
 *
 * Those work, but they push a flat array of prose strings ("name is required
 * (max 200 chars)") back to the client, so a form cannot tell WHICH field is
 * wrong without parsing English. This layer keeps their exact coercion
 * behaviour and returns errors keyed by field, which drops straight into the
 * `fields` object of the v2 error envelope and lets a client mark the right
 * input red.
 *
 * Deliberately not a schema library from npm. What the routes actually need
 * is: coerce, bound, default, and report per field — about eighty lines of
 * it — and every rule below already exists somewhere in this codebase. A
 * dependency would be more surface area than the thing it replaces.
 *
 *   const SCHEMA = {
 *     name:      str({ required: true, max: 200 }),
 *     price_ghs: num({ required: true, min: 0, round: 2 }),
 *     stock_qty: int({ min: 0, nullable: true }),
 *     in_stock:  bool(),
 *     category:  str({ max: 60, lower: true, default: 'general' })
 *   };
 *   const { valid, value, fields } = validate(req.body, SCHEMA, { partial: true });
 */

/**
 * A field rule is { parse(raw) -> { value } | { error }, required?, ... }.
 * `parse` never throws: an unparseable value is an error, not an exception,
 * because one bad field must not stop the other nine from being reported.
 */

const MISSING = Symbol('missing');

/**
 * Replace whatever reason a rule produces with `message`.
 *
 *   msg(num({ required: true, min: 0 }), 'must be a non-negative number')
 *
 * Exists so a route being migrated onto this layer keeps emitting the EXACT
 * prose it emitted before. Those strings are rendered to merchants today —
 * silently rewording them mid-migration would be a user-visible change
 * smuggled in under a refactor. A combinator rather than a `message` option
 * on every factory, because it composes with all of them for free.
 */
function msg(rule, message) {
  return {
    ...rule,
    parse(raw) {
      const r = rule.parse(raw);
      return r.error ? { error: message } : r;
    }
  };
}

function str({ required = false, max, min = 0, lower = false, trim = true, nullable = false, default: dflt } = {}) {
  return {
    required,
    default: dflt,
    nullable,
    parse(raw) {
      if (raw === null || raw === '') {
        if (nullable) return { value: null };
        if (required) return { error: 'is required' };
        return { value: '' };
      }
      let s = String(raw);
      if (trim) s = s.trim();
      if (lower) s = s.toLowerCase();
      if (!s && required) return { error: 'is required' };
      if (min && s.length < min) return { error: `must be at least ${min} characters` };
      // Truncate rather than reject: these are merchant-typed fields where
      // silently keeping the first N characters is friendlier than refusing
      // a whole product because a description ran long. Matches what the
      // product routes already do.
      if (max && s.length > max) s = s.slice(0, max);
      return { value: s };
    }
  };
}

/** Same as str, but over-length is an ERROR rather than a truncation. */
function strExact({ required = false, max, ...rest } = {}) {
  const base = str({ required, ...rest });
  return {
    ...base,
    parse(raw) {
      const r = base.parse(raw);
      if (r.error) return r;
      if (max && typeof r.value === 'string' && r.value.length > max) {
        return { error: `must be ${max} characters or fewer` };
      }
      return r;
    }
  };
}

function num({ required = false, min, max, round, nullable = false, default: dflt } = {}) {
  return {
    required,
    default: dflt,
    nullable,
    parse(raw) {
      if (raw === null || raw === '') {
        if (nullable) return { value: null };
        if (required) return { error: 'is required' };
        return { value: null };
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) return { error: 'must be a number' };
      if (min != null && n < min) return { error: `must be ${min} or more` };
      if (max != null && n > max) return { error: `must be ${max} or less` };
      const v = round != null ? Math.round(n * 10 ** round) / 10 ** round : n;
      return { value: v };
    }
  };
}

function int({ required = false, min, max, nullable = false, default: dflt } = {}) {
  return {
    required,
    default: dflt,
    nullable,
    parse(raw) {
      if (raw === null || raw === '') {
        if (nullable) return { value: null };
        if (required) return { error: 'is required' };
        return { value: null };
      }
      const n = Number(raw);
      if (!Number.isInteger(n)) return { error: 'must be a whole number' };
      if (min != null && n < min) return { error: `must be ${min} or more` };
      if (max != null && n > max) return { error: `must be ${max} or less` };
      return { value: n };
    }
  };
}

/**
 * Boolean. Deliberately truthy-coercing (`!!raw`) to match every existing
 * route, so a migrated route's behaviour does not shift under callers that
 * currently send 1/0 or "yes".
 */
function bool({ default: dflt } = {}) {
  return { default: dflt, parse: raw => ({ value: !!raw }) };
}

function oneOf(values, { required = false, nullable = false, lower = false, default: dflt } = {}) {
  return {
    required,
    default: dflt,
    nullable,
    parse(raw) {
      if (raw === null || raw === '') {
        if (nullable) return { value: null };
        if (required) return { error: 'is required' };
        return { value: null };
      }
      const s = lower ? String(raw).trim().toLowerCase() : String(raw).trim();
      if (!values.includes(s)) return { error: `must be one of: ${values.join(', ')}` };
      return { value: s };
    }
  };
}

function pattern(re, { required = false, nullable = false, message, default: dflt } = {}) {
  return {
    required,
    default: dflt,
    nullable,
    parse(raw) {
      if (raw === null || raw === '') {
        if (nullable) return { value: null };
        if (required) return { error: 'is required' };
        return { value: null };
      }
      const s = String(raw).trim();
      if (!re.test(s)) return { error: message || 'is not in the expected format' };
      return { value: s };
    }
  };
}

function arrayOf(rule, { required = false, max, default: dflt } = {}) {
  return {
    required,
    default: dflt,
    parse(raw) {
      if (raw == null) {
        if (required) return { error: 'is required' };
        return { value: [] };
      }
      if (!Array.isArray(raw)) return { error: 'must be a list' };
      const out = [];
      for (const [i, item] of raw.entries()) {
        const r = rule.parse(item);
        // Report the first bad element with its index — "item 3 must be a
        // number" is actionable, "must be a list of numbers" is not.
        if (r.error) return { error: `item ${i + 1} ${r.error}` };
        out.push(r.value);
      }
      return { value: max ? out.slice(0, max) : out };
    }
  };
}

/**
 * Run `body` through `schema`.
 *
 * @param partial  PATCH semantics: only validate keys actually present, and
 *                 skip `required` for the rest. Same flag the existing
 *                 product validators take.
 * @param refine   Optional cross-field pass, run only when every individual
 *                 field is already valid. Receives the coerced value object
 *                 and may mutate it or return a { field: reason } map. This
 *                 is the escape hatch for rules a per-field schema cannot
 *                 express — e.g. products' "setting stock_qty above zero
 *                 also implies in_stock".
 *
 * @returns { valid, value, fields } — `fields` is {} when valid.
 */
function validate(body, schema, { partial = false, refine } = {}) {
  const source = body && typeof body === 'object' ? body : {};
  const value = {};
  const fields = {};

  for (const [name, rule] of Object.entries(schema)) {
    // An explicitly-`undefined` value counts as ABSENT, not as a value to
    // validate. This is what the hand-rolled validators this layer replaced
    // did (`if (body.x !== undefined)`), and it matters for callers that
    // build an object rather than receiving JSON: the CSV import assembles
    // `{ stock_qty: record.stock_qty }` from a spreadsheet, so a file with no
    // stock_qty column produced a key holding undefined. Treating that as a
    // supplied value rejected every row of any CSV missing an optional
    // column — which is most of them. JSON has no undefined, so request
    // bodies are unaffected either way.
    const present = Object.prototype.hasOwnProperty.call(source, name)
      && source[name] !== undefined;
    const raw = present ? source[name] : MISSING;

    if (!present) {
      if (partial) continue;               // PATCH: absent means "leave alone"
      if (rule.required) {
        // Through the rule rather than a hardcoded string, so a msg()
        // override applies to a MISSING field as well as a malformed one.
        // Anything else would give the same field two different voices
        // depending on whether the client omitted it or sent it blank.
        fields[name] = rule.parse(null).error || 'is required';
        continue;
      }
      if (rule.default !== undefined) { value[name] = rule.default; }
      continue;
    }

    const result = rule.parse(raw);
    if (result.error) fields[name] = result.error;
    else value[name] = result.value;
  }

  if (Object.keys(fields).length === 0 && typeof refine === 'function') {
    const extra = refine(value, source) || {};
    for (const [k, v] of Object.entries(extra)) fields[k] = v;
  }

  return { valid: Object.keys(fields).length === 0, value, fields };
}

/**
 * One-line human summary of a fields map, for the `message` beside it —
 * clients that only render `error` still get something useful, and the
 * legacy envelope has nowhere else to put it.
 */
function summarize(fields) {
  const entries = Object.entries(fields);
  if (!entries.length) return 'Invalid request';
  const [name, reason] = entries[0];
  return entries.length === 1
    ? `${name} ${reason}`
    : `${name} ${reason} (and ${entries.length - 1} more)`;
}

module.exports = {
  validate, summarize, msg,
  str, strExact, num, int, bool, oneOf, pattern, arrayOf
};
