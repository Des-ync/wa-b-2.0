/**
 * Shared customer-segment SQL fragments — used by the customer list filter
 * and by broadcast targeting so "who's in this segment" means the same
 * thing in both places. All fragments reference the customers table via
 * alias `c` and assume `orders`/`conversation_state` are queryable siblings.
 */

const SEGMENTS = {
  ordered_30d: {
    label: 'Ordered in last 30 days',
    sql: `EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.created_at >= NOW() - INTERVAL '30 days')`
  },
  inactive_60d: {
    label: 'Inactive for 60+ days',
    sql: `c.last_seen_at < NOW() - INTERVAL '60 days'`
  },
  abandoned_cart: {
    label: 'Has an abandoned cart',
    sql: `EXISTS (
      SELECT 1 FROM conversation_state cs
       WHERE cs.customer_id = c.id AND cs.current_flow = 'ordering'
         AND jsonb_array_length(COALESCE(cs.flow_data->'cart', '[]'::jsonb)) > 0
    )`
  }
};

/**
 * Build extra WHERE clauses (ANDed together) from an audience filter spec:
 *   { tag?: string, segment?: keyof SEGMENTS, min_spend_ghs?: number }
 * Mutates `params` (pushes bind values) and returns an array of SQL clause
 * strings referencing $N placeholders already correctly numbered against it.
 */
function buildAudienceClauses(filters, params) {
  const clauses = [];
  if (!filters) return clauses;

  if (filters.tag) {
    params.push(String(filters.tag).trim().toLowerCase());
    clauses.push(`$${params.length} = ANY(c.tags)`);
  }
  if (filters.min_spend_ghs != null && filters.min_spend_ghs !== '') {
    const n = Number(filters.min_spend_ghs);
    if (Number.isFinite(n) && n >= 0) {
      params.push(n);
      clauses.push(`c.total_spent_ghs >= $${params.length}`);
    }
  }
  if (filters.segment && SEGMENTS[filters.segment]) {
    clauses.push(SEGMENTS[filters.segment].sql);
  }
  return clauses;
}

/** Human-readable description of a filter spec, for broadcast history/audit. */
function describeAudience(filters) {
  if (!filters || (!filters.tag && !filters.segment && filters.min_spend_ghs == null)) {
    return 'All opted-in customers';
  }
  const parts = [];
  if (filters.segment && SEGMENTS[filters.segment]) parts.push(SEGMENTS[filters.segment].label);
  if (filters.tag) parts.push(`tag "${filters.tag}"`);
  if (filters.min_spend_ghs != null && filters.min_spend_ghs !== '') parts.push(`spent ≥ GH₵${Number(filters.min_spend_ghs).toFixed(2)}`);
  return parts.join(' + ') || 'All opted-in customers';
}

module.exports = { SEGMENTS, buildAudienceClauses, describeAudience };
