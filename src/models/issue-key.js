/**
 * Issue an API key from the CLI.
 *
 * Usage:
 *   node src/models/issue-key.js admin "ops dashboard"
 *   node src/models/issue-key.js tenant <business-uuid> "POS station 1"
 */
require('dotenv').config();
const { issueKey } = require('../middleware/auth');
const { close } = require('../config/database');
const logger = require('../utils/logger');

async function main() {
  const [, , scope, ...rest] = process.argv;
  if (!scope || !['admin', 'tenant'].includes(scope)) {
    console.error('Usage: node src/models/issue-key.js <admin|tenant> [business_id] <name>');
    process.exit(2);
  }

  let businessId = null;
  let name;
  if (scope === 'tenant') {
    if (rest.length < 2) {
      console.error('Tenant keys require: <business_id> "<name>"');
      process.exit(2);
    }
    businessId = rest.shift();
    name = rest.join(' ');
  } else {
    name = rest.join(' ');
  }
  if (!name) {
    console.error('Name required');
    process.exit(2);
  }

  try {
    const key = await issueKey({ name, businessId, scope });
    console.log('\nAPI key issued. Save it now — it will not be shown again:\n');
    console.log('  ' + key.plaintext + '\n');
    console.log('  id:          ' + key.id);
    console.log('  scope:       ' + key.scope);
    if (businessId) console.log('  business_id: ' + key.business_id);
    console.log('  name:        ' + key.name);
  } catch (err) {
    logger.error('Issue key failed: %s', err.message);
    process.exitCode = 1;
  } finally {
    await close().catch(() => {});
  }
}

main();
