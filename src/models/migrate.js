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
  -- Instagram Messaging: the IG business account id that receives DMs for this
  -- tenant (routes inbound IG webhooks), and its page access token (optional;
  -- falls back to env IG_ACCESS_TOKEN). NULL until the merchant connects IG.
  ig_business_account_id TEXT UNIQUE,
  ig_page_access_token   TEXT,
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
-- Instagram DM channel (upgrade path for existing databases).
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ig_business_account_id TEXT UNIQUE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ig_page_access_token TEXT;
-- Merchant-configurable bot settings (upgrade path for existing databases).
-- welcome_message: branded greeting shown instead of the stock welcome.
-- support_phone: number handed out on "Talk to us" (falls back to whatsapp_number).
-- delivery_fee_ghs: flat delivery fee used when no zones are configured.
-- delivery_zones: JSONB array of { name, fee_ghs } offered at checkout.
-- open_time/close_time: 'HH:MM' business hours in Africa/Accra; NULL = always open.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS welcome_message TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS support_phone TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS delivery_fee_ghs NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS delivery_zones JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS open_time TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS close_time TEXT;
-- Customer-facing bot language: 'en' | 'tw' (Twi). Merchant flows stay English.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS bot_language TEXT NOT NULL DEFAULT 'en';

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
  -- Multi-channel identity. channel_id is the channel-native identifier:
  -- the WhatsApp number for 'whatsapp', the IG-scoped user id for 'instagram'.
  -- whatsapp_number stays as-is for backward compatibility.
  channel          TEXT NOT NULL DEFAULT 'whatsapp',
  channel_id       TEXT,
  total_orders     INT NOT NULL DEFAULT 0 CHECK (total_orders >= 0),
  total_spent_ghs  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total_spent_ghs >= 0),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(business_id, whatsapp_number)
);
CREATE INDEX IF NOT EXISTS idx_customers_business ON customers(business_id);
CREATE INDEX IF NOT EXISTS idx_customers_whatsapp ON customers(whatsapp_number);
-- Multi-channel identity (upgrade path for existing databases).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS channel_id TEXT;
-- Backfill: pre-existing rows are WhatsApp customers keyed on their number.
UPDATE customers SET channel_id = whatsapp_number WHERE channel_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_business_channel_id
  ON customers(business_id, channel, channel_id);
-- Human takeover: when TRUE, the state machine stops auto-replying to this
-- customer so a merchant can answer manually from the dashboard inbox.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS bot_paused BOOLEAN NOT NULL DEFAULT FALSE;
-- Broadcast opt-out (WhatsApp "STOP"). Strictly enforced — never broadcast to
-- an opted-out customer, regardless of who's sending.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS opted_out BOOLEAN NOT NULL DEFAULT FALSE;

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
-- Stock quantity tracking (upgrade path). NULL = untracked/unlimited stock,
-- matching every existing product's behavior exactly. A non-null value is
-- decremented on payment and auto-clears in_stock at zero.
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_qty INT CHECK (stock_qty IS NULL OR stock_qty >= 0);
-- Merchant is warned once per dip below the threshold, not on every sale.
ALTER TABLE products ADD COLUMN IF NOT EXISTS low_stock_notified BOOLEAN NOT NULL DEFAULT FALSE;

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
-- Discount code applied at checkout (upgrade path for existing databases).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_code TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_ghs NUMERIC(10,2) NOT NULL DEFAULT 0;

-- =========================================================================
-- payment_attempts: EVERY payment reference ever issued for an order.
-- orders.payment_ref only tracks the LATEST attempt; when a customer retries
-- payment, the earlier still-live gateway charge keeps its old reference.
-- Without this table a success webhook for that old reference finds no order
-- and the money silently vanishes from our books.
-- =========================================================================
CREATE TABLE IF NOT EXISTS payment_attempts (
  reference   TEXT PRIMARY KEY,
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_order ON payment_attempts(order_id);
-- Backfill: pre-existing orders' current refs stay resolvable.
INSERT INTO payment_attempts (reference, order_id, method)
SELECT payment_ref, id, payment_method FROM orders WHERE payment_ref IS NOT NULL
ON CONFLICT (reference) DO NOTHING;

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
-- Cart-abandonment recovery: when the idle-cart nudge was last sent, so each
-- abandoned cart gets at most one reminder (upgrade path for existing DBs).
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS nudge_sent_at TIMESTAMPTZ;

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
  source          TEXT NOT NULL CHECK (source IN ('whatsapp','paystack','hubtel','pawapay','instagram')),
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
-- business_link_otps: WhatsApp-delivered OTP proving a Clerk user actually
-- controls the phone number they're claiming to link a business with.
-- One active challenge per (business, clerk user); a fresh request
-- overwrites the previous code rather than stacking rows.
-- =========================================================================
CREATE TABLE IF NOT EXISTS business_link_otps (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id    UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  clerk_user_id  TEXT NOT NULL,
  code_hash      TEXT NOT NULL,
  attempts       INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, clerk_user_id)
);
CREATE INDEX IF NOT EXISTS idx_link_otps_business ON business_link_otps(business_id);
CREATE INDEX IF NOT EXISTS idx_link_otps_expires ON business_link_otps(expires_at);

-- =========================================================================
-- promos: discount codes applied at cart checkout
-- =========================================================================
CREATE TABLE IF NOT EXISTS promos (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  code         TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('percent','fixed')),
  value        NUMERIC(10,2) NOT NULL CHECK (value > 0),
  expires_at   TIMESTAMPTZ,
  max_uses     INT CHECK (max_uses IS NULL OR max_uses > 0),
  used_count   INT NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, code)
);
CREATE INDEX IF NOT EXISTS idx_promos_business ON promos(business_id);

-- =========================================================================
-- broadcasts / broadcast_recipients: merchant-initiated re-engagement blasts.
-- Recipients are fanned out up front (one row per opted-in customer) and
-- drained by a rate-limited cron so a single request never sends thousands
-- of messages synchronously or blows through Meta's rate limits.
-- =========================================================================
CREATE TABLE IF NOT EXISTS broadcasts (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','sending','done','failed')),
  target_count  INT NOT NULL DEFAULT 0,
  sent_count    INT NOT NULL DEFAULT 0,
  failed_count  INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_broadcasts_business ON broadcasts(business_id);

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  broadcast_id  UUID NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  -- 'sending' is a claim state: the sender cron atomically flips a batch of
  -- 'pending' rows to 'sending' in one UPDATE so two overlapping cron ticks
  -- (or replicas) can never double-send the same recipient.
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','sending','sent','failed')),
  sent_at       TIMESTAMPTZ,
  UNIQUE (broadcast_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_pending
  ON broadcast_recipients(broadcast_id) WHERE status = 'pending';
-- Upgrade path: widen the status CHECK to include the 'sending' claim state
-- for any DB where this table was already created with the older 3-value set.
ALTER TABLE broadcast_recipients DROP CONSTRAINT IF EXISTS broadcast_recipients_status_check;
ALTER TABLE broadcast_recipients ADD CONSTRAINT broadcast_recipients_status_check
  CHECK (status IN ('pending','sending','sent','failed'));

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
  CHECK (source IN ('whatsapp','paystack','hubtel','pawapay','instagram'));

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
