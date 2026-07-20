const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { tenantBlocksBusinessId } = require('../middleware/tenantAccess');

const router = express.Router();

router.use(requireAuth('any'));

/**
 * GET /api/categories?business_id= — display metadata (sort order, hidden)
 * per category name, merged with any product category that hasn't been
 * customized yet (virtual row, id: null, sort_order 0, hidden false) so the
 * dashboard has one place to list and manage every category in use.
 */
router.get('/', async (req, res) => {
  try {
    const businessId = req.query.business_id || req.auth?.businessId;
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const result = await query(
      `SELECT id, name, sort_order, hidden FROM categories WHERE business_id = $1
       UNION ALL
       SELECT NULL, lower(p.category), 0, FALSE
         FROM (SELECT DISTINCT category FROM products WHERE business_id = $1) p
        WHERE lower(p.category) NOT IN (SELECT lower(name) FROM categories WHERE business_id = $1)
       ORDER BY sort_order ASC, name ASC`,
      [businessId]
    );
    res.json({ success: true, categories: result.rows });
  } catch (err) {
    logger.error('GET /categories failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** POST /api/categories — { business_id?, name, sort_order?, hidden? } */
router.post('/', async (req, res) => {
  try {
    const businessId = req.body?.business_id || req.auth?.businessId;
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const name = String(req.body?.name || '').trim().toLowerCase().slice(0, 60);
    if (!name) return res.status(400).json({ success: false, error: 'name is required' });
    const sortOrder = req.body?.sort_order !== undefined ? Number(req.body.sort_order) : 0;
    if (!Number.isInteger(sortOrder)) return res.status(400).json({ success: false, error: 'sort_order must be an integer' });
    const hidden = !!req.body?.hidden;

    const result = await query(
      `INSERT INTO categories (business_id, name, sort_order, hidden) VALUES ($1,$2,$3,$4)
       ON CONFLICT (business_id, lower(name)) DO UPDATE SET sort_order = $3, hidden = $4
       RETURNING *`,
      [businessId, name, sortOrder, hidden]
    );
    res.status(201).json({ success: true, category: result.rows[0] });
  } catch (err) {
    logger.error('POST /categories failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** PATCH /api/categories/:id — { name?, sort_order?, hidden? } */
router.patch('/:id', async (req, res) => {
  try {
    const existing = await query('SELECT * FROM categories WHERE id = $1', [req.params.id]);
    const category = existing.rows[0];
    if (!category) return res.status(404).json({ success: false, error: 'Category not found' });
    if (tenantBlocksBusinessId(req, category.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const sets = [];
    const params = [req.params.id];
    if (req.body?.name !== undefined) {
      const name = String(req.body.name || '').trim().toLowerCase().slice(0, 60);
      if (!name) return res.status(400).json({ success: false, error: 'name cannot be empty' });
      params.push(name);
      sets.push(`name = $${params.length}`);
    }
    if (req.body?.sort_order !== undefined) {
      const n = Number(req.body.sort_order);
      if (!Number.isInteger(n)) return res.status(400).json({ success: false, error: 'sort_order must be an integer' });
      params.push(n);
      sets.push(`sort_order = $${params.length}`);
    }
    if (req.body?.hidden !== undefined) {
      params.push(!!req.body.hidden);
      sets.push(`hidden = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ success: false, error: 'No fields to update' });

    const result = await query(`UPDATE categories SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    res.json({ success: true, category: result.rows[0] });
  } catch (err) {
    logger.error('PATCH /categories/:id failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** DELETE /api/categories/:id — removes display metadata only; products keep their category text. */
router.delete('/:id', async (req, res) => {
  try {
    const existing = await query('SELECT * FROM categories WHERE id = $1', [req.params.id]);
    const category = existing.rows[0];
    if (!category) return res.status(404).json({ success: false, error: 'Category not found' });
    if (tenantBlocksBusinessId(req, category.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    await query('DELETE FROM categories WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    logger.error('DELETE /categories/:id failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/categories/reorder — { business_id?, order: [name, name, ...] }
 * Bulk-sets sort_order to each name's index; upserts any name not yet tracked.
 */
router.post('/reorder', async (req, res) => {
  try {
    const businessId = req.body?.business_id || req.auth?.businessId;
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const order = req.body?.order;
    if (!Array.isArray(order) || !order.length || order.length > 200) {
      return res.status(400).json({ success: false, error: 'order must be a non-empty array of category names (max 200)' });
    }
    for (let i = 0; i < order.length; i++) {
      const name = String(order[i] || '').trim().toLowerCase().slice(0, 60);
      if (!name) continue;
      await query(
        `INSERT INTO categories (business_id, name, sort_order) VALUES ($1,$2,$3)
         ON CONFLICT (business_id, lower(name)) DO UPDATE SET sort_order = $3`,
        [businessId, name, i]
      );
    }
    const result = await query(
      'SELECT * FROM categories WHERE business_id = $1 ORDER BY sort_order ASC, name ASC',
      [businessId]
    );
    res.json({ success: true, categories: result.rows });
  } catch (err) {
    logger.error('POST /categories/reorder failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
