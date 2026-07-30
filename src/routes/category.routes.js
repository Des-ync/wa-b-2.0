const express = require('express');
const logger = require('../utils/logger');
const { query, transaction } = require('../config/database');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { tenantBlocksBusinessId } = require('../middleware/tenantAccess');
const respond = require('../utils/response');
const { validate, summarize, str, int, bool, arrayOf } = require('../utils/validate');

const router = express.Router();

router.use(requireAuth('any'));

/**
 * First route group migrated to the shared response + validation layer
 * (see src/utils/response.js). Legacy callers are unaffected: without an
 * `X-API-Version: 2` header every response below is byte-for-byte what it
 * was before. The category-routes tests assert exactly that.
 */

// Category names are the join key between `categories` and `products.category`
// free text, so they are normalized identically in both places: trimmed,
// lower-cased, capped at 60.
const NAME = str({ max: 60, lower: true });

const CREATE_SCHEMA = {
  name: str({ required: true, max: 60, lower: true }),
  sort_order: int({ default: 0 }),
  hidden: bool({ default: false })
};

const PATCH_SCHEMA = {
  name: str({ required: true, max: 60, lower: true }),
  sort_order: int(),
  hidden: bool()
};

// No `max` here on purpose: arrayOf's max TRUNCATES, and the original route
// REJECTED an over-long list. Silently reordering the first 200 of 250
// categories and reporting success would be worse than refusing, so the
// bound is enforced explicitly below.
const REORDER_MAX = 200;
const REORDER_SCHEMA = {
  order: arrayOf(NAME, { required: true })
};

/**
 * GET /api/categories?business_id= — display metadata (sort order, hidden)
 * per category name, merged with any product category that hasn't been
 * customized yet (virtual row, id: null, sort_order 0, hidden false) so the
 * dashboard has one place to list and manage every category in use.
 */
router.get('/', async (req, res) => {
  try {
    const businessId = req.query.business_id || req.auth?.businessId;
    if (!businessId) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, businessId)) return respond.forbidden(req, res);

    const result = await query(
      `SELECT id, name, sort_order, hidden FROM categories WHERE business_id = $1
       UNION ALL
       SELECT NULL, lower(p.category), 0, FALSE
         FROM (SELECT DISTINCT category FROM products WHERE business_id = $1) p
        WHERE lower(p.category) NOT IN (SELECT lower(name) FROM categories WHERE business_id = $1)
       ORDER BY sort_order ASC, name ASC`,
      [businessId]
    );
    return respond.ok(req, res, { categories: result.rows });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /categories', err);
  }
});

/** POST /api/categories — { business_id?, name, sort_order?, hidden? } */
router.post('/', requirePermission('products', 'write'), async (req, res) => {
  try {
    const businessId = req.body?.business_id || req.auth?.businessId;
    if (!businessId) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, businessId)) return respond.forbidden(req, res);

    const { valid, value, fields } = validate(req.body, CREATE_SCHEMA);
    if (!valid) return respond.invalid(req, res, summarize(fields), fields);

    const result = await query(
      `INSERT INTO categories (business_id, name, sort_order, hidden) VALUES ($1,$2,$3,$4)
       ON CONFLICT (business_id, lower(name)) DO UPDATE SET sort_order = $3, hidden = $4
       RETURNING *`,
      [businessId, value.name, value.sort_order, value.hidden]
    );
    return respond.ok(req, res, { category: result.rows[0] }, { status: 201 });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /categories', err);
  }
});

/** PATCH /api/categories/:id — { name?, sort_order?, hidden? } */
router.patch('/:id', requirePermission('products', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM categories WHERE id = $1', [req.params.id]);
    const category = existing.rows[0];
    if (!category) return respond.notFound(req, res, 'Category');
    if (tenantBlocksBusinessId(req, category.business_id)) return respond.forbidden(req, res);

    // partial: only the keys actually sent are validated or written. `name`
    // is marked required in the schema so that SENDING it empty is an error
    // ("name cannot be empty"), while omitting it is fine.
    const { valid, value, fields } = validate(req.body, PATCH_SCHEMA, { partial: true });
    if (!valid) return respond.invalid(req, res, summarize(fields), fields);

    const sets = [];
    const params = [req.params.id];
    for (const col of ['name', 'sort_order', 'hidden']) {
      if (col in value) {
        params.push(value[col]);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (!sets.length) {
      return respond.invalid(req, res, 'No fields to update');
    }

    const result = await query(`UPDATE categories SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    return respond.ok(req, res, { category: result.rows[0] });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'PATCH /categories/:id', err);
  }
});

/** DELETE /api/categories/:id — removes display metadata only; products keep their category text. */
router.delete('/:id', requirePermission('products', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM categories WHERE id = $1', [req.params.id]);
    const category = existing.rows[0];
    if (!category) return respond.notFound(req, res, 'Category');
    if (tenantBlocksBusinessId(req, category.business_id)) return respond.forbidden(req, res);

    await query('DELETE FROM categories WHERE id = $1', [req.params.id]);
    return respond.ok(req, res, {});
  } catch (err) {
    return respond.failInternal(req, res, logger, 'DELETE /categories/:id', err);
  }
});

/**
 * POST /api/categories/reorder — { business_id?, order: [name, name, ...] }
 * Bulk-sets sort_order to each name's index; upserts any name not yet tracked.
 */
router.post('/reorder', requirePermission('products', 'write'), async (req, res) => {
  try {
    const businessId = req.body?.business_id || req.auth?.businessId;
    if (!businessId) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, businessId)) return respond.forbidden(req, res);

    const { valid, value, fields } = validate(req.body, REORDER_SCHEMA);
    const order = value.order || [];
    if (!valid || !order.length || order.length > REORDER_MAX) {
      const message = `order must be a non-empty array of category names (max ${REORDER_MAX})`;
      return respond.invalid(req, res, message,
        Object.keys(fields).length ? fields : { order: message });
    }

    // All-or-nothing: a failure partway through must not leave the category
    // ordering half-applied.
    await transaction(async client => {
      for (let i = 0; i < order.length; i++) {
        const name = order[i];
        if (!name) continue;
        await client.query(
          `INSERT INTO categories (business_id, name, sort_order) VALUES ($1,$2,$3)
           ON CONFLICT (business_id, lower(name)) DO UPDATE SET sort_order = $3`,
          [businessId, name, i]
        );
      }
    });
    const result = await query(
      'SELECT * FROM categories WHERE business_id = $1 ORDER BY sort_order ASC, name ASC',
      [businessId]
    );
    return respond.ok(req, res, { categories: result.rows });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /categories/reorder', err);
  }
});

module.exports = router;
