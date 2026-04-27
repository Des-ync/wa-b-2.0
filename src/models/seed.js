require('dotenv').config();
const { query, transaction, close } = require('../config/database');
const logger = require('../utils/logger');
const { normalizeGhanaPhone, detectNetwork } = require('../utils/helpers');

const PLANS = [
  {
    name: 'starter',
    display_name: 'Starter',
    price_ghs: 150.00,
    max_numbers: 1,
    max_rules: 10,
    max_msgs_month: 500,
    ai_replies: false,
    analytics: false,
    multi_agent: false
  },
  {
    name: 'business',
    display_name: 'Business',
    price_ghs: 350.00,
    max_numbers: 1,
    max_rules: -1,
    max_msgs_month: 2000,
    ai_replies: false,
    analytics: true,
    multi_agent: false
  },
  {
    name: 'pro',
    display_name: 'Pro',
    price_ghs: 700.00,
    max_numbers: 2,
    max_rules: -1,
    max_msgs_month: -1,
    ai_replies: true,
    analytics: true,
    multi_agent: true
  }
];

const SAMPLE_BUSINESS = {
  name: 'Demo Vendor GH',
  owner_name: 'Ama Owusu',
  whatsapp_number: '+233241234567',
  industry: 'food'
};

const SAMPLE_PRODUCTS = [
  { name: 'Jollof Rice (Large)',  description: 'Spicy Ghanaian jollof with chicken',         price_ghs: 45.00, category: 'meals' },
  { name: 'Waakye Special',       description: 'Waakye with egg, gari, fish, and stew',      price_ghs: 35.00, category: 'meals' },
  { name: 'Banku & Tilapia',      description: 'Grilled tilapia with banku and pepper sauce', price_ghs: 70.00, category: 'meals' },
  { name: 'Fried Yam & Chicken',  description: 'Fried yam with shito and grilled chicken',   price_ghs: 50.00, category: 'meals' },
  { name: 'Bottled Water (1.5L)', description: 'Chilled mineral water',                       price_ghs:  5.00, category: 'drinks' },
  { name: 'Sobolo (500ml)',       description: 'Fresh hibiscus drink',                        price_ghs: 10.00, category: 'drinks' }
];

async function upsertPlans() {
  for (const p of PLANS) {
    await query(
      `INSERT INTO plans
        (name, display_name, price_ghs, billing_cycle, max_numbers, max_rules,
         max_msgs_month, ai_replies, analytics, multi_agent, is_active)
       VALUES ($1,$2,$3,'monthly',$4,$5,$6,$7,$8,$9,TRUE)
       ON CONFLICT (name) DO UPDATE SET
         display_name   = EXCLUDED.display_name,
         price_ghs      = EXCLUDED.price_ghs,
         max_numbers    = EXCLUDED.max_numbers,
         max_rules      = EXCLUDED.max_rules,
         max_msgs_month = EXCLUDED.max_msgs_month,
         ai_replies     = EXCLUDED.ai_replies,
         analytics      = EXCLUDED.analytics,
         multi_agent    = EXCLUDED.multi_agent,
         is_active      = TRUE`,
      [
        p.name, p.display_name, p.price_ghs, p.max_numbers, p.max_rules,
        p.max_msgs_month, p.ai_replies, p.analytics, p.multi_agent
      ]
    );
    logger.info('Seeded plan: %s (GHS %s)', p.name, p.price_ghs);
  }
}

async function upsertSampleBusinessAndProducts() {
  const wa = normalizeGhanaPhone(SAMPLE_BUSINESS.whatsapp_number);

  await transaction(async client => {
    const existing = await client.query(
      'SELECT id FROM businesses WHERE whatsapp_number = $1',
      [wa]
    );

    let businessId;
    if (existing.rows.length) {
      businessId = existing.rows[0].id;
      logger.info('Sample business already exists (%s).', businessId);
    } else {
      const inserted = await client.query(
        `INSERT INTO businesses (name, owner_name, whatsapp_number, industry, status)
         VALUES ($1,$2,$3,$4,'trial') RETURNING id`,
        [SAMPLE_BUSINESS.name, SAMPLE_BUSINESS.owner_name, wa, SAMPLE_BUSINESS.industry]
      );
      businessId = inserted.rows[0].id;
      logger.info('Created sample business: %s (%s)', SAMPLE_BUSINESS.name, businessId);
    }

    const productCount = await client.query(
      'SELECT COUNT(*)::int AS c FROM products WHERE business_id = $1',
      [businessId]
    );
    if (productCount.rows[0].c > 0) {
      logger.info('Sample products already seeded (%d existing).', productCount.rows[0].c);
      return;
    }

    for (const p of SAMPLE_PRODUCTS) {
      await client.query(
        `INSERT INTO products (business_id, name, description, price_ghs, category, in_stock)
         VALUES ($1,$2,$3,$4,$5,TRUE)`,
        [businessId, p.name, p.description, p.price_ghs, p.category]
      );
    }
    logger.info('Seeded %d sample products.', SAMPLE_PRODUCTS.length);

    // Network detection (sanity check log)
    logger.info('Sample business network: %s', detectNetwork(wa));
  });
}

async function seed() {
  logger.info('Starting database seed...');
  await upsertPlans();
  await upsertSampleBusinessAndProducts();
  logger.info('Seed completed.');
}

if (require.main === module) {
  seed()
    .then(() => close())
    .then(() => process.exit(0))
    .catch(err => {
      logger.error('Seed failed: %s', err.message, { stack: err.stack });
      close().finally(() => process.exit(1));
    });
}

module.exports = { seed };
