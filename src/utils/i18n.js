/**
 * Customer-facing bot strings, English (canonical) + Twi.
 *
 * Scope: ONLY what end customers see in the commerce flow. The merchant SaaS
 * billing flow and merchant notifications stay English — merchants read the
 * dashboard in English anyway.
 *
 * NEEDS_NATIVE_REVIEW: every 'tw' string below should be checked by a native
 * Twi speaker before being switched on for a real shop. Amounts, order
 * numbers, and command keywords (MENU, CANCEL, REPEAT…) are deliberately kept
 * as-is in both languages because the bot matches on the English keywords.
 *
 * Usage:
 *   const { t, langOf } = require('../utils/i18n');
 *   t(langOf(business), 'cart_empty')
 *   t('tw', 'order_created', { n: 'ORD-2026-1234', total: 'GH₵50.00' })
 */

const STRINGS = {
  /* ---------- global / guardrails ---------- */
  slow_down: {
    en: () => `You're sending messages a bit too fast. Please slow down — we'll pick up right where you left off in a few minutes. 🙏`,
    tw: () => `Worekyerɛw nkrasɛm ntɛmntɛm dodo. Yɛsrɛ wo, twɛn kakra — yɛbɛtoa so wɔ simma kakra akyi. 🙏`
  },
  shop_unavailable: {
    en: p => `Sorry, ${p.shop} is not accepting orders right now. Please check back later.`,
    tw: p => `Yɛsrɛ wo, ${p.shop} nnye nhyehyɛe seesei. Yɛsrɛ wo san bra akyiri yi.`
  },
  shop_closed: {
    en: p => `🕐 *${p.shop}* is closed right now.` + (p.open ? ` We open at ${p.open}.` : '') +
      `\n\nMessage us again during opening hours to place an order — we'd love to serve you!`,
    tw: p => `🕐 *${p.shop}* ato mu seesei.` + (p.open ? ` Yebue ${p.open}.` : '') +
      `\n\nSan kyerɛw yɛn bere a yɛabue no mu na fa wo nhyehyɛe bra — yɛpɛ sɛ yɛsom wo!`
  },
  cart_cleared: {
    en: () => `Cart cleared. Reply *MENU* to start over.`,
    tw: () => `Yɛapopa wo kɛntɛn no. Kyerɛw *MENU* na fi ase bio.`
  },
  reply_menu: {
    en: () => `Reply *MENU* to start over.`,
    tw: () => `Kyerɛw *MENU* na fi ase bio.`
  },
  session_expired: {
    en: () => `Your session expired. Reply *MENU* to start over.`,
    tw: () => `Wo bere no atwam. Kyerɛw *MENU* na fi ase bio.`
  },

  /* ---------- welcome / support ---------- */
  welcome_default: {
    en: p => `👋 Welcome to *${p.shop}*!\n\nTap *Order Now* to browse our menu and place an order. Pay easily with MoMo or card.`,
    tw: p => `👋 Akwaaba wɔ *${p.shop}*!\n\nMia *Order Now* na hwɛ yɛn menu na fa wo nhyehyɛe. Fa MoMo anaa kaad tua ka mmerɛw so.`
  },
  welcome_custom_suffix: {
    en: () => `Tap *Order Now* to browse and pay with MoMo or card.`,
    tw: () => `Mia *Order Now* na hwɛ menu no, na fa MoMo anaa kaad tua ka.`
  },
  support_direct: {
    en: p => p.link
      ? `💬 You can reach *${p.shop}* directly on WhatsApp: ${p.link}\n\nOr reply *MENU* anytime to keep shopping.`
      : `💬 You can reach *${p.shop}* directly on their WhatsApp line.\n\nOr reply *MENU* anytime to keep shopping.`,
    tw: p => p.link
      ? `💬 Wubetumi akasa *${p.shop}* tẽẽ wɔ WhatsApp so: ${p.link}\n\nAnaa kyerɛw *MENU* bere biara na toa wo adetɔ so.`
      : `💬 Wubetumi akasa *${p.shop}* tẽẽ wɔ wɔn WhatsApp so.\n\nAnaa kyerɛw *MENU* bere biara na toa wo adetɔ so.`
  },

  /* ---------- buttons (WhatsApp cap: 20 chars) ---------- */
  btn_order_now:    { en: () => 'Order Now',          tw: () => 'Tɔ Seesei' },
  btn_talk_to_us:   { en: () => 'Talk to us',         tw: () => 'Kasa yɛn' },
  btn_repeat:       { en: () => 'Repeat last order',  tw: () => 'San tɔ dedaw no' },
  btn_add_more:     { en: () => 'Add more',           tw: () => 'Fa bi ka ho' },
  btn_checkout:     { en: () => 'Checkout',           tw: () => 'Kɔ akatua so' },
  btn_cancel:       { en: () => 'Cancel',             tw: () => 'Gyae' },
  btn_continue:     { en: () => 'Continue',           tw: () => 'Toa so' },
  btn_confirm_pay:  { en: () => 'Confirm & Pay',      tw: () => 'Si so dua & Tua' },
  btn_momo:         { en: () => 'MoMo',               tw: () => 'MoMo' },
  btn_card:         { en: () => 'Card / Link',        tw: () => 'Kaad / Link' },
  btn_try_again:    { en: () => 'Try again',          tw: () => 'San sɔ hwɛ' },
  btn_cancel_order: { en: () => 'Cancel order',       tw: () => 'Gyae nhyehyɛe' },
  btn_view_menu:    { en: () => 'View menu',          tw: () => 'Hwɛ menu' },
  btn_choose_zone:  { en: () => 'Choose zone',        tw: () => 'Paw beae' },

  /* ---------- order lookup / retry / cancel ---------- */
  order_gone: {
    en: () => `That order is no longer available. Reply *MENU* to start over.`,
    tw: () => `Saa nhyehyɛe no nni hɔ bio. Kyerɛw *MENU* na fi ase bio.`
  },
  order_already_paid: {
    en: p => `Order *${p.n}* is already paid. ✅`,
    tw: p => `Wɔatua nhyehyɛe *${p.n}* ho ka dedaw. ✅`
  },
  order_was_cancelled: {
    en: p => `Order *${p.n}* was cancelled. Reply *MENU* to place a new one.`,
    tw: p => `Wɔagyae nhyehyɛe *${p.n}*. Kyerɛw *MENU* na fa foforo bra.`
  },
  finish_paying: {
    en: p => `Let's finish paying for order *${p.n}* — total *${p.total}*.\n\nHow would you like to pay?`,
    tw: p => `Ma yenwie nhyehyɛe *${p.n}* ho ka tua — ne nyinaa yɛ *${p.total}*.\n\nƆkwan bɛn so na wopɛ sɛ wotua?`
  },
  cannot_cancel_paid: {
    en: p => `Order *${p.n}* is already paid, so it can't be cancelled here. Contact ${p.shop} if you need help.`,
    tw: p => `Wɔatua nhyehyɛe *${p.n}* ho ka dedaw, enti yɛrentumi nnyae wɔ ha. Kasa ${p.shop} sɛ wohia mmoa a.`
  },
  order_cancelled_ok: {
    en: p => `Order *${p.n}* cancelled. Reply *MENU* anytime to order again.`,
    tw: p => `Yɛagyae nhyehyɛe *${p.n}*. Kyerɛw *MENU* bere biara na san tɔ bio.`
  },
  order_cancelled_short: {
    en: () => `Order cancelled.`,
    tw: () => `Yɛagyae nhyehyɛe no.`
  },
  order_cancelled_menu: {
    en: () => `Order cancelled. Reply *MENU* to start over.`,
    tw: () => `Yɛagyae nhyehyɛe no. Kyerɛw *MENU* na fi ase bio.`
  },

  /* ---------- customer order status card ---------- */
  order_not_found: {
    en: p => `We couldn't find order *${p.n}* on your account with ${p.shop}. Reply *MENU* to place a new order.`,
    tw: p => `Yɛanhu nhyehyɛe *${p.n}* wɔ wo akontaa mu wɔ ${p.shop}. Kyerɛw *MENU* na fa foforo bra.`
  },
  order_card: {
    en: p => `📋 Order *${p.n}* — ${p.shop}\n\n${p.items}\n\nTotal: ${p.total}\nPayment: ${p.payment}\nStatus: ${p.status}`,
    tw: p => `📋 Nhyehyɛe *${p.n}* — ${p.shop}\n\n${p.items}\n\nNe nyinaa: ${p.total}\nAkatua: ${p.payment}\nGyinabea: ${p.status}`
  },
  st_pending:   { en: () => '⏳ Waiting for payment',                      tw: () => '⏳ Yɛretwɛn akatua' },
  st_confirmed: { en: () => '✅ Confirmed — the shop has your order',      tw: () => '✅ Wɔagye atom — sotɔɔ no anya wo nhyehyɛe' },
  st_paid:      { en: () => '✅ Paid — being processed',                   tw: () => '✅ Wɔatua — wɔreyɛ ho adwuma' },
  st_preparing: { en: () => '🍳 Being prepared',                          tw: () => '🍳 Wɔresiesie' },
  st_ready:     { en: () => '📦 Ready for delivery/pickup',               tw: () => '📦 Ayɛ krado sɛ wɔde bɛba/wobɛfa' },
  st_delivered: { en: () => '🎉 Delivered',                               tw: () => '🎉 Wɔde adu' },
  st_cancelled: { en: () => '❌ Cancelled',                               tw: () => '❌ Wɔagyae' },

  /* ---------- reorder ---------- */
  no_previous_order: {
    en: p => `You don't have a previous order with ${p.shop} yet. Reply *MENU* to browse.`,
    tw: p => `Wunni nhyehyɛe dedaw biara wɔ ${p.shop}. Kyerɛw *MENU* na hwɛ menu no.`
  },
  prev_items_unavailable: {
    en: () => `The items from your last order aren't available right now. Reply *MENU* to see today's menu.`,
    tw: () => `Nneɛma a ɛwɔ wo nhyehyɛe a etwaa mu no nni hɔ seesei. Kyerɛw *MENU* na hwɛ nnɛ menu no.`
  },
  items_dropped: {
    en: p => `Heads up: ${p.list} ${p.count === 1 ? 'is' : 'are'} no longer available and ${p.count === 1 ? 'was' : 'were'} left out.`,
    tw: p => `Hyɛ no nsow: ${p.list} nni hɔ bio, enti yɛannfa anka ho.`
  },

  /* ---------- menu / cart ---------- */
  no_products: {
    en: p => `Sorry, ${p.shop} has no products available right now. Please check back soon!`,
    tw: p => `Yɛsrɛ wo, ${p.shop} nni nneɛma biara seesei. Yɛsrɛ wo san bra akyiri yi!`
  },
  menu_title: {
    en: p => `${p.shop} Menu`,
    tw: p => `${p.shop} Menu`
  },
  menu_body: {
    en: p => `Tap an item to add it to your cart.${p.cartNote || ''}`,
    tw: p => `Mia adeɛ bi na fa hyɛ wo kɛntɛn mu.${p.cartNote || ''}`
  },
  cart_note: {
    en: p => `\n\n🛒 ${p.count} item(s) already in your cart.`,
    tw: p => `\n\n🛒 Nneɛma ${p.count} wɔ wo kɛntɛn mu dedaw.`
  },
  item_gone: {
    en: () => `That item is no longer available.`,
    tw: () => `Saa adeɛ no nni hɔ bio.`
  },
  out_of_stock: {
    en: p => `Sorry, "${p.name}" is out of stock.`,
    tw: p => `Yɛsrɛ wo, "${p.name}" asa.`
  },
  added_prompt: {
    en: p => `Added *${p.name}* to your cart. ✅\n\nWould you like to add more items or checkout?`,
    tw: p => `Yɛde *${p.name}* ahyɛ wo kɛntɛn mu. ✅\n\nWopɛ sɛ wofa nneɛma foforo ka ho anaa wobɛkɔ akatua so?`
  },
  add_or_checkout: {
    en: () => `Would you like to add more items or checkout?`,
    tw: () => `Wopɛ sɛ wofa nneɛma foforo ka ho anaa wobɛkɔ akatua so?`
  },
  product_not_found: {
    en: p => `We couldn't find "${p.name}" on the menu. Tap *View menu* to pick from the list.`,
    tw: p => `Yɛanhu "${p.name}" wɔ menu no mu. Mia *Hwɛ menu* na paw fi list no mu.`
  },
  cart_empty: {
    en: () => `Your cart is empty. Reply *MENU* to start shopping.`,
    tw: () => `Wo kɛntɛn mu da mpan. Kyerɛw *MENU* na fi adetɔ ase.`
  },
  cart_review: {
    en: p => `🛒 Your Cart\n\n${p.lines}\n\nSubtotal: *${p.subtotal}*\n\nContinue shopping or checkout?`,
    tw: p => `🛒 Wo Kɛntɛn\n\n${p.lines}\n\nNe boɔ: *${p.subtotal}*\n\nToa adetɔ so anaa kɔ akatua so?`
  },

  /* ---------- address / zones / confirm ---------- */
  ask_address: {
    en: () => `📍 Please send your delivery address as a text message (landmark, area, any special instructions) — or share your location pin.`,
    tw: () => `📍 Yɛsrɛ wo, kyerɛw baabi a yɛmfa nneɛma no mmra (agyiraehyɛde, mpɔtam, nkyerɛkyerɛmu foforo biara) — anaa fa wo location pin no bra.`
  },
  address_short: {
    en: () => `That address looks too short. Please send a more detailed delivery address, or share your location pin 📍.`,
    tw: () => `Address no yɛ tiaa dodo. Yɛsrɛ wo kyerɛkyerɛ mu yiye, anaa fa wo location pin no bra 📍.`
  },
  zone_header: { en: () => 'Delivery zone', tw: () => 'Beae a yɛde bɛba' },
  zone_section: { en: () => 'Zones', tw: () => 'Mmeae' },
  zone_body: {
    en: () => `📍 Which area are we delivering to? The delivery fee depends on your zone.`,
    tw: () => `📍 Mpɔtam bɛn na yɛmfa nneɛma no nkɔ? Ka a wobetua no gyina wo beae so.`
  },
  zone_fee: {
    en: p => `Delivery ${p.fee}`,
    tw: p => `Ɔsoma ka ${p.fee}`
  },
  order_summary: {
    en: p => `📦 Order Summary\n\n${p.lines}\n\nSubtotal: ${p.subtotal}\nDelivery${p.zone ? ` (${p.zone})` : ''}: ${p.fee}\n*Total: ${p.total}*\n\nAddress: ${p.address}\n\nConfirm and pay now?`,
    tw: p => `📦 Nhyehyɛe Ho Nsɛm\n\n${p.lines}\n\nNe boɔ: ${p.subtotal}\nƆsoma ka${p.zone ? ` (${p.zone})` : ''}: ${p.fee}\n*Ne nyinaa: ${p.total}*\n\nAddress: ${p.address}\n\nSi so dua na tua seesei?`
  },
  order_broken: {
    en: () => `Something went wrong with your order. Reply *MENU* to start over.`,
    tw: () => `Biribi ansi yiye wɔ wo nhyehyɛe no ho. Kyerɛw *MENU* na fi ase bio.`
  },
  order_create_failed: {
    en: () => `We could not create your order right now. Please try again in a moment.`,
    tw: () => `Yɛantumi anyɛ wo nhyehyɛe no seesei. Yɛsrɛ wo san sɔ hwɛ akyiri kakra.`
  },

  /* ---------- payment ---------- */
  order_created: {
    en: p => `Order *${p.n}* created — total *${p.total}*.\n\nHow would you like to pay?`,
    tw: p => `Yɛayɛ nhyehyɛe *${p.n}* — ne nyinaa yɛ *${p.total}*.\n\nƆkwan bɛn so na wopɛ sɛ wotua?`
  },
  momo_ask: {
    en: p => `📱 Reply with the MoMo number to charge (or send *USE THIS* to use ${p.number}).`,
    tw: p => `📱 Kyerɛw MoMo nɔma a yɛmfa ntua (anaa kyerɛw *USE THIS* na yɛde ${p.number} ayɛ).`
  },
  momo_ask_ig: {
    en: () => `📱 Reply with the MoMo number to charge (e.g. 0241234567).`,
    tw: () => `📱 Kyerɛw MoMo nɔma a yɛmfa ntua (te sɛ 0241234567).`
  },
  momo_invalid: {
    en: () => `That doesn't look like a valid Ghana MoMo number. Try again (e.g. 0241234567).`,
    tw: () => `Ɛno nnyɛ Ghana MoMo nɔma pa. San sɔ hwɛ (te sɛ 0241234567).`
  },
  momo_initiated: {
    en: p => `✅ MoMo charge initiated for *${p.total}*.\n\n${p.display}\n\nWe'll confirm here once payment is received.`,
    tw: p => `✅ Yɛafi MoMo akatua ase — *${p.total}*.\n\n${p.display}\n\nSɛ akatua no du a, yɛbɛbɔ wo amanneɛ wɔ ha.`
  },
  momo_approve_hint: {
    en: p => `Approve the MoMo prompt on ${p.number} to complete payment.`,
    tw: p => `Gye MoMo frɛ a ɛbɛba ${p.number} so no tom na awie akatua no.`
  },
  momo_start_failed: {
    en: p => `⚠️ Could not start MoMo charge: ${p.err}.\n\nReply *MENU* to try again.`,
    tw: p => `⚠️ Yɛantumi amfi MoMo akatua ase: ${p.err}.\n\nKyerɛw *MENU* na san sɔ hwɛ.`
  },
  card_link: {
    en: p => `💳 Pay *${p.total}* securely via this link:\n\n${p.url}\n\nWe'll confirm here once payment is received.`,
    tw: p => `💳 Fa link yi so tua *${p.total}* wɔ ahobammɔ mu:\n\n${p.url}\n\nSɛ akatua no du a, yɛbɛbɔ wo amanneɛ wɔ ha.`
  },
  card_link_failed: {
    en: p => `⚠️ Could not generate payment link: ${p.err}.\n\nReply *MENU* to try again.`,
    tw: p => `⚠️ Yɛantumi anyɛ akatua link no: ${p.err}.\n\nKyerɛw *MENU* na san sɔ hwɛ.`
  },
  payment_mismatch: {
    en: p => `⚠️ The payment received for order *${p.n}* did not match the order total. Our team will be in touch.`,
    tw: p => `⚠️ Akatua a yegye maa nhyehyɛe *${p.n}* no ne ne boɔ anhyia. Yɛn adwumakuw no bɛkasa wo.`
  },
  payment_failed_retry: {
    en: p => `⚠️ Payment for order *${p.n}* did not go through.\n\nYour order is saved — you can try paying again.`,
    tw: p => `⚠️ Nhyehyɛe *${p.n}* ho akatua no ansi yiye.\n\nWo nhyehyɛe no da so wɔ hɔ — wubetumi asan atua bio.`
  },
  payment_received: {
    en: p => `✅ Payment received!\n\nOrder: ${p.n}\nTotal: ${p.total}\nBusiness: ${p.shop}\n\nWe'll notify you the moment your order is on its way. Thank you for shopping with us! 🛍️`,
    tw: p => `✅ Yɛagye wo akatua no!\n\nNhyehyɛe: ${p.n}\nNe nyinaa: ${p.total}\nAdwuma: ${p.shop}\n\nSɛ wo nhyehyɛe no si kwan so a, yɛbɛbɔ wo amanneɛ. Yɛda wo ase sɛ wotɔɔ yɛn nkyɛn! 🛍️`
  },

  /* ---------- fulfilment status notifications ---------- */
  ns_confirmed: {
    en: p => `✅ ${p.shop} confirmed your order *${p.n}*.`,
    tw: p => `✅ ${p.shop} agye wo nhyehyɛe *${p.n}* atom.`
  },
  ns_preparing: {
    en: p => `🍳 ${p.shop} is preparing your order *${p.n}*.`,
    tw: p => `🍳 ${p.shop} resiesie wo nhyehyɛe *${p.n}*.`
  },
  ns_ready: {
    en: p => `📦 Your order *${p.n}* is ready! It will be with you shortly.`,
    tw: p => `📦 Wo nhyehyɛe *${p.n}* ayɛ krado! Ɛrenkyɛ ebedu wo nkyɛn.`
  },
  ns_delivered: {
    en: p => `🎉 Order *${p.n}* delivered. Thank you for shopping with ${p.shop}!`,
    tw: p => `🎉 Nhyehyɛe *${p.n}* adu. Yɛda wo ase sɛ wotɔɔ ${p.shop} nkyɛn!`
  },
  ns_cancelled: {
    en: p => `Your order *${p.n}* at ${p.shop} has been cancelled. Reply *MENU* to order again.`,
    tw: p => `Wɔagyae wo nhyehyɛe *${p.n}* wɔ ${p.shop}. Kyerɛw *MENU* na san tɔ bio.`
  },

  /* ---------- cart nudge ---------- */
  cart_nudge: {
    en: p => `🛒 Still thinking it over? Your cart at *${p.shop}* with ${p.count} item${p.count === 1 ? '' : 's'} is saved and waiting.`,
    tw: p => `🛒 Woda so redwen ho? Wo kɛntɛn a ɛwɔ *${p.shop}* a nneɛma ${p.count} wom no da so retwɛn wo.`
  }
};

/**
 * Resolve a business row to a supported language code.
 */
function langOf(business) {
  return business && business.bot_language === 'tw' ? 'tw' : 'en';
}

/**
 * Render a string. Unknown keys throw (a typo should fail tests, not ship
 * silently); missing translations fall back to English.
 */
function t(lang, key, params = {}) {
  const entry = STRINGS[key];
  if (!entry) throw new Error(`i18n: unknown string key "${key}"`);
  const render = entry[lang] || entry.en;
  return render(params);
}

module.exports = { t, langOf, STRINGS };
