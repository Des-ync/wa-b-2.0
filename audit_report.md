# WhatsApp Commerce & Subscription SaaS - Codebase Audit Report

This report consolidates the results of the multi-agent code audit performed on the WhatsApp Commerce & Subscription SaaS codebase. The audit identified **25 distinct issues** ranging from critical authorization bypasses to concurrency deadlocks, resource leaks, and data integrity concerns.

---

## Executive Summary of Findings

| Severity | Count | Primary Impact Areas |
| :--- | :--- | :--- |
| **Critical** | 1 | Full security authorization bypass in middleware. |
| **High** | 10 | Payment webhook spoofing, concurrent transaction double-spends, message loss, worker/database locking deadlocks. |
| **Medium** | 10 | Broken stock/visibility validation, database write contention, incomplete graceful shutdown, resource leaks. |
| **Low** | 4 | CSV/formula injection, unvalidated data types, cron job cleanup on shutdown, missing currency validation. |

---

## 🚨 Critical Vulnerability

### 1. Missing Auth Middleware before `requirePermission` Fails Open
* **File Path**: [auth.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/middleware/auth.js#L239-L251)
* **Line Range**: 239 - 251
* **Flaw Description**: If a developer configures a route using the `requirePermission` middleware but forgets to mount the preceding `requireAuth` middleware, `req.auth` is undefined. The middleware falls back to `req.auth?.role || 'owner'`. Because an `'owner'` role possesses all capabilities, the check passes.
* **Impact**: Full authorization bypass and privilege escalation. Anyone can access administrative or restricted tenant endpoints if middleware mounting order is incorrect.
* **Proposed Remediation Code**:
```javascript
function requirePermission(capability, mode = 'write') {
  return (req, res, next) => {
    if (!req.auth) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    if (req.auth?.scope === 'admin') return next();
    const role = req.auth?.role || 'owner';
    if (!can(role, capability, mode)) {
      return res.status(403).json({
        success: false,
        error: `Your role (${role}) does not have ${mode} access to ${capability}`
      });
    }
    next();
  };
}
```

---

## 🔥 High Severity Findings

### 2. Webhook Signature Validation Bypass and DoS in pawaPay Callback
* **File Path**: [payment.routes.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/routes/payment.routes.js#L124-L148)
* **Line Range**: 124 - 148
* **Flaw Description**: The `/pawapay/callback` webhook endpoint parses the incoming body and immediately enqueues it with `signatureValid: true` without validation. Although the worker re-verifies status via `checkDepositStatus`, this allows unauthenticated actors to flood the endpoint with fake UUIDs.
* **Impact**:
  1. Denial of Service (DoS): The background queue worker makes outbound API requests for every fake event, exhausting HTTP sockets.
  2. Rate Limit Lockout: High webhook volume causes the system to spray pawaPay's endpoints, hitting API rate limits and blocking real payments.
* **Proposed Remediation**:
```javascript
// In src/server.js mount raw body parsing for pawapay callback:
// app.use('/api/payments/pawapay/callback', express.raw({ type: '*/*', limit: '1mb' }));

// In src/routes/payment.routes.js check RFC-9421 headers (Signature & Signature-Input):
router.post('/pawapay/callback', async (req, res) => {
  const signature = req.headers['signature'];
  const signatureInput = req.headers['signature-input'];
  const rawBody = req.body; 

  let valid = false;
  try {
    valid = pawapay.verifyPawapayWebhook(rawBody, signature, signatureInput);
  } catch (err) {
    logger.warn('pawaPay signature verify threw: %s', err.message);
  }

  if (!valid) {
    logger.warn('pawaPay webhook signature invalid');
    return res.status(401).send('invalid signature');
  }
  // Proceed to parse and enqueue...
});
```

### 3. Lock Acquisition Order Deadlock (Concurrency Failure)
* **File Path**: [subscription.service.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/services/subscription.service.js#L395-L488)
* **Line Range**: 395 - 448 (`cancelSubscription`), 479 - 488 (`suspendBusiness`)
* **Flaw Description**: `suspendBusiness` locks the `businesses` row first and then updates `subscriptions`. Conversely, `cancelSubscription` locks `subscriptions` first (via `FOR UPDATE`) and then updates `businesses`.
* **Impact**: Concurrent business suspension and merchant cancellation requests cause database deadlocks in PostgreSQL, resulting in query failures and aborted transactions.
* **Proposed Remediation**:
```javascript
// Lock the business row first in cancelSubscription to standardize lock hierarchy:
async function cancelSubscription(businessId) {
  return transaction(async client => {
    await client.query(`SELECT id FROM businesses WHERE id = $1 FOR UPDATE`, [businessId]);
    const subs = await client.query(
      `SELECT * FROM subscriptions WHERE business_id = $1 FOR UPDATE`,
      [businessId]
    );
    // Continue with updates...
  });
}
```

### 4. Subscription Renewal Stuck State (Blocking Lifecycle Bug)
* **File Path**: [payment.sweeper.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/services/payment.sweeper.js#L49-L115)
* **Line Range**: 49 - 115
* **Flaw Description**: Only one pending transaction is allowed per subscription to prevent double billing. If a payment is abandoned or a webhook is lost, the transaction remains `pending` in the database forever because `payment.sweeper.js` only reconciles orders, not billing transactions.
* **Impact**: The merchant is permanently blocked from renewing their subscription because the system refuses to initiate new transactions while one remains pending, eventually leading to business suspension.
* **Proposed Remediation**:
```javascript
// Add a sweeping step in payment.sweeper.js for pending billing transactions:
const staleBilling = await query(
  `SELECT * FROM billing_transactions WHERE status = 'pending' AND initiated_at < NOW() - ($1 || ' minutes')::interval LIMIT 25`,
  [String(PENDING_TTL_MINUTES)]
);
for (const tx of staleBilling.rows) {
  // Reconcile status with payment provider. If abandoned, update status to failed to release lock.
}
```

### 5. Double-Spend / Double-Redemption on Concurrent Promos & Rewards
* **File Path**: [order.service.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/services/order.service.js#L163-L168)
* **Line Range**: 163 - 168
* **Flaw Description**: Verification of a promo code's remaining uses or a loyalty reward's redemption status occurs outside the database transaction, but the usage update occurs inside the transaction.
* **Impact**: A customer can double-spend a reward or exceed a promo code limit by submitting checkout requests concurrently.
* **Proposed Remediation**:
```javascript
// Inside createOrder transaction block, verify and lock:
if (promo?.source === 'reward') {
  const lockRes = await client.query(`SELECT redeemed_at FROM customer_rewards WHERE id = $1 FOR UPDATE`, [promo.reward_id]);
  if (lockRes.rows[0]?.redeemed_at) throw new Error('Reward has already been redeemed');
  await client.query(`UPDATE customer_rewards SET redeemed_at = NOW() WHERE id = $1`, [promo.reward_id]);
} else if (promo?.id) {
  const lockRes = await client.query(`SELECT max_uses, used_count FROM promos WHERE id = $1 FOR UPDATE`, [promo.id]);
  if (lockRes.rows[0] && lockRes.rows[0].max_uses != null && lockRes.rows[0].used_count >= lockRes.rows[0].max_uses) {
    throw new Error('Promo code usage limit has been exceeded');
  }
  await client.query(`UPDATE promos SET used_count = used_count + 1 WHERE id = $1`, [promo.id]);
}
```

### 6. Over-Refund Concurrency Bypass
* **File Path**: [order.service.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/services/order.service.js#L515-L568)
* **Line Range**: 515 - 568
* **Flaw Description**: `createRefund` checks if the new refund amount exceeds the order's total value using a non-locking select. No transaction is used.
* **Impact**: Concurrent refund actions (e.g. merchant double-clicks) bypass the threshold check, resulting in over-refunds and loss of funds.
* **Proposed Remediation**:
```javascript
// Wrap in transaction and select order row FOR UPDATE:
return transaction(async client => {
  const orderRes = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
  // Calculate existing refunds, verify balance, trigger gateway, and save.
});
```

### 7. Permanent Message Loss from Webhook Payload Batching
* **File Path**: [webhook.routes.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/routes/webhook.routes.js#L78-L113)
* **Line Range**: 78 - 113
* **Flaw Description**: Meta batches webhook messages during traffic peaks. The webhook parsing logic assumes a 1:1 ratio and only checks `payload.entry[0].changes[0].value.messages[0]`.
* **Impact**: All messages starting from the second index in a batched payload are silently discarded and lost.
* **Proposed Remediation**:
```javascript
// Split batched messages and enqueue each individually:
const messages = value?.messages || [];
if (messages.length > 1) {
  for (const msg of messages) {
    const splitPayload = { ...payload, entry: [{ ...entry, changes: [{ ...change, value: { ...value, messages: [msg], statuses: [] } }] }] };
    await queue.enqueue({ source: 'whatsapp', externalId: `msg:${msg.id}`, payload: splitPayload, signatureValid: true });
  }
}
```

### 8. Webhook Queue: State Overwrite Concurrency Vulnerability
* **File Path**: [webhook.queue.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/services/webhook.queue.js#L87-L126)
* **Line Range**: 87 - 126
* **Flaw Description**: `markDone` and `markFailed` update status based solely on the `id` field. If processing exceeds `LOCK_TTL_SECONDS`, another worker claims the item. The original slow worker eventually completes and overwrites the active worker's state updates.
* **Impact**: Corrupt queue states and duplicate message processing.
* **Proposed Remediation**:
```javascript
// Filter updates by locking worker ID:
await query(`UPDATE webhook_events SET status = 'done', ... WHERE id = $1 AND locked_by = $2`, [eventId, WORKER_ID]);
```

### 9. Silent Delivery Failures on Transient WhatsApp API Outages
* **File Path**: [whatsapp.service.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/services/whatsapp.service.js#L86-L121)
* **Line Range**: 86 - 121
* **Flaw Description**: If outbound API requests fail due to transient errors (like HTTP 429, 503, or connection timeouts), `sendRaw` catches the exception and returns `{ success: false }`. Callers do not check this return value, allowing the queue message to be marked complete.
* **Impact**: Lost outbound replies and messages are never retried.
* **Proposed Remediation**:
```javascript
// Throw on transient errors to trigger queue retry mechanisms:
const status = err.response?.status;
const isTransient = !err.response || status === 429 || status >= 500 || err.code === 'ECONNABORTED';
if (isTransient) throw new Error(`Transient WhatsApp error: ${err.message}`);
return { success: false, error: err.message };
```

### 10. Concurrent Inserts Race Condition in `loadOrCreateState`
* **File Path**: [conversation.handler.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/services/conversation.handler.js#L294-L321)
* **Line Range**: 294 - 321
* **Flaw Description**: Parallel incoming messages from a new customer can cause multiple workers to execute `loadOrCreateState` concurrently, leading to duplicate database checks and concurrent insertions.
* **Impact**: One database insert throws a unique key constraint violation on `customer_id`, causing the webhook to abort and drop the message.
* **Proposed Remediation**:
```javascript
// Use ON CONFLICT or handle the duplicate error gracefully:
const ins = await query(
  `INSERT INTO conversation_state (customer_id, current_flow, current_step) 
   VALUES ($1, 'idle', 'start') 
   ON CONFLICT (customer_id) DO UPDATE SET updated_at = NOW() 
   RETURNING *`,
  [customerId]
);
```

### 11. Uncaught TypeError / Server Crash on Webhook Signature Checks
* **File Path**: [webhook.routes.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/routes/webhook.routes.js#L13-L28)
* **Line Range**: 13 - 28
* **Flaw Description**: `crypto.createHmac(...).update(rawBody)` is executed directly. If `rawBody` is missing or undefined, `update()` throws a TypeError.
* **Impact**: A malformed request crashes the request process and could terminate the application node if the handler is not caught.
* **Proposed Remediation**:
```javascript
if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') return false;
```

---

## 🌀 Medium Severity Findings

### 12. Broken Inventory/Availability Verification on Order Creation
* **File Path**: [order.routes.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/routes/order.routes.js#L186-L233)
* **Line Range**: 186 - 233
* **Flaw Description**: The checkout route does not verify if a product is out of stock, hidden, or outside its daily availability window (`available_from`/`available_to`).
* **Impact**: Customers can order unavailable, hidden, or out-of-stock items, leading to fulfillment cancellations.
* **Proposed Remediation**: Add checks for `in_stock`, `hidden`, and `isWithinBusinessHours()` during product lookup before completing order insertion.

### 13. Cyclic Dependency Database Deadlocks in Stock Decrementing
* **File Path**: [order.service.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/services/order.service.js#L756-L787)
* **Line Range**: 756 - 787
* **Flaw Description**: The stock decrement function updates product quantities in the exact order they appear in the cart array. Concurrent checkouts requesting the same items in different order permutations cause cyclic lock dependency.
* **Impact**: Transactions abort with `deadlock detected`, interrupting customer orders.
* **Proposed Remediation**: Sort the cart items array by `product_id` and `variant_id` before processing DB updates.

### 14. Subscription Mismatch from Plan-Drift
* **File Path**: [subscription.service.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/services/subscription.service.js#L231-L242)
* **Line Range**: 231 - 242
* **Flaw Description**: The `billing_transactions` table does not store the target `plan_id` at initiation. On payment success, the plan is resolved dynamically from `s.pending_plan_id`. If `pending_plan_id` changes before the webhook completes, it joins to the wrong plan.
* **Impact**: A customer can be upgraded to the wrong tier or drift into an invalid subscription state.
* **Proposed Remediation**: Add a `plan_id` foreign key column to `billing_transactions` and populate it at transaction initialization.

### 15. Premature Subscription Renewal Failure on Gateway Network Timeouts
* **File Path**: [subscription.service.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/services/subscription.service.js#L189-L198)
* **Line Range**: 189 - 198
* **Flaw Description**: When `chargeSubscription` encounters a connection timeout, the transaction status is marked as `failed` immediately.
* **Impact**: If the provider subsequently succeeds in processing the charge and sends a callback, our server rejects it, leading to double-charging.
* **Proposed Remediation**: Check if the gateway failure is a transport error (e.g. timeout); if so, keep the status as `pending` to allow webhook resolving.

### 16. Non-Atomic Loops in Category Reordering and Product Imports
* **File Path**: [category.routes.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/routes/category.routes.js#L141-L149)
* **Line Range**: 141 - 149
* **Flaw Description**: Bulk insertions or reordering loops are performed without enclosing database transactions.
* **Impact**: A single query error leaves the database in a corrupt, partially updated state.
* **Proposed Remediation**: Wrap the batch updates loop in a transaction wrapper block.

### 17. Masked Execution Errors in `withLock` Helper
* **File Path**: [worker.lock.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/services/worker.lock.js#L46-L58)
* **Line Range**: 46 - 58
* **Flaw Description**: If the callback execution throws, the `finally` block runs `release()`. If `release()` throws an error, it overrides the callback's error.
* **Impact**: The root error is lost, complicating server diagnostics.
* **Proposed Remediation**: Wrap the lock `release()` call in an internal try/catch block to log but not propagate errors.

### 18. Constant Write Contention from Webhook Processor Tick
* **File Path**: [webhook.processor.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/services/webhook.processor.js#L193-L206)
* **Line Range**: 193 - 206
* **Flaw Description**: `reclaimStuck()` is executed on every tick (every 1.5 seconds) scanning the entire database table.
* **Impact**: High database IOPS and transaction log bloat.
* **Proposed Remediation**: Execute `reclaimStuck()` on a cooldown timer (e.g., once every 60 seconds).

### 19. Un-drained Active Workers on Graceful Shutdown
* **File Path**: [worker.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/worker.js#L83-L92)
* **Line Range**: 83 - 92
* **Flaw Description**: Upon receiving termination signals, the worker closes the pool immediately without waiting for currently processing webhooks.
* **Impact**: Mid-flight webhooks are truncated and remain stuck in `'processing'` status.
* **Proposed Remediation**: Poll active execution metrics and wait up to 10 seconds before terminating the PG connection pool.

### 20. File Descriptor Leak in Log Tailer
* **File Path**: [admin.routes.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/routes/admin.routes.js#L431-L460)
* **Line Range**: 431 - 460
* **Flaw Description**: `fs.openSync` opens the log file, but if subsequent buffer reads fail, `fs.closeSync` is bypassed.
* **Impact**: Resource exhaustion (file descriptor leak) leading to server errors.
* **Proposed Remediation**: Wrap file read logic in a `try...finally` block to guarantee closing.

### 21. Missing Permission Check on API Key List Route
* **File Path**: [apikey.routes.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/routes/apikey.routes.js#L23-L39)
* **Line Range**: 23 - 39
* **Flaw Description**: `GET /api/keys` lacks a permission middleware.
* **Impact**: Any low-privileged employee can inspect the metadata of all API keys.
* **Proposed Remediation**: Protect the route using `requirePermission('staff', 'read')`.

---

## 🍃 Low Severity Findings

### 22. Leading Whitespace Formula Injection Bypass in CSV Exports
* **File Path**: [csv.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/utils/csv.js#L8-L12)
* **Line Range**: 8 - 12
* **Flaw Description**: The escaping regex `/^[=+\-@\t\r]/` fails if a formula character (e.g. ` =1+1`) is preceded by a whitespace character.
* **Impact**: Spreads formula execution (CSV injection) on spreadsheet software.
* **Proposed Remediation**: Use `/^\s*[=+\-@\t\r]/` and trim prefix spaces.

### 23. Invalid Date Formats Cause Unhandled DB Errors
* **File Path**: [promo.routes.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/routes/promo.routes.js#L47-L54)
* **Line Range**: 47 - 54
* **Flaw Description**: Date values (e.g., `expires_at`) are saved directly. Invalid strings crash the database.
* **Impact**: 500 errors and unhandled exceptions.
* **Proposed Remediation**: Validate that the input is a valid future ISO timestamp.

### 24. Active Cron Jobs Fail on Graceful Database Pool Termination
* **File Path**: [server.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/server.js#L332-L340)
* **Line Range**: 332 - 340
* **Flaw Description**: The application shuts down without terminating cron jobs, which can still fire and query the closed pool.
* **Impact**: Node crash logs are generated on standard deployments.
* **Proposed Remediation**: Loop over active crons and stop them before termination.

### 25. Missing Currency Verification on Paystack Webhooks
* **File Path**: [webhook.processor.js](file:///Users/kwamesekyi/Downloads/Telegram%20Desktop/wa-b%202.0/src/services/webhook.processor.js#L32-L53)
* **Line Range**: 32 - 53
* **Flaw Description**: Paystack supports multi-currency setups, but the webhook doesn't verify the currency.
* **Impact**: A customer paying 10 NGN instead of 10 GHS is mistakenly credited the full 10 GHS.
* **Proposed Remediation**: Drop Paystack events if the payload currency is not `GHS`.
