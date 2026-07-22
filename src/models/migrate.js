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
-- Facebook Messenger channel (upgrade path for existing databases). Same
-- credential shape as Instagram: a Page-scoped id that routes inbound
-- webhooks, and its Page access token (falls back to env MESSENGER_ACCESS_TOKEN).
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS messenger_page_id TEXT UNIQUE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS messenger_page_access_token TEXT;
-- Public storefront handle (e.g. sikabook.com/store/mikes-shop). NULL until
-- backfilled/chosen; merchant-editable via PATCH /api/business/settings.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS slug TEXT UNIQUE;
CREATE INDEX IF NOT EXISTS idx_businesses_slug ON businesses(slug);
-- Backfill: name-derived slug + short id suffix guarantees uniqueness without
-- a collision-retry loop. Existing businesses get a stable, if unglamorous,
-- storefront URL immediately; merchants can rename it any time after.
UPDATE businesses
   SET slug = LOWER(REGEXP_REPLACE(TRIM(name), '[^a-zA-Z0-9]+', '-', 'g')) || '-' || SUBSTRING(id::text, 1, 6)
 WHERE slug IS NULL;
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
-- Onboarding: where settlement payouts land, and proof the merchant fired a
-- test message end-to-end (upgrade path for existing databases).
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS payout_momo_number TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS payout_momo_network TEXT
  CHECK (payout_momo_network IS NULL OR payout_momo_network IN ('mtn','vodafone','airteltigo'));
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS onboarding_test_message_sent_at TIMESTAMPTZ;

-- Loyalty & rewards program settings, per business. All amounts/rates are
-- merchant-configurable; 0 or a 0-length JSON array disables that mechanic.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS loyalty_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS loyalty_points_per_ghs NUMERIC(6,2) NOT NULL DEFAULT 1 CHECK (loyalty_points_per_ghs >= 0);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS loyalty_points_redemption_rate_ghs NUMERIC(8,4) NOT NULL DEFAULT 0.05 CHECK (loyalty_points_redemption_rate_ghs >= 0);
-- "Buy N, get 1 free": 0 = disabled. free_item_value_ghs is the fixed
-- discount granted when a customer's stamp count reaches the target.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS loyalty_stamps_target INT NOT NULL DEFAULT 0 CHECK (loyalty_stamps_target >= 0);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS loyalty_free_item_value_ghs NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (loyalty_free_item_value_ghs >= 0);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS loyalty_referral_reward_ghs NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (loyalty_referral_reward_ghs >= 0);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS loyalty_birthday_discount_type TEXT NOT NULL DEFAULT 'percent'
  CHECK (loyalty_birthday_discount_type IN ('percent','fixed'));
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS loyalty_birthday_discount_value NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (loyalty_birthday_discount_value >= 0);
-- VIP tiers: [{ "name": "Silver", "min_spend_ghs": 200 }, ...] — purely
-- derived display, no separate storage of "which tier a customer is in".
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS loyalty_vip_tiers JSONB NOT NULL DEFAULT '[]'::jsonb;

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
-- Free-form merchant tags (VIP, wholesale, delivery area, high-risk, ...) —
-- not a fixed enum, merchants coin their own.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_customers_tags ON customers USING GIN (tags);
-- Per-customer language, auto-detected from what they actually type (see
-- detectLikelyLanguage in utils/i18n.js) and overriding the shop's default
-- bot_language for that one customer — a Twi-typing customer gets Twi
-- replies even if the shop's default is English, and vice versa.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS language_override TEXT
  CHECK (language_override IS NULL OR language_override IN ('en','tw'));
-- Loyalty & rewards state.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS loyalty_points INT NOT NULL DEFAULT 0 CHECK (loyalty_points >= 0);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS loyalty_stamps INT NOT NULL DEFAULT 0 CHECK (loyalty_stamps >= 0);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS referred_by_customer_id UUID REFERENCES customers(id);
-- Set once the referrer's reward has been granted, so a referred customer's
-- SECOND, THIRD, ... paid order can never re-trigger the referrer's reward.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS referral_reward_granted_at TIMESTAMPTZ;
-- Last delivery address that successfully cleared checkout — offered back
-- as a one-tap default on the next order instead of re-typing every time.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS address TEXT;

