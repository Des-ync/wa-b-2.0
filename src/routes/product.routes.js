const express = require('express');
const logger = require('../utils/logger');
const { query, transaction } = require('../config/database');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { tenantBlocksBusinessId } = require('../middleware/tenantAccess');
const { toCsv, parseCsv } = require('../utils/csv');
const respond = require('../utils/response');
const {
  validate, msg, str, strExact, num, int, bool, pattern
} = require('../utils/validate');
const orderService = require('../services/order.service');
const automations = require('../services/automations');

const router = express.Router();

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

// Same auth model as orders: admin keys see everything, tenant keys are
// pinned to their own business_id.
router.use(requireAuth('any'));

/**
 * Field schemas, replacing three hand-rolled validators that each walked the
 * body by hand and pushed prose onto an array. Same coercion, same messages —
 * the messages are pinned with msg() precisely because merchants read them —
 * but errors now come back keyed by field, so a client can mark the offending
 * input instead of parsing a semicolon-joined sentence.
 *
 * validateX() below keeps the { errors, out } shape the routes already expect,
 * so this is a swap of the validator internals only. `fields` is exposed
 * alongside for routes that want per-field reporting.
 */
const PRODUCT_SCHEMA = {
  name: msg(strExact({ required: true, max: 200 }), 'name is required (max 200 chars)'),
  price_ghs: msg(num({ required: true, min: 0, round: 2 }), 'price_ghs must be a non-negative number'),
  description: str({ max: 1000, nullable: true, trim: false }),
  category: str({ max: 60, lower: true }),
  in_stock: bool(),
  image_url: str({ max: 500, nullable: true, trim: false }),
  stock_qty: msg(int({ min: 0, nullable: true }),
    'stock_qty must be a non-negative integer, or empty for untracked'),
  low_stock_threshold: msg(int({ min: 0 }), 'low_stock_threshold must be a non-negative integer'),
  cost_price_ghs: msg(num({ min: 0, round: 2, nullable: true }),
    'cost_price_ghs must be a non-negative number, or empty to clear it'),
  supplier_id: str({ nullable: true }),
  featured: bool(),
  hidden: bool(),
  sort_order: msg(int(), 'sort_order must be an integer'),
  available_from: msg(pattern(TIME_RE, { nullable: true }), 'available_from must be HH:MM (24h)'),
  available_to: msg(pattern(TIME_RE, { nullable: true }), 'available_to must be HH:MM (24h)')
};

/**
 * Cross-field rules the per-field schema cannot express, preserved exactly
 * as the original validator had them:
 *   - a merchant setting real stock clearly means in/out of stock, so keep
 *     the two in sync rather than making them flip a second switch...
 *   - ...unless they said otherwise explicitly, which always wins;
 *   - and stock back above zero means "restocked", so clear the low-stock
 *     nudge flag and let a future dip notify again.
 */
function refineProduct(value, source) {
  // An emptied category falls back to 'general', as the hand-rolled validator
  // did with `String(body.category || 'general') ... || 'general'`. The
  // CREATE paths have their own `out.category || 'general'` fallback, but
  // PATCH writes this object straight into the UPDATE — so without this, a
  // merchant clearing the field persisted '', and the product then grouped
  // under nothing and matched no row in `categories`.
  if ('category' in value && !value.category) value.category = 'general';

  if (value.stock_qty != null) {
    if (source.in_stock === undefined) value.in_stock = value.stock_qty > 0;
    if (value.stock_qty > 0) value.low_stock_notified = false;
  }
}

const VARIANT_SCHEMA = {
  name: msg(strExact({ required: true, max: 100 }), 'name is required (max 100 chars)'),
  price_delta_ghs: msg(num({ round: 2 }), 'price_delta_ghs must be a number'),
  stock_qty: msg(int({ min: 0, nullable: true }),
    'stock_qty must be a non-negative integer, or empty for untracked'),
  sort_order: msg(int(), 'sort_order must be an integer')
};

const ADDON_SCHEMA = {
  name: msg(strExact({ required: true, max: 100 }), 'name is required (max 100 chars)'),
  // An add-on IS a price, unlike a variant's delta, so it cannot go negative.
  price_ghs: msg(num({ required: true, min: 0, round: 2 }), 'price_ghs must be a non-negative number'),
  sort_order: msg(int(), 'sort_order must be an integer')
};

/** Adapts validate() to the { errors, out } shape the routes already use. */
function runSchema(schema, body, { partial = false, refine } = {}) {
  const { value, fields } = validate(body, schema, { partial, refine });
  return { errors: Object.values(fields), out: value, fields };
}

const validateProductBody = (body, opts = {}) =>
  runSchema(PRODUCT_SCHEMA, body, { ...opts, refine: refineProduct });
const validateVariantBody = (body, opts = {}) => runSchema(VARIANT_SCHEMA, body, opts);
const validateAddonBody = (body, opts = {}) => runSchema(ADDON_SCHEMA, body, opts);

