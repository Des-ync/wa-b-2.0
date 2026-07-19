const logger = require('../utils/logger');
const lock = require('./worker.lock');
const { query } = require('../config/database');
const { getAdapter, destOf } = require('./channel.adapter');
const { t, langOf } = require('../utils/i18n');
const { generateRewardCode } = require('../utils/loyalty');

/**
 * Daily: find customers whose birthday (month + day, Africa/Accra) is today,
 * on a business with loyalty + a birthday discount configured, who haven't
 * already gotten one this calendar year, and issue + message them a coupon.
 */
async function runBirthdayCouponJob() {
  await lock.withLock('birthday_coupon_job', 300, async () => {
    const candidates = await query(
      `SELECT c.id AS customer_id, c.channel, c.channel_id, c.whatsapp_number, c.language_override,
              b.id AS business_id, b.name AS business_name, b.bot_language,
              b.loyalty_birthday_discount_type, b.loyalty_birthday_discount_value
         FROM customers c
         JOIN businesses b ON b.id = c.business_id
        WHERE b.loyalty_enabled = TRUE
          AND b.loyalty_birthday_discount_value > 0
          AND c.date_of_birth IS NOT NULL
          AND EXTRACT(MONTH FROM c.date_of_birth) = EXTRACT(MONTH FROM NOW() AT TIME ZONE 'Africa/Accra')
          AND EXTRACT(DAY FROM c.date_of_birth) = EXTRACT(DAY FROM NOW() AT TIME ZONE 'Africa/Accra')
          AND NOT EXISTS (
            SELECT 1 FROM customer_rewards cr
             WHERE cr.customer_id = c.id AND cr.type = 'birthday_coupon'
               AND EXTRACT(YEAR FROM cr.created_at) = EXTRACT(YEAR FROM NOW() AT TIME ZONE 'Africa/Accra')
          )
        LIMIT 500`
    );
    if (!candidates.rows.length) return;
    logger.info('[cron] birthday coupons: %d customer(s) to reward today', candidates.rows.length);

    let sent = 0;
    for (const row of candidates.rows) {
      try {
        const code = generateRewardCode('BDAY');
        await query(
          `INSERT INTO customer_rewards (business_id, customer_id, type, code, description, discount_type, discount_value, expires_at)
           VALUES ($1,$2,'birthday_coupon',$3,'Happy birthday!',$4,$5, NOW() + INTERVAL '14 days')`,
          [row.business_id, row.customer_id, code, row.loyalty_birthday_discount_type, row.loyalty_birthday_discount_value]
        );
        const lang = langOf({ bot_language: row.bot_language }, { language_override: row.language_override });
        const valueLabel = row.loyalty_birthday_discount_type === 'percent'
          ? `${row.loyalty_birthday_discount_value}%`
          : `GH₵${Number(row.loyalty_birthday_discount_value).toFixed(2)}`;
        const customer = { channel: row.channel, channel_id: row.channel_id, whatsapp_number: row.whatsapp_number };
        await getAdapter(row.channel).sendText(
          destOf(customer),
          t(lang, 'birthday_coupon', { shop: row.business_name, code, value: valueLabel }),
          { businessId: row.business_id, customerId: row.customer_id }
        );
        sent++;
      } catch (err) {
        logger.warn('[cron] birthday coupon failed for customer %s: %s', row.customer_id, err.message);
      }
    }
    logger.info('[cron] birthday coupons done: %d sent', sent);
  });
}

module.exports = { runBirthdayCouponJob };
