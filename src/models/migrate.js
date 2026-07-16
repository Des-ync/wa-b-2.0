require('dotenv').config();
const { pool, query, close } = require('../config/database');
const logger = require('../utils/logger');

const SQL = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =========================================================================
-- businesses: SME tenants paying for the SaaS
-- =========================================================================
CREATE TABLE IF NOT EXISTS businesses (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                TEXT NOT NULL,
  owner_name          TEXT,
  whatsapp_number     TEXT NOT NULL UNIQUE,
  -- Meta WhatsApp Cloud API phone_number_id — used to route inbound webhooks to the right tenant.
  wa_phone_number_id  TEXT UNIQUE,
  -- Per-tenant Meta access token (optional; falls back to env WA_ACCESS_TOKEN).
  wa_access_token     TEXT,
  -- Clerk user id of the merchant who owns this business's dashboard login.
  -- NULL until the merchant links their Clerk account (see /api/auth/clerk/link).
  clerk_user_id       TEXT UNIQUE,
  industry            TEXT DEFAULT 'retail',
  status              TEXT NOT NULL DEFAULT 'trial'
                      CHECK (status IN ('trial','active','grace','suspended','cancelled')),
  trial_ends_at       TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '14 days'),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_businesses_status ON businesses(status);
CREATE INDEX IF NOT EXISTS idx_businesses_whatsapp ON businesses(whatsapp_number);
CREATE INDEX IF NOT EXISTS idx_businesses_wa_phone_id ON businesses(wa_phone_number_id);
-- Trial lifecycle notifications (upgrade path for existing databases).
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS trial_reminder_sent_at TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS trial_expired_notified_at TIMESTAMPTZ;
-- Clerk dashboard login (upgrade path for existing databases).
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS clerk_user_id TEXT UNIQUE;