/** GET /api/products?business_id= — list a business's products. */
router.get('/', async (req, res) => {
  try {
    const businessId = req.query.business_id || req.auth?.businessId;
    if (!businessId) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, businessId)) {
      return respond.forbidden(req, res);
    }
    const result = await query(
      `SELECT * FROM products WHERE business_id = $1 ORDER BY sort_order ASC, category ASC, name ASC`,
      [businessId]
    );
    return respond.ok(req, res, { products: result.rows });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /products', err);
  }
});

/**
 * POST /api/products — create. Body: { business_id?, name, price_ghs, description?,
 * category?, in_stock?, image_url?, stock_qty?, low_stock_threshold?, featured?,
 * hidden?, sort_order?, available_from?, available_to? }
 */
router.post('/', requirePermission('products', 'write'), async (req, res) => {
  try {
    const businessId = req.body?.business_id || req.auth?.businessId;
    if (!businessId) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, businessId)) {
      return respond.forbidden(req, res);
    }
    const { errors, out, fields } = validateProductBody(req.body || {});
    if (errors.length) return respond.invalid(req, res, errors.join('; '), fields);

    const result = await query(
      `INSERT INTO products (
         business_id, name, description, price_ghs, category, in_stock, image_url, stock_qty,
         low_stock_threshold, featured, hidden, sort_order, available_from, available_to,
         cost_price_ghs, supplier_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        businessId, out.name, out.description ?? null, out.price_ghs,
        out.category || 'general', out.in_stock ?? true, out.image_url ?? null,
        out.stock_qty ?? null, out.low_stock_threshold ?? 3, out.featured ?? false,
        out.hidden ?? false, out.sort_order ?? 0, out.available_from ?? null, out.available_to ?? null,
        out.cost_price_ghs ?? null, out.supplier_id ?? null
      ]
    );
    return respond.ok(req, res, { product: result.rows[0] }, { status: 201 });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /products', err);
  }
});

/** PATCH /api/products/:id — update any subset of fields. */
/**
 * Fields that mean something when applied to MANY products at once.
 *
 * Deliberately a short list. Setting every selected product's `name`,
 * `image_url` or `description` to one value is not an edit, it is data loss;
 * one `price_ghs` or `stock_qty` across a selection is almost never what
 * somebody means either — a percentage adjustment or a restock is, and those
 * are different operations. What is left is the set of flags a merchant
 * genuinely toggles in groups: everything in a category out of stock for the
 * day, a handful hidden while they restock.
 */
const BULK_EDITABLE = ['in_stock', 'hidden', 'featured', 'category', 'low_stock_threshold', 'supplier_id'];

/** Bounds the statement, and a selection larger than this is a CSV import. */
const BULK_MAX_IDS = 200;

/**
 * PATCH /api/products/bulk — body: { business_id?, product_ids: [], changes: {} }
 *
 * One request rather than one per product: on a metered 3G connection the
 * difference between 1 and 40 round trips is the merchant's own money, and a
 * single UPDATE is atomic where a client-side loop can half-finish.
 *
 * MUST be declared before `/:id`, or Express matches this path as a product
 * whose id is the literal string "bulk".
 */
/**
 * A name for the copy that is not the original's.
 *
 * Nothing in the database forbids two products sharing a name, and the bot
 * resolves what a customer picked by **id**, so a collision breaks nothing.
 * It is still wrong to leave: a merchant scanning their catalogue — and a
 * customer reading a list — sees "Jollof Rice" twice with no way to tell which
 * is which.
 *
 * Counts up rather than stopping, so duplicating the same product three times
 * gives three distinguishable names instead of failing on the second.
 */
function copyNameFor(originalName, takenNames) {
  const taken = new Set(takenNames.map(n => String(n).toLowerCase()));
  const base = String(originalName || 'Product');
  let candidate = `${base} (copy)`;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${base} (copy ${n})`;
    n++;
  }
  // The column is TEXT but `name` is capped at 200 by the schema; a long
  // original must not produce a copy the normal edit form would then reject.
  return candidate.slice(0, 200);
}

/**
 * POST /api/products/:id/duplicate
 *
 * The point of this is the variants and add-ons. Re-keying a product's fields
 * is a minute's work; re-entering eight sizes and four extras is what makes a
 * merchant not bother, and then the catalogue stays thin.
 *
 * Declared before `/:id` routes that could shadow it, and wrapped in one
 * transaction so a copy never lands with half its options.
 */
/** Bounds the statement; a catalogue larger than this is reordered by CSV. */
const REORDER_MAX = 200;

/**
 * POST /api/products/reorder — { business_id?, order: [product_id, ...] }
 *
 * Sets each product's `sort_order` to its index in the list.
 *
 * This is worth having because both customer-facing surfaces already honour
 * the column — the storefront orders by `featured DESC, sort_order ASC, name`,
 * and the bot's catalogue by `featured DESC, popularity DESC, category
 * sort_order, category, p.sort_order, name`. Checked before building, not
 * assumed: a reorder that only rearranged the merchant's own admin table would
 * be close to pointless.
 *
 * Note what that second ordering means in practice: in the bot, a merchant's
 * hand-picked order sits BELOW featured and below how often something sells.
 * Dragging an item to the top does not necessarily put it first there. The UI
 * says so, because "I moved it and the bot still shows it fourth" is otherwise
 * a support conversation.
 *
 * Declared before `/:id`-shaped routes so "reorder" is never read as an id.
 */