-- =========================================================================
-- customer_rewards: issued, per-customer redemption codes — stamp free
-- items, referral credit, birthday coupons, and manual points redemptions.
-- Redeemed the same way as a promos.code at checkout (see
-- order.service.js#validatePromoCode), but scoped to one customer so a
-- reward can't be shared/guessed by anyone else.
-- =========================================================================
CREATE TABLE IF NOT EXISTS customer_rewards (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id    UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id    UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN ('stamp_free_item','referral_credit','birthday_coupon','points_redemption')),
  code           TEXT NOT NULL,
  description    TEXT,
  discount_type  TEXT NOT NULL CHECK (discount_type IN ('percent','fixed')),
  discount_value NUMERIC(10,2) NOT NULL CHECK (discount_value > 0),
  redeemed_at    TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, code)
);
CREATE INDEX IF NOT EXISTS idx_customer_rewards_customer ON customer_rewards(customer_id);

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
-- Catalog upgrades: per-product low-stock threshold (was a hard-coded "3"),
-- featured/hidden display flags, manual sort order within a category, and an
-- optional daily availability window ('07:00'..'11:00' for a breakfast menu;
-- both NULL = always available whenever open).
ALTER TABLE products ADD COLUMN IF NOT EXISTS low_stock_threshold INT NOT NULL DEFAULT 3 CHECK (low_stock_threshold >= 0);
ALTER TABLE products ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS available_from TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS available_to TEXT;
CREATE INDEX IF NOT EXISTS idx_products_hidden ON products(hidden);