-- =========================================================================
-- plans: SaaS pricing tiers
-- =========================================================================
CREATE TABLE IF NOT EXISTS plans (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  price_ghs       NUMERIC(10,2) NOT NULL CHECK (price_ghs >= 0),
  billing_cycle   TEXT NOT NULL DEFAULT 'monthly'
                  CHECK (billing_cycle IN ('monthly','quarterly','yearly')),
  max_numbers     INT NOT NULL DEFAULT 1 CHECK (max_numbers >= 1),
  max_rules       INT NOT NULL DEFAULT 10 CHECK (max_rules = -1 OR max_rules >= 0),
  max_msgs_month  INT NOT NULL DEFAULT 500 CHECK (max_msgs_month = -1 OR max_msgs_month >= 0),
  ai_replies      BOOLEAN NOT NULL DEFAULT FALSE,
  analytics       BOOLEAN NOT NULL DEFAULT FALSE,
  multi_agent     BOOLEAN NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================================
-- subscriptions: business <-> plan mapping with billing cycle
-- =========================================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id          UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  plan_id              INT  NOT NULL REFERENCES plans(id),
  -- Plan change requested but not yet paid for. Applied to plan_id when the
  -- charge succeeds; cleared when it fails. plan_id itself only ever reflects
  -- a plan the business has actually paid for (or the initial signup choice).
  pending_plan_id      INT REFERENCES plans(id),
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','active','grace','suspended','cancelled','pending_cancel')),
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  next_billing_date    TIMESTAMPTZ,
  retry_count          INT NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled_at         TIMESTAMPTZ,
  last_payment_ref     TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Upgrade path for databases created before pending_plan_id existed.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pending_plan_id INT REFERENCES plans(id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_business ON subscriptions(business_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_next_billing ON subscriptions(next_billing_date);

-- =========================================================================
-- billing_transactions: SaaS fee charge attempts
-- =========================================================================
CREATE TABLE IF NOT EXISTS billing_transactions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id      UUID NOT NULL REFERENCES businesses(id),
  subscription_id  UUID NOT NULL REFERENCES subscriptions(id),
  amount_ghs       NUMERIC(10,2) NOT NULL CHECK (amount_ghs >= 0),
  gateway          TEXT NOT NULL CHECK (gateway IN ('hubtel','paystack','pawapay')),
  reference        TEXT UNIQUE NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','success','failed','cancelled')),
  gateway_ref      TEXT,
  gateway_response JSONB NOT NULL DEFAULT '{}'::jsonb,
  initiated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_billing_business ON billing_transactions(business_id);
CREATE INDEX IF NOT EXISTS idx_billing_status ON billing_transactions(status);
CREATE INDEX IF NOT EXISTS idx_billing_reference ON billing_transactions(reference);

-- Only one pending billing transaction per subscription at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_pending_per_subscription
  ON billing_transactions(subscription_id)
  WHERE status = 'pending';

-- =========================================================================
-- customers: end-users of the SME businesses
-- =========================================================================
CREATE TABLE IF NOT EXISTS customers (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  whatsapp_number  TEXT NOT NULL,
  display_name     TEXT,
  phone_network    TEXT CHECK (phone_network IS NULL
                                OR phone_network IN ('mtn','vodafone','airteltigo','other')),
  total_orders     INT NOT NULL DEFAULT 0 CHECK (total_orders >= 0),
  total_spent_ghs  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total_spent_ghs >= 0),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(business_id, whatsapp_number)
);
CREATE INDEX IF NOT EXISTS idx_customers_business ON customers(business_id);
CREATE INDEX IF NOT EXISTS idx_customers_whatsapp ON customers(whatsapp_number);

-- =========================================================================
-- products: business catalogues
-- =========================================================================
CREATE TABLE IF NOT EXISTS products (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  price_ghs    NUMERIC(10,2) NOT NULL CHECK (price_ghs >= 0),
  category     TEXT NOT NULL DEFAULT 'general',
  in_stock     BOOLEAN NOT NULL DEFAULT TRUE,
  image_url    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_products_business ON products(business_id);
CREATE INDEX IF NOT EXISTS idx_products_in_stock ON products(in_stock);

-- =========================================================================
-- orders: customer purchases via WhatsApp
-- =========================================================================
CREATE TABLE IF NOT EXISTS orders (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id      UUID NOT NULL REFERENCES businesses(id),
  customer_id      UUID NOT NULL REFERENCES customers(id),
  order_number     TEXT UNIQUE NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','confirmed','paid','preparing','ready','delivered','cancelled')),
  items            JSONB NOT NULL DEFAULT '[]'::jsonb,
  subtotal_ghs     NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (subtotal_ghs >= 0),
  delivery_fee     NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (delivery_fee >= 0),
  total_ghs        NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (total_ghs >= 0),
  delivery_address TEXT,
  payment_method   TEXT CHECK (payment_method IS NULL
                                OR payment_method IN ('momo','card','cash')),
  payment_status   TEXT NOT NULL DEFAULT 'unpaid'
                   CHECK (payment_status IN ('unpaid','pending','paid','refunded','failed')),
  payment_ref      TEXT UNIQUE,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  customer_id      UUID UNIQUE NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  current_flow     TEXT NOT NULL DEFAULT 'idle'
                   CHECK (current_flow IN ('idle','browsing','ordering','paying','support')),
  current_step     TEXT NOT NULL DEFAULT 'start',
  flow_data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_message_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes'),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conv_state_expires ON conversation_state(expires_at);

-- =========================================================================
-- message_log: full audit trail (de-duplicated by wa_message_id when present)
-- =========================================================================
CREATE TABLE IF NOT EXISTS message_log (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id    UUID REFERENCES businesses(id),
  customer_id    UUID REFERENCES customers(id),
  direction      TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  message_type   TEXT NOT NULL DEFAULT 'text',
  content        TEXT,
  wa_message_id  TEXT,
  status         TEXT NOT NULL DEFAULT 'sent'
                 CHECK (status IN ('sent','delivered','read','failed','received')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_msglog_business ON message_log(business_id);
CREATE INDEX IF NOT EXISTS idx_msglog_customer ON message_log(customer_id);
CREATE INDEX IF NOT EXISTS idx_msglog_created ON message_log(created_at);
-- Unique on wa_message_id (when not null) to deduplicate inbound webhook replays.
CREATE UNIQUE INDEX IF NOT EXISTS uq_msglog_wa_message_id
  ON message_log(wa_message_id)
  WHERE wa_message_id IS NOT NULL;

-- =========================================================================
-- webhook_events: durable inbound queue with idempotency
-- =========================================================================
CREATE TABLE IF NOT EXISTS webhook_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source          TEXT NOT NULL CHECK (source IN ('whatsapp','paystack','hubtel','pawapay')),
  external_id     TEXT NOT NULL,
  payload         JSONB NOT NULL,
  signature_valid BOOLEAN NOT NULL DEFAULT TRUE,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','done','failed','duplicate')),
  attempts        INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error      TEXT,
  locked_at       TIMESTAMPTZ,
  locked_by       TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_status_next
  ON webhook_events(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_webhook_events_received
  ON webhook_events(received_at);

-- =========================================================================
-- worker_locks: cooperative single-leader cron lock
-- =========================================================================
CREATE TABLE IF NOT EXISTS worker_locks (
  job_name    TEXT PRIMARY KEY,
  locked_by   TEXT NOT NULL,
  locked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);

-- =========================================================================
-- api_keys: hashed credentials for admin + tenant-scoped API access.
-- The plaintext key is shown only at creation time; only the SHA-256 hash
-- is stored. business_id NULL means an admin/global key.
-- =========================================================================
CREATE TABLE IF NOT EXISTS api_keys (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id  UUID REFERENCES businesses(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  scope        TEXT NOT NULL DEFAULT 'tenant'
               CHECK (scope IN ('admin','tenant')),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_business ON api_keys(business_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active   ON api_keys(scope) WHERE revoked_at IS NULL;

-- =========================================================================
-- Upgrade path: databases created before the pawaPay gateway existed carry
-- CHECK constraints without 'pawapay'. Drop-and-recreate is re-runnable.
-- =========================================================================
ALTER TABLE billing_transactions DROP CONSTRAINT IF EXISTS billing_transactions_gateway_check;
ALTER TABLE billing_transactions ADD CONSTRAINT billing_transactions_gateway_check
  CHECK (gateway IN ('hubtel','paystack','pawapay'));
ALTER TABLE webhook_events DROP CONSTRAINT IF EXISTS webhook_events_source_check;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_source_check
  CHECK (source IN ('whatsapp','paystack','hubtel','pawapay'));

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
