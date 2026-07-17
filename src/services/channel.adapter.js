const wa = require('./whatsapp.service');
const ig = require('./instagram.service');

/**
 * Resolve the outbound messaging adapter for a channel. Both adapters expose
 * the same customer-facing surface: sendText, sendButtons, sendList,
 * markAsRead, sendPaymentConfirmation.
 *
 * WhatsApp is the default for any unknown/missing channel so pre-migration
 * customer rows (channel column absent/NULL) behave exactly as before.
 */
function getAdapter(channel) {
  return channel === 'instagram' ? ig : wa;
}

/**
 * The channel-native destination for a customer row: IG-scoped user id for
 * Instagram, the WhatsApp number (unchanged, backward-compatible) otherwise.
 */
function destOf(customer) {
  return customer?.channel === 'instagram'
    ? customer.channel_id
    : customer?.whatsapp_number;
}

module.exports = { getAdapter, destOf };