router.post('/reorder', requirePermission('products', 'write'), async (req, res) => {
  try {
    const businessId = req.body?.business_id || req.auth?.businessId;
    if (!businessId) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, businessId)) return respond.forbidden(req, res);

    const order = Array.isArray(req.body?.order) ? req.body.order.filter(Boolean) : null;
    if (!order || !order.length) {
      return respond.invalid(req, res, 'order must be a non-empty array of product ids',
        { order: 'is required' });
    }
    if (order.length > REORDER_MAX) {
      return respond.invalid(req, res,
        `Too many products at once (max ${REORDER_MAX}).`, { order: 'too many' });
    }

    // All-or-nothing: a failure partway through would leave the catalogue in
    // an order the merchant never chose and cannot easily reconstruct.
    //
    // Scoped by business_id in the UPDATE itself, so an id belonging to another
    // tenant simply matches no row rather than being trusted for appearing in
    // the list.
    const updated = await transaction(async client => {
      let n = 0;
      for (let i = 0; i < order.length; i++) {
        const r = await client.query(
          'UPDATE products SET sort_order = $3 WHERE business_id = $1 AND id = $2',
          [businessId, order[i], i]
        );
        n += r.rowCount;
      }
      return n;
    });

    return respond.ok(req, res, { updated, requested: order.length });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /products/reorder', err);
  }
});

router.post('/:id/duplicate', requirePermission('products', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    const original = existing.rows[0];
    if (!original) return respond.notFound(req, res, 'Product');
    if (tenantBlocksBusinessId(req, original.business_id)) {
      return respond.forbidden(req, res);
    }

    const namesRes = await query(
      'SELECT name FROM products WHERE business_id = $1', [original.business_id]);
    const name = copyNameFor(original.name, namesRes.rows.map(r => r.name));

    const created = await transaction(async client => {
      const productRes = await client.query(
        `INSERT INTO products (
           business_id, name, description, price_ghs, category, in_stock, image_url,
           stock_qty, low_stock_threshold, featured, hidden, sort_order,
           available_from, available_to, cost_price_ghs, supplier_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING *`,
        [
          original.business_id, name, original.description, original.price_ghs,
          original.category, original.in_stock, original.image_url,
          // Whether stock is TRACKED is copied; the count is not. A copy of
          // "Large, 7 in stock" made to become "Small" has not got seven of
          // anything — inheriting the number would invent inventory, and the
          // bot decrements it on payment.
          original.stock_qty === null ? null : 0,
          original.low_stock_threshold, original.featured,
          // Hidden regardless of the original. The copy shares its name stem,
          // price and photo, so publishing it instantly puts two near-identical
          // items in front of customers while the merchant is still editing.
          // The response says so and the UI repeats it.
          true,
          original.sort_order, original.available_from, original.available_to,
          original.cost_price_ghs, original.supplier_id
        ]
      );
      const copy = productRes.rows[0];

      // The options are the reason this endpoint exists, so they are copied in
      // the same transaction: a product that arrives without its variants is
      // worse than no copy at all, because the gap is easy to miss.
      const variantsRes = await client.query(
        `INSERT INTO product_variants (product_id, business_id, name, price_delta_ghs, stock_qty, sort_order)
         SELECT $1, business_id, name, price_delta_ghs,
                CASE WHEN stock_qty IS NULL THEN NULL ELSE 0 END,
                sort_order
           FROM product_variants WHERE product_id = $2
         RETURNING id`,
        [copy.id, original.id]
      );
      const addonsRes = await client.query(
        `INSERT INTO product_addons (product_id, business_id, name, price_ghs, sort_order)
         SELECT $1, business_id, name, price_ghs, sort_order
           FROM product_addons WHERE product_id = $2
         RETURNING id`,
        [copy.id, original.id]
      );
      return { copy, variants: variantsRes.rowCount, addons: addonsRes.rowCount };
    });

    logger.info('product %s duplicated to %s (%d variants, %d add-ons)',
      original.id, created.copy.id, created.variants, created.addons);

    return respond.ok(req, res, {
      product: created.copy,
      variants_copied: created.variants,
      addons_copied: created.addons,
      hidden: true
    }, { status: 201 });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /products/:id/duplicate', err);
  }
});

