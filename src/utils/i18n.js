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
  opted_out_confirm: {
    en: p => `You've been unsubscribed from ${p.shop}'s promotional messages. You can still order anytime — reply *MENU* to shop, or *START* to resubscribe to updates.`,
    tw: p => `Yɛayi wo afi ${p.shop} nsɛm a wɔde bɛto gua no mu. Wubetumi ato bere biara — kyerɛw *MENU* na tɔ adeɛ, anaa *START* na san gye nsɛm.`
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
  human_handoff: {
    en: p => `💬 Got it — a person from *${p.shop}* will reply to you here shortly. Reply *MENU* anytime if you'd like to keep browsing while you wait.`,
    tw: p => `💬 Yɛate — obi fi *${p.shop}* bɛba abua wo wɔ ha nnansa yi. Kyerɛw *MENU* bere biara sɛ wopɛ sɛ wohwɛ nneɛma bere a woretwɛn.`
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
  product_query_results: {
    en: p => `Here's what we found:\n\n${p.list}\n\nReply with an item name to add it, or *MENU* to see everything.`,
    tw: p => `Nea yɛahu ni:\n\n${p.list}\n\nKyerɛw adeɛ no din na fa hyɛ kɛntɛn mu, anaa *MENU* na hwɛ biribiara.`
  },
  product_query_none: {
    en: p => `We don't have that right now. Reply *MENU* to see what ${p.shop} has available.`,
    tw: p => `Yɛnni saa adeɛ no seesei. Kyerɛw *MENU* na hwɛ nea ${p.shop} wɔ.`
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
    en: p => `🛒 Your Cart\n\n${p.lines}\n\nSubtotal: *${p.subtotal}*\n\nContinue shopping or checkout? Have a promo code? Type it in (e.g. PROMO SAVE10).`,
    tw: p => `🛒 Wo Kɛntɛn\n\n${p.lines}\n\nNe boɔ: *${p.subtotal}*\n\nToa adetɔ so anaa kɔ akatua so? Wowɔ promo code? Kyerɛw (te sɛ PROMO SAVE10).`
  },

  /* ---------- variants & add-ons ---------- */
  variant_header: {
    en: p => `Choose an option for ${p.name}`,
    tw: p => `Paw ɔkwan bi ma ${p.name}`
  },
  variant_body: {
    en: () => `Tap the option you'd like.`,
    tw: () => `Mia ɔkwan a wopɛ.`
  },
  btn_choose_option: {
    en: () => 'Choose option',
    tw: () => 'Paw ɔkwan'
  },
  variant_out_of_stock: {
    en: p => `Sorry, "${p.name}" is out of stock right now.`,
    tw: p => `Yɛsrɛ wo, "${p.name}" asa mprempren.`
  },
  addon_prompt: {
    en: p => `Want to add any extras to *${p.name}*?\n\n${p.lines}\n\nReply with the numbers you want, separated by commas (e.g. 1,3) — or *0* for none.`,
    tw: p => `Wopɛ sɛ wode nneɛma foforo ka *${p.name}* ho?\n\n${p.lines}\n\nKyerɛw nɔma a wopɛ, fa comma (,) tetew mu (te sɛ 1,3) — anaa *0* sɛ wompɛ biara.`
  },
  addon_invalid: {
    en: () => `Reply with the extra numbers separated by commas (e.g. 1,3), or 0 for none.`,
    tw: () => `Kyerɛw nɔma a wopɛ, fa comma (,) tetew mu (te sɛ 1,3), anaa 0 sɛ wompɛ biara.`
  },

  /* ---------- upsells ---------- */
  upsell_variant: {
    en: p => `✨ Want to upgrade to *${p.name}* for just +${p.delta} more? Just ask!`,
    tw: p => `✨ Wopɛ sɛ wo kɔ *${p.name}* mu, fa ka ${p.delta} bio? Kyerɛw yɛn!`
  },
  upsell_frequently_bought: {
    en: p => `🍹 Customers often add *${p.name}* too — just type it to add it.`,
    tw: p => `🍹 Adetɔfoɔ taa fa *${p.name}* ka ho — kyerɛw ne din na fa ka ho.`
  },
  usual_hint: {
    en: p => `\n\nYour usual: *${p.name}* — just type it to add it.`,
    tw: p => `\n\nDeɛ wotaa tɔ: *${p.name}* — kyerɛw ne din na fa ka ho.`
  },

  /* ---------- loyalty ---------- */
  loyalty_points_earned: {
    en: p => `⭐ You earned ${p.points} point${p.points === 1 ? '' : 's'} on this order!`,
    tw: p => `⭐ Wonyaa ${p.points} point${p.points === 1 ? '' : 's'} wɔ saa nhyehyɛe yi so!`
  },
  loyalty_free_item_earned: {
    en: p => `🎉 You've earned a free item! Use code *${p.code}* (worth ${p.value}) on your next order.`,
    tw: p => `🎉 Wonyaa adeɛ kwa! Fa code *${p.code}* (ɛsom bo ${p.value}) di dwuma wɔ wo nhyehyɛe a ɛtoso so.`
  },
  loyalty_referral_earned: {
    en: p => `🎁 Someone you referred to *${p.shop}* just made their first order! Here's your thank-you: code *${p.code}* worth ${p.value} on your next order.`,
    tw: p => `🎁 Obi a wode no baa *${p.shop}* atɔ n'ade a edi kan! Wo akyɛde ni: code *${p.code}* a ɛsom bo ${p.value} wɔ wo nhyehyɛe a ɛtoso so.`
  },
  my_referral_code: {
    en: p => `🎁 Your referral code is *${p.code}*. Share it — when a friend's first order at *${p.shop}* pays, you get a reward!`,
    tw: p => `🎁 Wo referral code ne *${p.code}*. Kyɛ ma obi — sɛ w'adamfo tɔ n'ade a edi kan wɔ *${p.shop}* na otua ka a, wobɛnya akyɛde!`
  },
  referral_applied: {
    en: p => `✅ Got it — you're linked as referred. Make your first order at *${p.shop}* and your friend gets a thank-you reward!`,
    tw: p => `✅ Yɛate — yɛde wo ahyɛ sɛ obi de wo baa ha. Tɔ w'ade a edi kan wɔ *${p.shop}* na w'adamfo nya akyɛde!`
  },
  referral_already_linked: {
    en: () => `You're already linked to a referral — that only needs to happen once.`,
    tw: () => `Yɛde wo ahyɛ dedaw sɛ obi de wo baa ha — ɛho hia sɛ wɔyɛ no prɛko pɛ.`
  },
  referral_not_new: {
    en: () => `Referral codes only work before your first paid order — thanks for already being a customer!`,
    tw: () => `Referral code no yɛ adwuma ansa wo tua wo nhyehyɛe a edi kan ka — meda wo ase sɛ woyɛ yɛn adetɔfoɔ dedaw!`
  },
  referral_invalid: {
    en: () => `We couldn't find that referral code. Double-check it and try again.`,
    tw: () => `Yɛanhu saa referral code no. Hwɛ yiye na san sɔ hwɛ.`
  },
  referral_self: {
    en: () => `You can't refer yourself! Share your code with a friend instead.`,
    tw: () => `Wontumi mfa wo ho referral code! Kyɛ wo code no ma w'adamfo mmom.`
  },
  birthday_coupon: {
    en: p => `🎂 Happy birthday from *${p.shop}*! Here's a treat: code *${p.code}* for ${p.value} off your next order (valid 14 days).`,
    tw: p => `🎂 Afenhyia pa fi *${p.shop}*! Akyɛde ni: code *${p.code}* a ɛma wonya ${p.value} tiaa wo nhyehyɛe a ɛtoso so (ɛyɛ adwuma nnafua 14).`
  },

  /* ---------- promo codes ---------- */
  promo_applied: {
    en: p => `✅ Promo *${p.code}* applied — you saved ${p.discount}.\n\nNew total: *${p.total}*`,
    tw: p => `✅ Yɛde promo *${p.code}* ayɛ adwuma — woagye ${p.discount}.\n\nBoɔ foforo: *${p.total}*`
  },
  promo_invalid: {
    en: () => `That promo code isn't valid. Check the code and try again, or continue without one.`,
    tw: () => `Saa promo code no nyɛ. Hwɛ code no yiye na san sɔ hwɛ, anaasɛ toa so a wɔmfa promo code biara.`
  },
  promo_min_order_not_met: {
    en: () => `That code needs a bigger order to unlock. Add a bit more to your cart and try again.`,
    tw: () => `Saa code no hia sɛ wo nhyehyɛe so kɛse. Fa biribi ka wo kɛntɛn ho na san sɔ hwɛ.`
  },
  promo_first_order_only: {
    en: () => `That code is only for a customer's very first order — thanks for shopping with us before!`,
    tw: () => `Saa code no yɛ ma ɔdetɔfoɔ n'ade a edi kan pɛ — meda wo ase sɛ woatɔ yɛn nkyɛn dedaw!`
  },
  promo_not_eligible: {
    en: () => `That code isn't available for your account.`,
    tw: () => `Saa code no nni hɔ ma wo account.`
  },
  promo_wrong_items: {
    en: () => `That code only applies to specific items — add one of those to your cart to use it.`,
    tw: () => `Saa code no fa nneɛma pɔtee bi nko ho — fa emu bi ka wo kɛntɛn ho na fa di dwuma.`
  },
  promo_auto_applied: {
    en: p => `🎁 We automatically applied your best available discount: code *${p.code}* saves you ${p.discount}!`,
    tw: p => `🎁 Yɛde wo discount a ɛyɛ papa paa adi dwuma ama wo: code *${p.code}* ma wonya ${p.discount}!`
  },
  promo_expired: {
    en: () => `That promo code has expired.`,
    tw: () => `Saa promo code no atwam dedaw.`
  },
  promo_exhausted: {
    en: () => `That promo code has already reached its usage limit.`,
    tw: () => `Saa promo code no adu ne dodow a wɔama ho kwan no.`
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
    en: p => `📦 Order Summary\n\n${p.lines}\n\nSubtotal: ${p.subtotal}${p.discountLine || ''}\nDelivery${p.zone ? ` (${p.zone})` : ''}: ${p.fee}\n*Total: ${p.total}*\n\nAddress: ${p.address}\n\nConfirm and pay now?`,
    tw: p => `📦 Nhyehyɛe Ho Nsɛm\n\n${p.lines}\n\nNe boɔ: ${p.subtotal}${p.discountLine || ''}\nƆsoma ka${p.zone ? ` (${p.zone})` : ''}: ${p.fee}\n*Ne nyinaa: ${p.total}*\n\nAddress: ${p.address}\n\nSi so dua na tua seesei?`
  },
  order_summary_discount_line: {
    en: p => `\nDiscount (${p.code}): -${p.discount}`,
    tw: p => `\nTiaso (${p.code}): -${p.discount}`
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
    en: p => `✅ Payment received!\n\nOrder: ${p.n}\nTotal: ${p.total}\nBusiness: ${p.shop}\n\nWe'll notify you the moment your order is on its way. Thank you for shopping with us! 🛍️${p.receiptUrl ? `\n\nReceipt: ${p.receiptUrl}` : ''}\n\nWant the same again next time? Just reply *REPEAT*.`,
    tw: p => `✅ Yɛagye wo akatua no!\n\nNhyehyɛe: ${p.n}\nNe nyinaa: ${p.total}\nAdwuma: ${p.shop}\n\nSɛ wo nhyehyɛe no si kwan so a, yɛbɛbɔ wo amanneɛ. Yɛda wo ase sɛ wotɔɔ yɛn nkyɛn! 🛍️${p.receiptUrl ? `\n\nReceipt: ${p.receiptUrl}` : ''}\n\nWopɛ sɛ wonya bio a, kyerɛw *REPEAT*.`
  },
  // Compact SMS fallback — kept to one GSM-7 segment (≤160 chars) wherever
  // possible; used only when the customer's primary channel send failed.
  sms_payment_receipt: {
    en: p => `${p.shop}: Payment received for order ${p.n}, total ${p.total}. Thank you!${p.receiptUrl ? ` Receipt: ${p.receiptUrl}` : ''}`,
    tw: p => `${p.shop}: Yɛagye akatua ama nhyehyɛe ${p.n}, ne nyinaa ${p.total}. Yɛda wo ase!${p.receiptUrl ? ` Receipt: ${p.receiptUrl}` : ''}`
  },
  sms_cart_nudge: {
    en: p => `${p.shop}: You left ${p.count} item(s) in your cart. Reply to this WhatsApp/Instagram chat to finish your order.`,
    tw: p => `${p.shop}: Wogyaw nneɛma ${p.count} wɔ wo cart mu. San kɔ WhatsApp/Instagram nkitahodi no so na wie wo nhyehyɛe no.`
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
  // Fires only when a proof photo was attached — a distinct, additive
  // message from ns_delivered (which covers the general order-status flow),
  // not a duplicate of it.
  delivery_completed: {
    en: p => `📸 Delivery proof for order *${p.n}* from ${p.shop}${p.proofUrl ? `:\n${p.proofUrl}` : '.'}`,
    tw: p => `📸 Nhyehyɛe *${p.n}* a efi ${p.shop} adansedie${p.proofUrl ? `:\n${p.proofUrl}` : '.'}`
  },
  ns_cancelled: {
    en: p => `Your order *${p.n}* at ${p.shop} has been cancelled. Reply *MENU* to order again.`,
    tw: p => `Wɔagyae wo nhyehyɛe *${p.n}* wɔ ${p.shop}. Kyerɛw *MENU* na san tɔ bio.`
  },

  /* ---------- cart nudge ---------- */
  cart_nudge: {
    en: p => `🛒 Still thinking it over? Your cart at *${p.shop}* with ${p.count} item${p.count === 1 ? '' : 's'} is saved and waiting.`,
    tw: p => `🛒 Woda so redwen ho? Wo kɛntɛn a ɛwɔ *${p.shop}* a nneɛma ${p.count} wom no da so retwɛn wo.`
  },
  cart_nudge_coupon: {
    en: p => `\n\n🎁 Use code *${p.code}* at checkout for a discount!`,
    tw: p => `\n\n🎁 Fa code *${p.code}* di dwuma wɔ akatua so na nya discount!`
  }
};

/**
 * Resolve a business row to a supported language code.
 */
/**
 * customer.language_override (set from detectLikelyLanguage, below) wins
 * over the shop's own default — a Twi-typing customer gets Twi replies even
 * on a shop whose bot_language is 'en', and vice versa. Optional second arg
 * keeps every existing single-arg call site working unchanged.
 */
function langOf(business, customer) {
  if (customer && (customer.language_override === 'en' || customer.language_override === 'tw')) {
    return customer.language_override;
  }
  return business && business.bot_language === 'tw' ? 'tw' : 'en';
}

// Conservative signals only — presence flips the detected language, absence
// means "no confident signal" (null), never "must be English". A customer
// typing plain English words that happen to also be common elsewhere isn't
// enough; only the Twi-specific vowels and a set of unambiguous Twi words
// count. NEEDS_NATIVE_REVIEW — extend as real customer phrasing surfaces.
const TWI_SIGNAL_WORDS = [
  'mepɛ', 'me pɛ', 'wo ho te sɛn', 'ɛte sɛn', 'medaase', 'aane', 'daabi',
  'ɛyɛ', 'wope', 'mepe', 'maakye', 'maaha', 'maadwo', 'bɛyɛ dɛn', 'yɛbɛhyɛ',
  'kɔsɛ', 'meda wo ase'
];

/**
 * Best-effort per-message language hint from what the customer actually
 * typed. Returns 'tw', or null when there's no confident signal (caller
 * should then keep whatever language preference was already on file).
 */
function detectLikelyLanguage(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  if (/[ɔɛƆƐ]/.test(raw)) return 'tw';
  const lower = raw.toLowerCase();
  if (TWI_SIGNAL_WORDS.some(w => lower.includes(w))) return 'tw';
  return null;
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

module.exports = { t, langOf, STRINGS, detectLikelyLanguage };
