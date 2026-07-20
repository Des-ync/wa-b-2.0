/**
 * Role-based capability matrix. Deliberately coarse — four roles, a handful
 * of named capability areas — covering the sensitive actions this app
 * actually gates (financial moves, settings, promos, staff/key management),
 * not a full per-route matrix for the entire API surface. 'owner' always has
 * every capability, matching how every pre-existing API key (role defaults
 * to 'owner' in the DB) keeps exactly the access it always had.
 */

const ROLES = ['owner', 'manager', 'support', 'accountant'];

// true = full access, 'read' = read-only, false/absent = no access.
const CAPABILITIES = {
  owner: { all: true },
  manager: {
    orders: true, customers: true, products: true, promos: true,
    broadcasts: true, conversations: true, financial: true,
    settings: false, staff: false, billing: 'read'
  },
  support: {
    orders: true, customers: true, conversations: true,
    products: 'read', promos: 'read', broadcasts: false,
    financial: false, settings: false, staff: false, billing: false
  },
  accountant: {
    orders: 'read', customers: 'read', products: 'read', promos: 'read',
    billing: 'read', financial: 'read',
    broadcasts: false, conversations: false, settings: false, staff: false
  }
};

/** Can this role perform `capability` at `mode` ('read' or 'write')? */
function can(role, capability, mode = 'write') {
  const caps = CAPABILITIES[role];
  if (!caps) return false;
  if (caps.all) return true;
  const val = caps[capability];
  if (val === true) return true;
  if (val === 'read') return mode === 'read';
  return false;
}

module.exports = { ROLES, CAPABILITIES, can };