-- =========================================================================
-- categories: per-business display metadata for products.category (free
-- text on products; this table only carries sort order / visibility so
-- existing category strings never need a backfill or FK migration).
-- =========================================================================
CREATE TABLE IF NOT EXISTS categories (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  sort_order   INT NOT NULL DEFAULT 0,
  hidden       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_business_name ON categories(business_id, lower(name));

-- =========================================================================
-- product_variants: size/color/flavor/bundle options. price_delta_ghs is
-- added to the product's base price_ghs; stock_qty NULL = untracked, same
-- convention as products.stock_qty.
-- =========================================================================
CREATE TABLE IF NOT EXISTS product_variants (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  price_delta_ghs NUMERIC(10,2) NOT NULL DEFAULT 0,
  stock_qty       INT CHECK (stock_qty IS NULL OR stock_qty >= 0),
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_product_variants_product ON product_variants(product_id);

-- =========================================================================
-- product_addons: optional extras ("extra chicken", "delivery insurance").
-- =========================================================================
CREATE TABLE IF NOT EXISTS product_addons (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id   UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  price_ghs    NUMERIC(10,2) NOT NULL DEFAULT 0,
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_product_addons_product ON product_addons(product_id);

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
-- Order lifecycle: merchant-only notes, cancellation reason, prep/delivery
-- ETAs, rider assignment, and delivery proof (upgrade path for existing DBs).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS internal_notes TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS estimated_ready_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS estimated_delivery_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_phone TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'unassigned'
  CHECK (delivery_status IN ('unassigned','assigned','picked_up','delivered'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_proof_url TEXT;

-- =========================================================================
-- order_status_history: append-only timeline for the order detail page.
-- One row per status change, delivery update, or refund — not just the
-- current status column, which only ever shows the latest value.
-- =========================================================================
CREATE TABLE IF NOT EXISTS order_status_history (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event       TEXT NOT NULL,
  note        TEXT,
  changed_by  TEXT NOT NULL DEFAULT 'system' CHECK (changed_by IN ('system','merchant','customer')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_order_status_history_order ON order_status_history(order_id, created_at);

-- =========================================================================
-- order_refunds: partial/full refunds with a reason, separate from the
-- order's own payment_status so multiple partial refunds can be tracked.
-- =========================================================================
CREATE TABLE IF NOT EXISTS order_refunds (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  amount_ghs    NUMERIC(12,2) NOT NULL CHECK (amount_ghs > 0),
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','failed')),
  gateway_ref   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_order_refunds_order ON order_refunds(order_id);

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
-- How many nudges this cart has received so far, checked against the
-- business's cart_nudge_max_per_cart setting.
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS nudge_count INT NOT NULL DEFAULT 0;

-- Per-business cart-abandonment recovery settings.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS cart_nudge_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS cart_nudge_delay_minutes INT NOT NULL DEFAULT 60
  CHECK (cart_nudge_delay_minutes BETWEEN 5 AND 1440);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS cart_nudge_max_per_cart INT NOT NULL DEFAULT 1
  CHECK (cart_nudge_max_per_cart BETWEEN 1 AND 5);
-- Custom nudge copy; NULL falls back to the built-in i18n template. Supports
-- {shop} and {count} placeholders. _template_b enables a simple 50/50 A/B
-- test (variant assigned once per customer, deterministically).
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS cart_nudge_message_template TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS cart_nudge_template_b TEXT;
-- Promo code text (not FK'd to promos — a merchant may delete/expire the
-- promo independently; the nudge just stops mentioning a coupon that 404s).
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS cart_nudge_coupon_code TEXT;

-- =========================================================================
-- cart_nudges: one row per reminder actually sent, for recovered-revenue
-- and A/B analytics. cart_value_ghs is a snapshot at send time.
-- =========================================================================
CREATE TABLE IF NOT EXISTS cart_nudges (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id    UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id    UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  nudge_number   INT NOT NULL,
  variant        TEXT NOT NULL DEFAULT 'a' CHECK (variant IN ('a','b')),
  coupon_code    TEXT,
  cart_value_ghs NUMERIC(12,2) NOT NULL DEFAULT 0,
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cart_nudges_business_sent ON cart_nudges(business_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_cart_nudges_customer ON cart_nudges(customer_id);

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
-- Raw signature header the provider sent, kept for audit/debugging — e.g.
-- confirming a "signature invalid" rejection wasn't a header-parsing bug.
-- Never populated for /reject paths (bad signatures are 401'd before any
-- INSERT), only for events that made it into the queue.
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS signature_header TEXT;

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
-- Targeting rules — all optional, ANDed together when set (upgrade path).
ALTER TABLE promos ADD COLUMN IF NOT EXISTS min_order_ghs NUMERIC(10,2) CHECK (min_order_ghs IS NULL OR min_order_ghs >= 0);
ALTER TABLE promos ADD COLUMN IF NOT EXISTS first_order_only BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE promos ADD COLUMN IF NOT EXISTS customer_tag TEXT;
ALTER TABLE promos ADD COLUMN IF NOT EXISTS customer_segment TEXT
  CHECK (customer_segment IS NULL OR customer_segment IN ('ordered_30d','inactive_60d','abandoned_cart'));
ALTER TABLE promos ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES products(id) ON DELETE SET NULL;
ALTER TABLE promos ADD COLUMN IF NOT EXISTS category TEXT;

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
-- What audience this broadcast targeted, for history/audit — 'All opted-in
-- customers' when no segment/tag filter was applied (upgrade path).
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS audience_desc TEXT;

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
-- Role-based access control: which staff role this key acts as (tenant keys
-- only — admin-scoped keys ignore role, they're already full-platform).
-- 'owner' is the default so every pre-existing key keeps exactly the full
-- access it always had — this column is purely additive.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'owner'
  CHECK (role IN ('owner','manager','support','accountant'));
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_ip TEXT;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_user_agent TEXT;
-- Set on the NEW key when it was created by rotating an old one — lets the
-- rotation UI show "replaces key X" and lets us tell a legitimate rotation
-- apart from an unrelated new key when reviewing the audit log.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rotated_from UUID REFERENCES api_keys(id) ON DELETE SET NULL;

-- =========================================================================
-- device_tokens: FCM push tokens for the mobile app. business_id NULL means
-- an admin/team device (registered with an admin-scoped key). A token is
-- globally unique — re-registering moves it to the new owner, which is what
-- you want when a phone switches accounts.
-- =========================================================================
CREATE TABLE IF NOT EXISTS device_tokens (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id   UUID REFERENCES businesses(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL DEFAULT 'tenant' CHECK (scope IN ('admin','tenant')),
  fcm_token     TEXT NOT NULL UNIQUE,
  platform      TEXT NOT NULL DEFAULT 'android' CHECK (platform IN ('ios','android')),
  device_name   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_business ON device_tokens(business_id);
CREATE INDEX IF NOT EXISTS idx_device_tokens_scope ON device_tokens(scope);

-- =========================================================================
-- dashboard_notifications: in-app notification center feed (separate from
-- FCM mobile push — this is what the web dashboard's bell icon reads).
-- =========================================================================
CREATE TABLE IF NOT EXISTS dashboard_notifications (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('new_order','failed_payment','low_stock','support_request')),
  title        TEXT NOT NULL,
  body         TEXT,
  data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dash_notif_business_created ON dashboard_notifications(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dash_notif_business_unread ON dashboard_notifications(business_id) WHERE read_at IS NULL;

-- =========================================================================
-- suppliers: vendors a business restocks from. Free-form, merchant-managed —
-- no verification/onboarding flow, just a record for "who do I call/pay for
-- more of this."
-- =========================================================================
CREATE TABLE IF NOT EXISTS suppliers (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  contact_name  TEXT,
  contact_phone TEXT,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_suppliers_business ON suppliers(business_id);

-- Cost/margin tracking + a product's default restock source. Nullable:
-- merchants who never fill this in see no change (margin simply isn't shown).
ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price_ghs NUMERIC(10,2) CHECK (cost_price_ghs IS NULL OR cost_price_ghs >= 0);
ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_products_supplier ON products(supplier_id);

-- =========================================================================
-- stock_movements: append-only inventory audit log. Every change to a
-- product's stock_qty — a sale (negative delta, written by order.service on
-- payment), a restock (positive delta, merchant-entered with cost/supplier),
-- or a manual correction — is one row here. This is what "inventory
-- history" means: not a snapshot, the full trail of how the number got there.
-- =========================================================================
CREATE TABLE IF NOT EXISTS stock_movements (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id       UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  type             TEXT NOT NULL CHECK (type IN ('sale','restock','adjustment','return')),
  quantity_delta   INT NOT NULL,
  quantity_after   INT,
  unit_cost_ghs    NUMERIC(10,2) CHECK (unit_cost_ghs IS NULL OR unit_cost_ghs >= 0),
  supplier_id      UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  order_id         UUID REFERENCES orders(id) ON DELETE SET NULL,
  note             TEXT,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_business ON stock_movements(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id, created_at DESC);

-- VAT/NHIL-style tax rate for exports (upgrade path for existing databases).
-- Merchant-configurable, default 0 (most micro-merchants aren't VAT
-- registered) — never assumed, never guessed at a statutory rate.
-- Prices are treated as tax-INCLUSIVE when this is set (the common retail
-- convention: the sticker price already has tax baked in).
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS vat_rate_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (vat_rate_pct >= 0 AND vat_rate_pct <= 100);

-- =========================================================================
-- expenses: merchant-recorded business costs (rent, ingredients, staff,
-- transport, ...) — the other half of a P&L alongside order revenue. No
-- receipt/OCR pipeline, just a ledger a merchant or their accountant fills in.
-- =========================================================================
CREATE TABLE IF NOT EXISTS expenses (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  category      TEXT NOT NULL DEFAULT 'general',
  amount_ghs    NUMERIC(10,2) NOT NULL CHECK (amount_ghs > 0),
  description   TEXT,
  expense_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_expenses_business ON expenses(business_id, expense_date DESC);

-- =========================================================================
-- payouts: MANUAL record of money actually sent to a merchant's MoMo.
-- Customer order payments all land in the platform's own Paystack account
-- (there is no per-tenant subaccount/split), so paying a merchant their
-- share is an operational step ops performs outside this codebase — this
-- table is the audit trail for that step, not an automated disbursement
-- integration (never invent one without vendor docs in hand).
-- =========================================================================
CREATE TABLE IF NOT EXISTS payouts (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id    UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  amount_ghs     NUMERIC(10,2) NOT NULL CHECK (amount_ghs > 0),
  momo_number    TEXT,
  momo_network   TEXT CHECK (momo_network IS NULL OR momo_network IN ('mtn','vodafone','airteltigo')),
  reference      TEXT,
  note           TEXT,
  recorded_by    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payouts_business ON payouts(business_id, created_at DESC);

-- =========================================================================
-- admin_alerts: history of platform-level ops alerts (alert.service.js) —
-- the same events that fire a WhatsApp text + admin push to ops, persisted
-- so the admin dashboard can show "what's fired recently" without digging
-- through logs.
-- =========================================================================
CREATE TABLE IF NOT EXISTS admin_alerts (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title             TEXT NOT NULL,
  detail            TEXT,
  suppressed_count  INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_alerts_created ON admin_alerts(created_at DESC);

-- =========================================================================
-- audit_log: who did what — admin and merchant account/settings-level
-- actions (order-level history already lives in order_status_history;
-- this covers everything else: business settings, api keys, promos, ...).
-- =========================================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('admin','merchant','system')),
  actor_id     TEXT,
  business_id  UUID REFERENCES businesses(id) ON DELETE SET NULL,
  action       TEXT NOT NULL,
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_business ON audit_log(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);

-- =========================================================================
-- Upgrade path: 'pawapay' is retired (Paystack is now the sole active
-- gateway for both order checkout and SaaS subscription billing; Hubtel is
-- kept only as an inactive legacy fallback). The value stays allowed here
-- purely so historical billing_transactions/webhook_events rows written
-- while pawaPay was live don't violate the constraint on re-migrate — no
-- code path writes 'pawapay' going forward. Drop-and-recreate is re-runnable.
-- =========================================================================
ALTER TABLE billing_transactions DROP CONSTRAINT IF EXISTS billing_transactions_gateway_check;
ALTER TABLE billing_transactions ADD CONSTRAINT billing_transactions_gateway_check
  CHECK (gateway IN ('hubtel','paystack','pawapay'));
-- Pin the plan a charge was raised for AT INITIATION. Previously the plan was
-- resolved dynamically at payment time from subscriptions.pending_plan_id, so a
-- plan change landing between charge and callback would apply the wrong tier.
ALTER TABLE billing_transactions ADD COLUMN IF NOT EXISTS plan_id INT REFERENCES plans(id);
ALTER TABLE webhook_events DROP CONSTRAINT IF EXISTS webhook_events_source_check;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_source_check
  CHECK (source IN ('whatsapp','paystack','hubtel','pawapay','instagram','messenger'));

-- =========================================================================
-- Storefront branding + product bundles. logo_url/banner_url power the
-- shareable storefront landing page (OG image + header); bundles are a
-- fixed-price grouping of existing products ("Lunch combo: Jollof + drink"),
-- sold as ONE line item on checkout (bundle name/price), not exploded into
-- per-component inventory tracking — components stay display-only metadata.
-- =========================================================================
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS banner_url TEXT;
-- Merchant-editable refund/cancellation policy shown on the customer-facing
-- receipt. NULL falls back to a generic default in receipt.routes.js rather
-- than storing the default text in every row.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS refund_policy TEXT;

CREATE TABLE IF NOT EXISTS product_bundles (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  price_ghs    NUMERIC(10,2) NOT NULL CHECK (price_ghs >= 0),
  image_url    TEXT,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_product_bundles_business ON product_bundles(business_id);

CREATE TABLE IF NOT EXISTS product_bundle_items (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bundle_id   UUID NOT NULL REFERENCES product_bundles(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity    INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
  UNIQUE (bundle_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_bundle_items_bundle ON product_bundle_items(bundle_id);

-- =========================================================================
-- orders.channel: where the order originated. Distinct from customers.channel
-- (a customer's PRIMARY identity channel) because one WhatsApp-identified
-- customer can also check out as a guest on the public storefront — this is
-- what "channel performance" analytics groups by, and what lets a storefront
-- guest checkout hand off into the SAME WhatsApp conversation/customer record
-- (see storefront guest checkout: it resolves the customer via the normal
-- WhatsApp getOrCreateCustomer path, then tags just the order 'storefront').
-- =========================================================================
ALTER TABLE orders ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp'
  CHECK (channel IN ('whatsapp','instagram','messenger','storefront'));
CREATE INDEX IF NOT EXISTS idx_orders_channel ON orders(business_id, channel);

-- =========================================================================
-- Customer consent records: when/how a customer first consented to be
-- messaged (Ghana Data Protection Act) — separate from opted_out (the
-- REVOCATION event). Backfilled from created_at for existing rows: every
-- existing customer reached us by messaging first, which is itself the
-- consenting act on that channel.
-- =========================================================================
ALTER TABLE customers ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS consent_source TEXT
  CHECK (consent_source IS NULL OR consent_source IN
    ('whatsapp_first_message','instagram_first_message','messenger_first_message',
     'storefront_checkout','dashboard_manual_add'));
UPDATE customers SET
  consent_at = COALESCE(consent_at, created_at),
  consent_source = COALESCE(consent_source, channel || '_first_message')
WHERE consent_at IS NULL;

-- =========================================================================
-- Account closure (self-serve, with retention warning shown before confirm —
-- see business.routes.js POST /close). This is a STATUS transition, not a
-- data-destroying delete: orders/customers/messages are retained for the
-- legal/accounting record exactly as an 'cancelled' business today, closed_at
-- just marks it as merchant-initiated rather than an ops suspension.
-- =========================================================================
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS closure_reason TEXT;

-- =========================================================================
-- impersonation_sessions: time-boxed, read-only admin support-mode access to
-- a merchant's dashboard. Modeled on api_keys (hashed token, shown once) but
-- deliberately separate — an impersonation token is NEVER merchant-issuable
-- (VALID_ROLES in middleware/auth.js excludes 'readonly'), always expires
-- fast, and every issuance/use is written to audit_log for a full trail of
-- which admin looked at which shop's data and why.
-- =========================================================================
CREATE TABLE IF NOT EXISTS impersonation_sessions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  admin_key_id  UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  reason        TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_impersonation_business ON impersonation_sessions(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_impersonation_active ON impersonation_sessions(token_hash) WHERE revoked_at IS NULL;

-- =========================================================================
-- MTN MoMo direct integration — DORMANT. A direct Collections (customer
-- checkout) and Disbursements (automated merchant payout) integration with
-- MTN was built here, then superseded before going live: Paystack is now the
-- sole active gateway for both customer checkout (all networks) and
-- automated merchant payouts (also all networks, via Paystack Transfers —
-- see the payouts columns below). This schema and the mtn_momo/
-- mtn_momo_disbursement plumbing stay in place only to receive/verify any
-- residual in-flight MTN callback; nothing initiates a new MTN-direct charge
-- or payout anymore. 'pawapay' stays in the CHECK constraints below for the
-- same historical-rows reason explained above.
-- =========================================================================

-- MTN's own X-Reference-Id (a UUID, distinct from our human-readable
-- 'reference') for the one gateway that needs a second identifier to poll
-- status — Paystack's reference already doubles as its own gateway
-- reference, so this stays NULL for Paystack/Hubtel attempts.
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS gateway_ref TEXT;
-- UNIQUE (not just indexed): the webhook processor looks up an attempt BY
-- this value alone, so two attempts sharing one gateway_ref would make an
-- inbound callback ambiguous — collapse that class of bug into a DB error
-- at write time instead of a silent wrong-order match at read time.
-- DROP+CREATE (not ADD CONSTRAINT's DROP-then-ADD pattern used elsewhere in
-- this file) because Postgres has no ALTER INDEX to add uniqueness in place —
-- this keeps the migration re-runnable even against a DB that already has an
-- earlier, non-unique version of this same index.
DROP INDEX IF EXISTS idx_payment_attempts_gateway_ref;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_attempts_gateway_ref
  ON payment_attempts(gateway_ref) WHERE gateway_ref IS NOT NULL;

ALTER TABLE webhook_events DROP CONSTRAINT IF EXISTS webhook_events_source_check;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_source_check
  CHECK (source IN ('whatsapp','paystack','hubtel','pawapay','instagram','messenger','mtn_momo','mtn_momo_disbursement'));

-- payouts: now ALSO supports an automated payout via Paystack Transfers (the
-- active gateway) or the dormant MTN Disbursement path, tracked pending ->
-- settled/failed exactly like billing_transactions. Every pre-existing row
-- is a manual record of money that was ALREADY sent, so status defaults to
-- 'settled' and initiated_by to 'manual' — purely additive, no existing
-- row's meaning changes.
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'settled';
ALTER TABLE payouts DROP CONSTRAINT IF EXISTS payouts_status_check;
ALTER TABLE payouts ADD CONSTRAINT payouts_status_check
  CHECK (status IN ('pending','settled','failed'));
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS gateway TEXT;
ALTER TABLE payouts DROP CONSTRAINT IF EXISTS payouts_gateway_check;
ALTER TABLE payouts ADD CONSTRAINT payouts_gateway_check
  CHECK (gateway IS NULL OR gateway IN ('mtn_momo','paystack'));
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS gateway_ref TEXT;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS initiated_by TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE payouts DROP CONSTRAINT IF EXISTS payouts_initiated_by_check;
ALTER TABLE payouts ADD CONSTRAINT payouts_initiated_by_check
  CHECK (initiated_by IN ('manual','mtn_momo_auto','paystack_auto'));
CREATE INDEX IF NOT EXISTS idx_payouts_status_pending ON payouts(status) WHERE status = 'pending';

-- =========================================================================
-- automations: per-business on/off + config for the lifecycle-automation
-- cron (src/services/automations.js) — reorder reminders, win-back,
-- post-purchase review, delivery feedback. One generic table + registry
-- instead of a bespoke cron function per template (see cart_nudge_* columns
-- on businesses and loyalty_birthday_* for the two earlier one-off patterns
-- this deliberately does NOT repeat a third and fourth time).
-- =========================================================================
CREATE TABLE IF NOT EXISTS automations (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  key           TEXT NOT NULL CHECK (key IN
                  ('reorder_reminder','win_back','post_purchase_review','delivery_feedback')),
  enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, key)
);

-- automation_sends: append-only send log, doubling as the dedup guard so a
-- customer/order is never notified twice by the same automation. Order-
-- anchored automations (post_purchase_review, delivery_feedback) match on
-- (automation_key, order_id); customer-anchored ones (reorder_reminder,
-- win_back) match on (automation_key, customer_id) within a cooldown window
-- computed in application code, not a DB constraint — the cooldown length is
-- merchant-configurable (automations.config), not fixed at schema time.
CREATE TABLE IF NOT EXISTS automation_sends (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  automation_key  TEXT NOT NULL,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  order_id        UUID REFERENCES orders(id) ON DELETE CASCADE,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automation_sends_customer ON automation_sends(automation_key, customer_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_sends_order ON automation_sends(automation_key, order_id) WHERE order_id IS NOT NULL;

-- product_watchers: a customer's "notify me when back in stock" opt-in for
-- one product (see conversation.handler.js#watchProductForRestock, offered
-- as a button the moment they try to order something out of stock).
-- notified_at NULL = still waiting; set once notifyProductRestocked fires
-- for this row, and reset back to NULL on a fresh opt-in so a repeat
-- out-of-stock/back-in-stock cycle notifies again instead of going silent.
CREATE TABLE IF NOT EXISTS product_watchers (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at   TIMESTAMPTZ,
  UNIQUE (product_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_product_watchers_pending
  ON product_watchers(product_id) WHERE notified_at IS NULL;

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
    'businesses','subscriptions','products','orders','conversation_state','suppliers'
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