router.patch('/bulk', requirePermission('products', 'write'), async (req, res) => {
  try {
    const businessId = req.body?.business_id || req.auth?.businessId;
    if (!businessId) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, businessId)) {
      return respond.forbidden(req, res);
    }

    const ids = Array.isArray(req.body?.product_ids) ? req.body.product_ids : null;
    if (!ids || !ids.length) {
      return respond.invalid(req, res, 'Select at least one product.',
        { product_ids: 'is required' });
    }
    if (ids.length > BULK_MAX_IDS) {
      return respond.invalid(req, res,
        `Too many products at once (max ${BULK_MAX_IDS}).`, { product_ids: 'too many' });
    }

    const rejected = Object.keys(req.body?.changes || {}).filter(k => !BULK_EDITABLE.includes(k));
    if (rejected.length) {
      return respond.invalid(req, res,
        `These cannot be changed in bulk: ${rejected.join(', ')}.`,
        Object.fromEntries(rejected.map(k => [k, 'not editable in bulk'])));
    }

    // Validated by the SAME schema as a single edit, so bulk cannot become a
    // way to write a value the single path would reject.
    const { errors, out, fields } = validateProductBody(req.body?.changes || {}, { partial: true });
    if (errors.length) return respond.invalid(req, res, errors.join('; '), fields);
    if (!Object.keys(out).length) {
      return respond.invalid(req, res, 'No fields to update');
    }

    // Scoped by business_id in the statement itself: an id belonging to
    // another tenant simply does not match, rather than being trusted because
    // it was in the list.
    const params = [businessId, ids];
    const sets = [];
    for (const [col, val] of Object.entries(out)) {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    }

    const before = await query(
      'SELECT id, in_stock FROM products WHERE business_id = $1 AND id = ANY($2::uuid[])',
      [businessId, ids]
    );
    const result = await query(
      `UPDATE products SET ${sets.join(', ')}
        WHERE business_id = $1 AND id = ANY($2::uuid[])
        RETURNING *`,
      params
    );

    // Same back-in-stock behaviour as the single edit — those customers asked
    // to be told, and suppressing it here would mean they never hear. The
    // count is returned so a merchant who just marked thirty things in stock
    // finds out that messages went out, rather than discovering it on a bill.
    const wasOut = new Set(before.rows.filter(r => !r.in_stock).map(r => r.id));
    const restocked = result.rows.filter(p => p.in_stock && wasOut.has(p.id));
    let notified = 0;
    for (const product of restocked) {
      try {
        notified += await automations.notifyProductRestocked(product) || 0;
      } catch (err) {
        logger.warn('bulk restock notify failed for product %s: %s', product.id, err.message);
      }
    }

    return respond.ok(req, res, {
      updated: result.rowCount,
      requested: ids.length,
      notified,
      changed: Object.keys(out)
    });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'PATCH /products/bulk', err);
  }
});

router.patch('/:id', requirePermission('products', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    const product = existing.rows[0];
    if (!product) return respond.notFound(req, res, 'Product');
    if (tenantBlocksBusinessId(req, product.business_id)) {
      return respond.forbidden(req, res);
    }

    const { errors, out, fields } = validateProductBody(req.body || {}, { partial: true });
    if (errors.length) return respond.invalid(req, res, errors.join('; '), fields);
    if (!Object.keys(out).length) {
      return respond.invalid(req, res, 'No fields to update');
    }

    const sets = [];
    const params = [req.params.id];
    for (const [col, val] of Object.entries(out)) {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    }
    const result = await query(
      `UPDATE products SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    const updated = result.rows[0];

    // Back-in-stock alert: fire-and-forget, never blocks or fails the save.
    if (!product.in_stock && updated.in_stock) {
      automations.notifyProductRestocked(updated).catch(err =>
        logger.warn('notifyProductRestocked failed for product %s: %s', updated.id, err.message));
    }

    return respond.ok(req, res, { product: updated });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'PATCH /products/:id', err);
  }
});

/** DELETE /api/products/:id — remove a product (order history keeps its own snapshot). */
router.delete('/:id', requirePermission('products', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    const product = existing.rows[0];
    if (!product) return respond.notFound(req, res, 'Product');
    if (tenantBlocksBusinessId(req, product.business_id)) {
      return respond.forbidden(req, res);
    }
    await query('DELETE FROM products WHERE id = $1', [req.params.id]);
    return respond.ok(req, res, {});
  } catch (err) {
    return respond.failInternal(req, res, logger, 'DELETE /products/:id', err);
  }
});

/**
 * GET /api/products/:id/frequently-bought-with — items that most often
 * appear in the same paid order as this one, for the dashboard's upsell view.
 */
router.get('/:id/frequently-bought-with', async (req, res) => {
  try {
    const productRes = await query('SELECT id, business_id, name FROM products WHERE id = $1', [req.params.id]);
    const product = productRes.rows[0];
    if (!product) return respond.notFound(req, res, 'Product');
    if (tenantBlocksBusinessId(req, product.business_id)) {
      return respond.forbidden(req, res);
    }
    const rows = await orderService.getFrequentlyBoughtWith(product.business_id, [product.name], { limit: 5 });
    return respond.ok(req, res, { suggestions: rows });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /products/:id/frequently-bought-with', err);
  }
});

/* ============================== Variants ============================== */

/** GET /api/products/:id/variants */
router.get('/:id/variants', async (req, res) => {
  try {
    const productRes = await query('SELECT id, business_id FROM products WHERE id = $1', [req.params.id]);
    const product = productRes.rows[0];
    if (!product) return respond.notFound(req, res, 'Product');
    if (tenantBlocksBusinessId(req, product.business_id)) {
      return respond.forbidden(req, res);
    }
    const result = await query(
      'SELECT * FROM product_variants WHERE product_id = $1 ORDER BY sort_order ASC, name ASC',
      [req.params.id]
    );
    return respond.ok(req, res, { variants: result.rows });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /products/:id/variants', err);
  }
});

/** POST /api/products/:id/variants — { name, price_delta_ghs?, stock_qty?, sort_order? } */
router.post('/:id/variants', requirePermission('products', 'write'), async (req, res) => {
  try {
    const productRes = await query('SELECT id, business_id FROM products WHERE id = $1', [req.params.id]);
    const product = productRes.rows[0];
    if (!product) return respond.notFound(req, res, 'Product');
    if (tenantBlocksBusinessId(req, product.business_id)) {
      return respond.forbidden(req, res);
    }
    const { errors, out, fields } = validateVariantBody(req.body || {});
    if (errors.length) return respond.invalid(req, res, errors.join('; '), fields);

    const result = await query(
      `INSERT INTO product_variants (product_id, business_id, name, price_delta_ghs, stock_qty, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [product.id, product.business_id, out.name, out.price_delta_ghs ?? 0, out.stock_qty ?? null, out.sort_order ?? 0]
    );
    return respond.ok(req, res, { variant: result.rows[0] }, { status: 201 });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /products/:id/variants', err);
  }
});

