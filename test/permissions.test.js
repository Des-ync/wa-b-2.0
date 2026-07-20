const test = require('node:test');
const assert = require('node:assert/strict');

const { can, ROLES, CAPABILITIES } = require('../src/utils/permissions');

test('owner can do anything, for any capability and mode', () => {
  for (const cap of ['orders', 'settings', 'staff', 'financial', 'billing', 'nonexistent_capability']) {
    assert.equal(can('owner', cap, 'write'), true);
    assert.equal(can('owner', cap, 'read'), true);
  }
});

test('manager can write orders/customers/products/promos but not settings or staff', () => {
  assert.equal(can('manager', 'orders', 'write'), true);
  assert.equal(can('manager', 'customers', 'write'), true);
  assert.equal(can('manager', 'promos', 'write'), true);
  assert.equal(can('manager', 'settings', 'write'), false);
  assert.equal(can('manager', 'staff', 'write'), false);
});

test('manager has read-only billing access', () => {
  assert.equal(can('manager', 'billing', 'read'), true);
  assert.equal(can('manager', 'billing', 'write'), false);
});

test('support can handle orders/customers/conversations but not products or financial actions', () => {
  assert.equal(can('support', 'orders', 'write'), true);
  assert.equal(can('support', 'conversations', 'write'), true);
  assert.equal(can('support', 'financial', 'write'), false);
  assert.equal(can('support', 'products', 'read'), true);
  assert.equal(can('support', 'products', 'write'), false);
});

test('accountant is read-only everywhere it has access, and has none of the write-only areas', () => {
  for (const cap of ['orders', 'customers', 'products', 'promos', 'billing', 'financial']) {
    assert.equal(can('accountant', cap, 'read'), true);
    assert.equal(can('accountant', cap, 'write'), false);
  }
  assert.equal(can('accountant', 'settings', 'read'), false);
  assert.equal(can('accountant', 'staff', 'read'), false);
});

test('an unknown role has no capabilities at all', () => {
  assert.equal(can('rogue_role', 'orders', 'read'), false);
  assert.equal(can(undefined, 'orders', 'read'), false);
  assert.equal(can(null, 'orders', 'write'), false);
});

test('every non-owner role denies staff management (only the owner can manage staff/keys)', () => {
  for (const role of ROLES.filter(r => r !== 'owner')) {
    assert.equal(can(role, 'staff', 'write'), false);
    assert.equal(can(role, 'staff', 'read'), false);
  }
});

test('CAPABILITIES defines exactly the four expected roles', () => {
  assert.deepEqual(Object.keys(CAPABILITIES).sort(), ['accountant', 'manager', 'owner', 'support']);
  assert.deepEqual(ROLES.slice().sort(), ['accountant', 'manager', 'owner', 'support']);
});
