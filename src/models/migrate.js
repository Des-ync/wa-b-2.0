require('dotenv').config();
const { pool, query, close } = require('../config/database');
const logger = require('../utils/logger');

const SQL = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =========================================================================
-- businesses: SME tenants paying for the SaaS
-- =========================================================================
CREATE TABLE IF NOT EXISTS businesses (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            TEXT NOT NULL,
  owner_name      TEXT,
  whatsapp_number TEXT NOT NULL UNIQUE,
  industry        TEXT DEFAULT 'retail',
  status          TEXT DEFAULT 'trial',
  trial_ends_at   TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '14 days'),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_businesses_status ON businesses(status);
CREATE INDEX IF NOT EXISTS idx_businesses_whatsapp ON businesses(whatsapp_number);

-- =========================================================================
-- plans: SaaS pricing tiers
-- =========================================================================
CREATE TABLE IF NOT EXISTS plans (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  price_ghs       NUMERIC(10,2) NOT NULL,
  billing_cycle   TEXT DEFAULT 'monthly',
  max_numbers     INT DEFAULT 1,
  max_rules       INT DEFAULT 10,
  max_msgs_month  INT DEFAULT 500,
  ai_replies      BOOLEAN DEFAULT FALSE,
  analytics       BOOLEAN DEFAULT FALSE,
  multi_agent     BOOLEAN DEFAULT FALSE,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- =========================================================================
-- subscriptions: business <-> plan mapping with billing cycle
-- =========================================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id          UUID REFERENCES businesses(id) ON DELETE CASCADE,
  plan_id              INT REFERENCES plans(id),
  status               TEXT DEFAULT 'pending',
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  next_billing_date    TIMESTAMPTZ,
  retry_count          INT DEFAULT 0,
  last_payment_ref     TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_business ON subscriptions(business_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_next_billing ON subscriptions(next_billing_date);

-- =========================================================================
-- billing_transactions: SaaS fee charge attempts
-- =========================================================================
CREATE TABLE IF NOT EXISTS billing_transactions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id      UUID REFERENCES businesses(id),
  subscription_id  UUID REFERENCES subscriptions(id),
  amount_ghs       NUMERIC(10,2) NOT NULL,
  gateway          TEXT NOT NULL,
  reference        TEXT UNIQUE NOT NULL,
  status           TEXT DEFAULT 'pending',
  gateway_ref      TEXT,
  gateway_response JSONB DEFAULT '{}'::jsonb,
  initiated_at     TIMESTAMPTZ DEFAULT NOW(),
  completed_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_billing_business ON billing_transactions(business_id);
CREATE INDEX IF NOT EXISTS idx_billing_status ON billing_transactions(status);
CREATE INDEX IF NOT EXISTS idx_billing_reference ON billing_transactions(reference);

-- =========================================================================
-- customers: end-users of the SME businesses
-- =========================================================================
CREATE TABLE IF NOT EXISTS customers (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id      UUID REFERENCES businesses(id) ON DELETE CASCADE,
  whatsapp_number  TEXT NOT NULL,
  display_name     TEXT,
  phone_network    TEXT,
  total_orders     INT DEFAULT 0,
  total_spent_ghs  NUMERIC(12,2) DEFAULT 0,
  last_seen_at     TIMESTAMPTZ DEFAULT NOW(),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(business_id, whatsapp_number)
);
CREATE INDEX IF NOT EXISTS idx_customers_business ON customers(business_id);
CREATE INDEX IF NOT EXISTS idx_customers_whatsapp ON customers(whatsapp_number);

-- =========================================================================
-- products: business catalogues
-- =========================================================================
CREATE TABLE IF NOT EXISTS products (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id  UUID REFERENCES businesses(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  price_ghs    NUMERIC(10,2) NOT NULL,
  category     TEXT DEFAULT 'general',
  in_stock     BOOLEAN DEFAULT TRUE,
  image_url    TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_products_business ON products(business_id);
CREATE INDEX IF NOT EXISTS idx_products_in_stock ON products(in_stock);

-- =========================================================================
-- orders: customer purchases via WhatsApp
-- =========================================================================
CREATE TABLE IF NOT EXISTS orders (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id      UUID REFERENCES businesses(id),
  customer_id      UUID REFERENCES customers(id),
  order_number     TEXT UNIQUE NOT NULL,
  status           TEXT DEFAULT 'pending',
  items            JSONB NOT NULL DEFAULT '[]'::jsonb,
  subtotal_ghs     NUMERIC(10,2) DEFAULT 0,
  delivery_fee     NUMERIC(10,2) DEFAULT 0,
  total_ghs        NUMERIC(10,2) DEFAULT 0,
  delivery_address TEXT,
  payment_method   TEXT,
  payment_status   TEXT DEFAULT 'unpaid',
  payment_ref      TEXT,
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_business ON orders(business_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_payment_ref ON orders(payment_ref);

-- =========================================================================
-- conversation_state: per-customer flow tracker
-- =========================================================================
CREATE TABLE IF NOT EXISTS conversation_state (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id      UUID UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
  current_flow     TEXT DEFAULT 'idle',
  current_step     TEXT DEFAULT 'start',
  flow_data        JSONB DEFAULT '{}'::jsonb,
  last_message_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at       TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 minutes'),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conv_state_expires ON conversation_state(expires_at);

-- =========================================================================
-- message_log: full audit trail
-- =========================================================================
CREATE TABLE IF NOT EXISTS message_log (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id    UUID REFERENCES businesses(id),
  customer_id    UUID REFERENCES customers(id),
  direction      TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  message_type   TEXT DEFAULT 'text',
  content        TEXT,
  wa_message_id  TEXT,
  status         TEXT DEFAULT 'sent',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_msglog_business ON message_log(business_id);
CREATE INDEX IF NOT EXISTS idx_msglog_customer ON message_log(customer_id);
CREATE INDEX IF NOT EXISTS idx_msglog_created ON message_log(created_at);

-- =========================================================================
-- updated_at trigger
-- =========================================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'businesses','subscriptions','products','orders','conversation_state'
  ]) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I;', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION set_updated_at();', t, t);
  END LOOP;
END$$;
`;

async function migrate() {
  logger.info('Starting database migration...');
  try {
    await query(SQL);
    logger.info('Migration completed successfully.');
  } catch (err) {
    logger.error('Migration failed: %s', err.message, { stack: err.stack });
    throw err;
  }
}

if (require.main === module) {
  migrate()
    .then(() => close())
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { migrate };