/** PATCH /api/products/variants/:variantId */
router.patch('/variants/:variantId', requirePermission('products', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM product_variants WHERE id = $1', [req.params.variantId]);
    const variant = existing.rows[0];
    if (!variant) return respond.notFound(req, res, 'Variant');
    if (tenantBlocksBusinessId(req, variant.business_id)) {
      return respond.forbidden(req, res);
    }
    const { errors, out, fields } = validateVariantBody(req.body || {}, { partial: true });
    if (errors.length) return respond.invalid(req, res, errors.join('; '), fields);
    if (!Object.keys(out).length) return respond.invalid(req, res, 'No fields to update');

    const sets = [];
    const params = [req.params.variantId];
    for (const [col, val] of Object.entries(out)) {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    }
    const result = await query(`UPDATE product_variants SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    return respond.ok(req, res, { variant: result.rows[0] });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'PATCH /products/variants/:variantId', err);
  }
});

/** DELETE /api/products/variants/:variantId */
router.delete('/variants/:variantId', requirePermission('products', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM product_variants WHERE id = $1', [req.params.variantId]);
    const variant = existing.rows[0];
    if (!variant) return respond.notFound(req, res, 'Variant');
    if (tenantBlocksBusinessId(req, variant.business_id)) {
      return respond.forbidden(req, res);
    }
    await query('DELETE FROM product_variants WHERE id = $1', [req.params.variantId]);
    return respond.ok(req, res, {});
  } catch (err) {
    return respond.failInternal(req, res, logger, 'DELETE /products/variants/:variantId', err);
  }
});

/* =============================== Add-ons =============================== */

/** GET /api/products/:id/addons */
router.get('/:id/addons', async (req, res) => {
  try {
    const productRes = await query('SELECT id, business_id FROM products WHERE id = $1', [req.params.id]);
    const product = productRes.rows[0];
    if (!product) return respond.notFound(req, res, 'Product');
    if (tenantBlocksBusinessId(req, product.business_id)) {
      return respond.forbidden(req, res);
    }
    const result = await query(
      'SELECT * FROM product_addons WHERE product_id = $1 ORDER BY sort_order ASC, name ASC',
      [req.params.id]
    );
    return respond.ok(req, res, { addons: result.rows });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /products/:id/addons', err);
  }
});

/** POST /api/products/:id/addons — { name, price_ghs, sort_order? } */
router.post('/:id/addons', requirePermission('products', 'write'), async (req, res) => {
  try {
    const productRes = await query('SELECT id, business_id FROM products WHERE id = $1', [req.params.id]);
    const product = productRes.rows[0];
    if (!product) return respond.notFound(req, res, 'Product');
    if (tenantBlocksBusinessId(req, product.business_id)) {
      return respond.forbidden(req, res);
    }
    const { errors, out, fields } = validateAddonBody(req.body || {});
    if (errors.length) return respond.invalid(req, res, errors.join('; '), fields);

    const result = await query(
      `INSERT INTO product_addons (product_id, business_id, name, price_ghs, sort_order)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [product.id, product.business_id, out.name, out.price_ghs, out.sort_order ?? 0]
    );
    return respond.ok(req, res, { addon: result.rows[0] }, { status: 201 });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /products/:id/addons', err);
  }
});

/** PATCH /api/products/addons/:addonId */
router.patch('/addons/:addonId', requirePermission('products', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM product_addons WHERE id = $1', [req.params.addonId]);
    const addon = existing.rows[0];
    if (!addon) return respond.notFound(req, res, 'Add-on');
    if (tenantBlocksBusinessId(req, addon.business_id)) {
      return respond.forbidden(req, res);
    }
    const { errors, out, fields } = validateAddonBody(req.body || {}, { partial: true });
    if (errors.length) return respond.invalid(req, res, errors.join('; '), fields);
    if (!Object.keys(out).length) return respond.invalid(req, res, 'No fields to update');

    const sets = [];
    const params = [req.params.addonId];
    for (const [col, val] of Object.entries(out)) {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    }
    const result = await query(`UPDATE product_addons SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    return respond.ok(req, res, { addon: result.rows[0] });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'PATCH /products/addons/:addonId', err);
  }
});

/** DELETE /api/products/addons/:addonId */
router.delete('/addons/:addonId', requirePermission('products', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM product_addons WHERE id = $1', [req.params.addonId]);
    const addon = existing.rows[0];
    if (!addon) return respond.notFound(req, res, 'Add-on');
    if (tenantBlocksBusinessId(req, addon.business_id)) {
      return respond.forbidden(req, res);
    }
    await query('DELETE FROM product_addons WHERE id = $1', [req.params.addonId]);
    return respond.ok(req, res, {});
  } catch (err) {
    return respond.failInternal(req, res, logger, 'DELETE /products/addons/:addonId', err);
  }
});

/* ============================ CSV import/export ========================= */

const CSV_COLUMNS = [
  'id', 'name', 'description', 'price_ghs', 'cost_price_ghs', 'category', 'in_stock', 'stock_qty',
  'low_stock_threshold', 'featured', 'hidden', 'available_from', 'available_to', 'image_url'
];

/** GET /api/products/export?business_id= — CSV download of the full catalog. */
router.get('/export', async (req, res) => {
  try {
    const businessId = req.query.business_id || req.auth?.businessId;
    if (!businessId) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, businessId)) {
      return respond.forbidden(req, res);
    }
    const result = await query(
      `SELECT * FROM products WHERE business_id = $1 ORDER BY sort_order ASC, category ASC, name ASC`,
      [businessId]
    );
    const rows = result.rows.map(p => CSV_COLUMNS.map(col => p[col]));
    const csv = toCsv(CSV_COLUMNS, rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="products-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /products/export', err);
  }
});

/**
 * POST /api/products/import — bulk create/update from CSV text.
 * Body: { business_id?, csv }. Rows with a matching `id` (belonging to this
 * business) are updated in place; all other rows are inserted. Malformed
 * rows are skipped and reported back rather than aborting the whole import.
 */
/**
 * POST /api/products/import — body: { business_id?, csv, dry_run? }
 *
 * `dry_run: true` validates the whole file and reports exactly what WOULD
 * happen, row by row, without writing anything. A merchant pasting a
 * spreadsheet has no other way to find out that column 3 is the wrong one
 * until their catalogue is already wrong — and unlike a single bad product,
 * a bad import is 200 of them.
 *
 * The real import runs in ONE transaction. It used to write row by row, so a
 * database error on row 150 of 200 left 149 products written, returned a 500,
 * and gave the merchant no way to know which. Validation failures still skip
 * individual rows and report them — those are the merchant's typos, not a
 * failure of the import — but anything unexpected now rolls the whole file
 * back.
 */
router.post('/import', requirePermission('products', 'write'), async (req, res) => {
  try {
    const businessId = req.body?.business_id || req.auth?.businessId;
    if (!businessId) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, businessId)) {
      return respond.forbidden(req, res);
    }
    const csvText = req.body?.csv;
    if (!csvText || typeof csvText !== 'string') {
      return respond.invalid(req, res, 'csv (string) is required', { csv: 'is invalid' });
    }
    const dryRun = req.body?.dry_run === true;

    const rows = parseCsv(csvText);
    if (!rows.length) return respond.invalid(req, res, 'CSV has no rows');

    const header = rows[0].map(h => String(h || '').trim().toLowerCase());
    const dataRows = rows.slice(1);
    if (dataRows.length > 2000) {
      return respond.invalid(req, res, 'Import is limited to 2000 rows per file');
    }

    // Built first, applied second — so a dry run and a real import agree by
    // construction rather than by two code paths that must be kept in step.
    const plan = [];
    const skipped = [];

    // Only trust an `id` that already belongs to this business — prevents a
    // crafted CSV from overwriting another tenant's product by guessing UUIDs.
    const existingIdsRes = await query('SELECT id FROM products WHERE business_id = $1', [businessId]);
    const ownedIds = new Set(existingIdsRes.rows.map(r => r.id));

    for (let i = 0; i < dataRows.length; i++) {
      const cells = dataRows[i];
      const record = {};
      header.forEach((col, idx) => { record[col] = cells[idx]; });

      const bodyForValidation = {
        name: record.name,
        description: record.description || undefined,
        price_ghs: record.price_ghs,
        cost_price_ghs: record.cost_price_ghs === '' ? null : (record.cost_price_ghs || undefined),
        category: record.category || undefined,
        in_stock: record.in_stock === undefined ? undefined : /^(1|true|yes)$/i.test(String(record.in_stock).trim()),
        stock_qty: record.stock_qty === '' ? null : record.stock_qty,
        low_stock_threshold: record.low_stock_threshold || undefined,
        featured: record.featured === undefined ? undefined : /^(1|true|yes)$/i.test(String(record.featured).trim()),
        hidden: record.hidden === undefined ? undefined : /^(1|true|yes)$/i.test(String(record.hidden).trim()),
        available_from: record.available_from,
        available_to: record.available_to,
        image_url: record.image_url || undefined
      };

      const isUpdate = record.id && ownedIds.has(record.id);
      const { errors, out } = validateProductBody(bodyForValidation, { partial: isUpdate });
      if (errors.length) {
        skipped.push({ row: i + 2, name: record.name || '(no name)', errors });
        continue;
      }

      plan.push({
        row: i + 2,
        action: isUpdate ? 'update' : 'create',
        id: isUpdate ? record.id : null,
        name: out.name ?? record.name ?? '',
        // Which columns this row actually changes — the difference between
        // "200 updates" and "200 updates that all blank your descriptions".
        fields: Object.keys(out),
        values: out
      });
    }

    const created = plan.filter(p => p.action === 'create').length;
    const updated = plan.filter(p => p.action === 'update').length;

    if (dryRun) {
      return respond.ok(req, res,
        {
          // Capped: a 2000-row preview is unreadable and a large response on
          // a slow connection. The counts above still describe the whole file.
          preview: plan.slice(0, 50).map(({ values: _values, ...row }) => row),
          skipped
        },
        {
          meta: {
            dry_run: true,
            created, updated,
            skipped_count: skipped.length,
            preview_truncated: plan.length > 50
          }
        });
    }

    // One transaction for the whole file: a failure part-way through must not
    // leave a half-imported catalogue the merchant cannot reason about.
    await transaction(async client => {
      for (const row of plan) {
        if (row.action === 'update') {
          const sets = [];
          const params = [row.id];
          for (const [col, val] of Object.entries(row.values)) {
            params.push(val);
            sets.push(`${col} = $${params.length}`);
          }
          if (sets.length) {
            await client.query(`UPDATE products SET ${sets.join(', ')} WHERE id = $1`, params);
          }
        } else {
          const out = row.values;
          await client.query(
            `INSERT INTO products (
               business_id, name, description, price_ghs, category, in_stock, image_url, stock_qty,
               low_stock_threshold, featured, hidden, available_from, available_to, cost_price_ghs
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
              businessId, out.name, out.description ?? null, out.price_ghs,
              out.category || 'general', out.in_stock ?? true, out.image_url ?? null,
              out.stock_qty ?? null, out.low_stock_threshold ?? 3, out.featured ?? false,
              out.hidden ?? false, out.available_from ?? null, out.available_to ?? null,
              out.cost_price_ghs ?? null
            ]
          );
        }
      }
    });

    return respond.ok(req, res,
      { created, updated, skipped },
      { meta: { skipped_count: skipped.length } });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /products/import', err);
  }
});

/* ============================== Bundles ================================= */
// Fixed-price groupings of existing products ("Lunch combo: Jollof + drink").
// Sold on the storefront and reorderable in WhatsApp as ONE line item priced
// at the bundle's own price_ghs — components are display-only metadata, not
// separately inventory-tracked (see migrate.js note on product_bundles).

const BUNDLE_SCHEMA = {
  name: msg(strExact({ required: true, max: 200 }), 'name is required (max 200 chars)'),
  price_ghs: msg(num({ required: true, min: 0, round: 2 }), 'price_ghs must be a non-negative number'),
  description: str({ max: 1000, nullable: true, trim: false }),
  image_url: str({ max: 500, nullable: true, trim: false }),
  active: bool(),
  sort_order: msg(int(), 'sort_order must be an integer')
};

/**
 * Bundle items are the one field a per-field schema cannot express: each
 * entry needs a product_id, and a missing/zero/fractional quantity silently
 * becomes 1 rather than failing — a merchant listing three products without
 * quantities means one of each. Kept as a refine step so that coercion stays
 * next to the rule that explains it.
 */
function refineBundle(value, source) {
  if (source.items === undefined) return null;
  if (!Array.isArray(source.items) || !source.items.length) {
    return { items: 'items must be a non-empty array of { product_id, quantity? }' };
  }
  if (source.items.some(it => !it || !it.product_id)) {
    return { items: 'every item needs a product_id' };
  }
  value.items = source.items.map(it => ({
    product_id: it.product_id,
    quantity: Number.isInteger(Number(it.quantity)) && Number(it.quantity) > 0 ? Number(it.quantity) : 1
  }));
  return null;
}

const validateBundleBody = (body, opts = {}) =>
  runSchema(BUNDLE_SCHEMA, body, { ...opts, refine: refineBundle });

async function loadBundle(id) {
  const bundleRes = await query('SELECT * FROM product_bundles WHERE id = $1', [id]);
  const bundle = bundleRes.rows[0];
  if (!bundle) return null;
  const itemsRes = await query(
    `SELECT bi.product_id, bi.quantity, p.name, p.price_ghs, p.image_url
       FROM product_bundle_items bi JOIN products p ON p.id = bi.product_id
      WHERE bi.bundle_id = $1
      ORDER BY p.name ASC`,
    [id]
  );
  return { ...bundle, items: itemsRes.rows };
}

async function replaceBundleItems(bundleId, businessId, items) {
  const ownedRes = await query('SELECT id FROM products WHERE business_id = $1', [businessId]);
  const owned = new Set(ownedRes.rows.map(r => r.id));
  for (const it of items) {
    if (!owned.has(it.product_id)) throw Object.assign(new Error('One or more products do not belong to this business'), { status: 400 });
  }
  await query('DELETE FROM product_bundle_items WHERE bundle_id = $1', [bundleId]);
  for (const it of items) {
    await query(
      'INSERT INTO product_bundle_items (bundle_id, product_id, quantity) VALUES ($1,$2,$3)',
      [bundleId, it.product_id, it.quantity]
    );
  }
}

/** GET /api/products/bundles?business_id= */
router.get('/bundles', async (req, res) => {
  try {
    const businessId = req.query.business_id || req.auth?.businessId;
    if (!businessId) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, businessId)) {
      return respond.forbidden(req, res);
    }
    const bundlesRes = await query(
      'SELECT * FROM product_bundles WHERE business_id = $1 ORDER BY sort_order ASC, name ASC',
      [businessId]
    );
    const itemsRes = await query(
      `SELECT bi.bundle_id, bi.product_id, bi.quantity, p.name, p.price_ghs
         FROM product_bundle_items bi JOIN products p ON p.id = bi.product_id
        WHERE bi.bundle_id = ANY($1::uuid[])`,
      [bundlesRes.rows.map(b => b.id)]
    );
    const byBundle = new Map();
    for (const it of itemsRes.rows) {
      if (!byBundle.has(it.bundle_id)) byBundle.set(it.bundle_id, []);
      byBundle.get(it.bundle_id).push(it);
    }
    const bundles = bundlesRes.rows.map(b => ({ ...b, items: byBundle.get(b.id) || [] }));
    return respond.ok(req, res, { bundles });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /products/bundles', err);
  }
});

/** POST /api/products/bundles — { business_id?, name, price_ghs, description?, image_url?, items: [{product_id, quantity?}] } */
router.post('/bundles', requirePermission('products', 'write'), async (req, res) => {
  try {
    const businessId = req.body?.business_id || req.auth?.businessId;
    if (!businessId) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, businessId)) {
      return respond.forbidden(req, res);
    }
    const { errors, out, fields } = validateBundleBody(req.body || {});
    // A bundle with no items is not a bundle. Only enforced on create —
    // a PATCH that omits items leaves the existing ones alone.
    if (!out.items) {
      errors.push('items is required');
      fields.items = fields.items || 'is required';
    }
    if (errors.length) return respond.invalid(req, res, errors.join('; '), fields);

    const inserted = await query(
      `INSERT INTO product_bundles (business_id, name, description, price_ghs, image_url, active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [businessId, out.name, out.description ?? null, out.price_ghs, out.image_url ?? null, out.active ?? true, out.sort_order ?? 0]
    );
    const bundle = inserted.rows[0];
    await replaceBundleItems(bundle.id, businessId, out.items);
    return respond.ok(req, res, { bundle: await loadBundle(bundle.id) }, { status: 201 });
  } catch (err) {
    if (err.status) {
      logger.warn('POST /products/bundles rejected: %s', err.message);
      return respond.fail(req, res, { code: respond.CODES.VALIDATION, message: err.message, status: err.status });
    }
    return respond.failInternal(req, res, logger, 'POST /products/bundles', err);
  }
});

/** PATCH /api/products/bundles/:id */
router.patch('/bundles/:id', requirePermission('products', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM product_bundles WHERE id = $1', [req.params.id]);
    const bundle = existing.rows[0];
    if (!bundle) return respond.notFound(req, res, 'Bundle');
    if (tenantBlocksBusinessId(req, bundle.business_id)) {
      return respond.forbidden(req, res);
    }
    const { errors, out, fields } = validateBundleBody(req.body || {}, { partial: true });
    if (errors.length) return respond.invalid(req, res, errors.join('; '), fields);

    const { items, ...columns } = out;
    if (Object.keys(columns).length) {
      const sets = [];
      const params = [bundle.id];
      for (const [col, val] of Object.entries(columns)) {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      }
      await query(`UPDATE product_bundles SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, params);
    }
    if (items) await replaceBundleItems(bundle.id, bundle.business_id, items);
    return respond.ok(req, res, { bundle: await loadBundle(bundle.id) });
  } catch (err) {
    if (err.status) {
      logger.warn('PATCH /products/bundles/:id rejected: %s', err.message);
      return respond.fail(req, res, { code: respond.CODES.VALIDATION, message: err.message, status: err.status });
    }
    return respond.failInternal(req, res, logger, 'PATCH /products/bundles/:id', err);
  }
});

/** DELETE /api/products/bundles/:id */
router.delete('/bundles/:id', requirePermission('products', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM product_bundles WHERE id = $1', [req.params.id]);
    const bundle = existing.rows[0];
    if (!bundle) return respond.notFound(req, res, 'Bundle');
    if (tenantBlocksBusinessId(req, bundle.business_id)) {
      return respond.forbidden(req, res);
    }
    await query('DELETE FROM product_bundles WHERE id = $1', [req.params.id]);
    return respond.ok(req, res, {});
  } catch (err) {
    return respond.failInternal(req, res, logger, 'DELETE /products/bundles/:id', err);
  }
});

module.exports = router;
module.exports._testing = { copyNameFor, BULK_EDITABLE, BULK_MAX_IDS };
