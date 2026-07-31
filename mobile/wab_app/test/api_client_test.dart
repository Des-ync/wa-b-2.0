import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:wab_app/api/accounting_api.dart';
import 'package:wab_app/api/broadcast_api.dart';
import 'package:wab_app/api/client.dart';
import 'package:wab_app/api/customer_api.dart';
import 'package:wab_app/api/inventory_api.dart';
import 'package:wab_app/api/staff_api.dart';
import 'package:wab_app/api/order_api.dart';

/// The API layer.
///
/// The 2026-07 audit's cross-area risk #6 was that "does the app call
/// endpoint X, with field Y" could only be answered by grepping call sites —
/// which is how the mark-paid bug survived, since PATCH .../status was
/// quietly reused for something it never did. These tests turn each path and
/// body shape into an assertion, so a rename on either side of the wire
/// fails here rather than in a merchant's hands.

class Capture {
  final List<http.Request> requests = [];

  ApiClient client({
    Map<String, dynamic> body = const {'success': true},
    int status = 200,
  }) {
    return ApiClient(
      httpClient: MockClient((req) async {
        requests.add(req);
        return http.Response(jsonEncode(body), status,
            headers: {'content-type': 'application/json'});
      }),
    );
  }

  http.Request get last => requests.last;
  Map<String, dynamic> get lastBody =>
      jsonDecode(last.body) as Map<String, dynamic>;
}

void main() {
  envelopeTests();
  group('transport', () {
    test('attaches the bearer token once a key is set', () async {
      final cap = Capture();
      final api = cap.client()..apiKey = 'sk_live_abc';

      await api.get('/api/orders');

      expect(cap.last.headers['Authorization'], 'Bearer sk_live_abc');
      expect(cap.last.headers['Content-Type'], contains('application/json'));
    });

    test('sends no Authorization header when signed out', () async {
      final cap = Capture();
      await cap.client().get('/api/health');
      expect(cap.last.headers.containsKey('Authorization'), isFalse);
    });

    test('serializes query parameters as strings', () async {
      final cap = Capture();
      await cap.client().get('/api/orders',
          query: {'business_id': 'biz-1', 'limit': 10, 'paid': true});

      expect(cap.last.url.queryParameters,
          {'business_id': 'biz-1', 'limit': '10', 'paid': 'true'});
    });

    test('a non-2xx response becomes an ApiException carrying the server text',
        () async {
      final cap = Capture();
      final api = cap.client(
          body: {'success': false, 'error': 'Order not found'}, status: 404);

      await expectLater(
        api.get('/api/orders/nope'),
        throwsA(isA<ApiException>()
            .having((e) => e.status, 'status', 404)
            .having((e) => e.message, 'message', 'Order not found')),
      );
    });

    test('a 200 carrying success:false is still an error', () async {
      // Several routes answer 200 with an error envelope; treating that as
      // success would show the merchant a silent no-op as a completed action.
      final cap = Capture();
      final api =
          cap.client(body: {'success': false, 'error': 'Already refunded'});

      await expectLater(api.post('/api/orders/x/refund'),
          throwsA(isA<ApiException>().having((e) => e.status, 'status', 200)));
    });

    test('an unparseable body still produces a usable message', () async {
      final api = ApiClient(
          httpClient: MockClient((_) async => http.Response('<html>502</html>', 502)));

      await expectLater(
        api.get('/api/orders'),
        throwsA(isA<ApiException>()
            .having((e) => e.message, 'message', contains('502'))),
      );
    });

    test('a dropped connection reads as a network error, not a crash',
        () async {
      final api = ApiClient(
          httpClient: MockClient((_) async => throw Exception('reset by peer')));

      await expectLater(
        api.get('/api/orders'),
        throwsA(isA<ApiException>()
            .having((e) => e.status, 'status', 0)
            .having((e) => e.message, 'message', contains('Network error'))),
      );
    });

    test('sibling() shares the transport but not the credential', () async {
      final cap = Capture();
      final api = cap.client()..apiKey = 'sk_live_session';
      final probe = api.sibling()..apiKey = 'sk_admin_candidate';

      await probe.get('/api/admin/stats');

      expect(cap.last.headers['Authorization'], 'Bearer sk_admin_candidate');
      expect(api.apiKey, 'sk_live_session',
          reason: 'the probe must not touch the live session key');
    });
  });

  group('OrderApi', () {
    test('markOrderPaid posts to the unified paid-path route', () async {
      final cap = Capture();
      await cap.client().markOrderPaid('ord-1');

      // NOT PATCH /status — that route no longer accepts 'paid' at all, and
      // reusing it was the original bug.
      expect(cap.last.method, 'POST');
      expect(cap.last.url.path, '/api/orders/ord-1/mark-paid');
      expect(cap.lastBody, {'method': 'cash'});
    });

    test('markOrderPaid sends an explicit amount only when given', () async {
      final cap = Capture();
      await cap.client().markOrderPaid('ord-1', method: 'momo', amountGhs: 45.5);

      expect(cap.lastBody, {'method': 'momo', 'amount_ghs': 45.5});
    });

    test('assignRider omits an empty phone rather than sending a blank',
        () async {
      final cap = Capture();
      await cap.client().assignRider('ord-1', riderName: 'Kofi', riderPhone: '');

      // The backend skips the rider WhatsApp when no phone is given; an
      // empty string would be a phone that fails to normalize instead.
      expect(cap.last.method, 'PATCH');
      expect(cap.last.url.path, '/api/orders/ord-1/delivery');
      expect(cap.lastBody, {'rider_name': 'Kofi'});
    });

    test('assignRider includes a real phone', () async {
      final cap = Capture();
      await cap
          .client()
          .assignRider('ord-1', riderName: 'Kofi', riderPhone: '233241234567');

      expect(cap.lastBody,
          {'rider_name': 'Kofi', 'rider_phone': '233241234567'});
    });

    test('updateDeliveryStatus hits the same delivery route', () async {
      final cap = Capture();
      await cap.client().updateDeliveryStatus('ord-1', 'picked_up');

      expect(cap.last.url.path, '/api/orders/ord-1/delivery');
      expect(cap.lastBody, {'delivery_status': 'picked_up'});
    });

    test('setOrderEstimates sends ISO-8601 timestamps', () async {
      final cap = Capture();
      final ready = DateTime.utc(2026, 7, 30, 14, 30);
      await cap.client().setOrderEstimates('ord-1', readyAt: ready);

      expect(cap.last.url.path, '/api/orders/ord-1/estimates');
      expect(cap.lastBody['estimated_ready_at'], ready.toIso8601String());
      expect(cap.lastBody.containsKey('estimated_delivery_at'), isFalse);
    });

    test('refundOrder requires an amount and drops an empty reason', () async {
      final cap = Capture();
      await cap.client().refundOrder('ord-1', amountGhs: 20, reason: '');

      expect(cap.last.method, 'POST');
      expect(cap.last.url.path, '/api/orders/ord-1/refund');
      expect(cap.lastBody, {'amount_ghs': 20.0});
    });

    test('addOrderNote patches the notes route', () async {
      final cap = Capture();
      await cap.client().addOrderNote('ord-1', 'Customer called twice');

      expect(cap.last.method, 'PATCH');
      expect(cap.last.url.path, '/api/orders/ord-1/notes');
      expect(cap.lastBody, {'note': 'Customer called twice'});
    });

    test('sendPaymentReminder posts with no body', () async {
      final cap = Capture();
      await cap.client().sendPaymentReminder('ord-1');

      expect(cap.last.url.path, '/api/orders/ord-1/payment-reminder');
      expect(cap.lastBody, isEmpty);
    });

    test('a rate-limited reminder surfaces the server 429', () async {
      final api = Capture().client(
          body: {
            'success': false,
            'error': 'A reminder was already sent for this order in the last 10 minutes'
          },
          status: 429);

      await expectLater(
        api.sendPaymentReminder('ord-1'),
        throwsA(isA<ApiException>().having((e) => e.status, 'status', 429)),
      );
    });
  });

  group('StaffApi', () {
    test('creating a key sends name and role', () async {
      final cap = Capture();
      await cap.client().createStaffKey('biz-1', name: 'Ama', role: 'support');

      expect(cap.last.method, 'POST');
      expect(cap.last.url.path, '/api/keys');
      expect(cap.lastBody, {'business_id': 'biz-1', 'name': 'Ama', 'role': 'support'});
    });

    test('an absent expiry means the key does not expire', () async {
      final cap = Capture();
      await cap.client().createStaffKey('biz-1', name: 'Ama', role: 'support', expiresAt: '');
      expect(cap.lastBody.containsKey('expires_at'), isFalse);

      await cap.client().createStaffKey('biz-1', name: 'Ama', role: 'support',
          expiresAt: '2027-01-01T00:00:00Z');
      expect(cap.lastBody['expires_at'], '2027-01-01T00:00:00Z');
    });

    test('revoke and rotate target the right key and are distinct', () async {
      final cap = Capture();
      await cap.client().revokeStaffKey('key-1');
      expect(cap.last.url.path, '/api/keys/key-1/revoke');

      await cap.client().rotateStaffKey('key-1');
      // Rotating an intended revoke would leave the person with access.
      expect(cap.last.url.path, '/api/keys/key-1/rotate');
    });

    test('the role list matches the backend capability matrix', () async {
      // src/utils/permissions.js — if a role is added there and not here, the
      // picker silently cannot grant it.
      expect(staffRoles.keys.toSet(),
          {'owner', 'manager', 'support', 'accountant', 'readonly'});
      for (final r in staffRoles.values) {
        expect(r.summary, isNotEmpty,
            reason: 'a role with no explanation cannot be granted safely');
      }
    });
  });

  group('InventoryApi', () {
    test('restock ADDS to stock; adjust SETS it', () async {
      final cap = Capture();
      await cap.client().restock('biz-1', productId: 'p1', quantity: 12);
      expect(cap.last.url.path, '/api/inventory/restock');
      expect(cap.lastBody, {'business_id': 'biz-1', 'product_id': 'p1', 'quantity': 12});

      await cap.client().adjustStock('biz-1', productId: 'p1', newQuantity: 7);
      // A different endpoint on purpose: a delivery and a stock take are
      // different events, and the ledger has to tell them apart.
      expect(cap.last.url.path, '/api/inventory/adjust');
      expect(cap.lastBody['new_quantity'], 7);
      expect(cap.lastBody.containsKey('quantity'), isFalse);
    });

    test('restock omits blank optional fields rather than sending nulls', () async {
      final cap = Capture();
      await cap.client().restock('biz-1',
          productId: 'p1', quantity: 5, supplierId: '', note: '');

      expect(cap.lastBody, {'business_id': 'biz-1', 'product_id': 'p1', 'quantity': 5});
    });

    test('restock carries cost and supplier when given', () async {
      final cap = Capture();
      await cap.client().restock('biz-1',
          productId: 'p1', quantity: 5, unitCostGhs: 12.5, supplierId: 's1', note: 'van delivery');

      expect(cap.lastBody['unit_cost_ghs'], 12.5);
      expect(cap.lastBody['supplier_id'], 's1');
      expect(cap.lastBody['note'], 'van delivery');
    });

    test('a stock take of ZERO is a real value, not an omission', () async {
      final cap = Capture();
      await cap.client().adjustStock('biz-1', productId: 'p1', newQuantity: 0);

      // "I counted none" must reach the server — dropping it would leave the
      // old count standing.
      expect(cap.lastBody['new_quantity'], 0);
    });

    test('movements can be scoped to one product', () async {
      final cap = Capture();
      await cap.client().getStockMovements('biz-1');
      expect(cap.last.url.queryParameters.containsKey('product_id'), isFalse);
      expect(cap.last.url.queryParameters['limit'], '50');

      await cap.client().getStockMovements('biz-1', productId: 'p1', limit: 10);
      expect(cap.last.url.queryParameters['product_id'], 'p1');
      expect(cap.last.url.queryParameters['limit'], '10');
    });

    test('margins, suppliers and reorder suggestions are business-scoped', () async {
      final cap = Capture();
      for (final call in [
        () => cap.client().getMargins('biz-1'),
        () => cap.client().getSuppliers('biz-1'),
        () => cap.client().getReorderSuggestions('biz-1'),
      ]) {
        await call();
        expect(cap.last.url.queryParameters['business_id'], 'biz-1');
      }
    });

    test('adding a supplier requires only a name', () async {
      final cap = Capture();
      await cap.client().addSupplier('biz-1', name: 'Kofi Wholesale');

      expect(cap.last.method, 'POST');
      expect(cap.lastBody, {'business_id': 'biz-1', 'name': 'Kofi Wholesale'});
    });
  });

  group('CustomerApi', () {
    test('profile and loyalty are separate calls', () async {
      final cap = Capture();
      await cap.client().getCustomerProfile('cust-1');
      expect(cap.last.url.path, '/api/customers/cust-1/profile');

      await cap.client().getCustomerLoyalty('cust-1');
      expect(cap.last.url.path, '/api/customers/cust-1/loyalty');
    });

    test('tags replace the whole set', () async {
      final cap = Capture();
      await cap.client().setCustomerTags('cust-1', ['vip', 'wholesale']);

      expect(cap.last.method, 'PATCH');
      expect(cap.last.url.path, '/api/customers/cust-1/tags');
      expect(cap.lastBody, {'tags': ['vip', 'wholesale']});
    });

    test('an empty tag list clears them rather than being dropped', () async {
      final cap = Capture();
      await cap.client().setCustomerTags('cust-1', []);
      // Sending nothing would leave the old tags in place — the merchant
      // removing every tag must actually remove them.
      expect(cap.lastBody, {'tags': []});
    });

    test('address note and birthday both accept null to clear', () async {
      final cap = Capture();
      await cap.client().setCustomerAddressNote('cust-1', null);
      expect(cap.last.url.path, '/api/customers/cust-1/address-note');
      expect(cap.lastBody, {'address_note': null});

      await cap.client().setCustomerBirthday('cust-1', null);
      expect(cap.lastBody, {'date_of_birth': null});

      await cap.client().setCustomerBirthday('cust-1', '1990-04-12');
      expect(cap.lastBody, {'date_of_birth': '1990-04-12'});
    });

    test('redeeming points posts an integer count', () async {
      final cap = Capture();
      await cap.client().redeemCustomerPoints('cust-1', points: 100);

      expect(cap.last.method, 'POST');
      expect(cap.last.url.path, '/api/customers/cust-1/loyalty/redeem-points');
      expect(cap.lastBody, {'points': 100});
    });
  });

  group('BroadcastApi', () {
    test('preview posts the audience and is read-only', () async {
      final cap = Capture();
      await cap.client().previewBroadcast('biz-1', audience: {'segment': 'inactive_60d'});

      expect(cap.last.url.path, '/api/broadcasts/preview');
      expect(cap.lastBody, {
        'business_id': 'biz-1',
        'audience': {'segment': 'inactive_60d'}
      });
    });

    test('preview omits an empty audience rather than sending {}', () async {
      final cap = Capture();
      await cap.client().previewBroadcast('biz-1', audience: {});
      expect(cap.lastBody, {'business_id': 'biz-1'});

      await cap.client().previewBroadcast('biz-1');
      expect(cap.lastBody, {'business_id': 'biz-1'});
    });

    test('a test send targets the test route, not the real one', () async {
      final cap = Capture();
      await cap.client().sendBroadcastTest('biz-1', body: 'Fresh jollof!');

      // Hitting /api/broadcasts here would send to every customer.
      expect(cap.last.url.path, '/api/broadcasts/test');
      expect(cap.lastBody, {'business_id': 'biz-1', 'body': 'Fresh jollof!'});
    });
  });

  group('AccountingApi', () {
    test('every payout route is scoped to one business', () async {
      final cap = Capture();
      final api = cap.client();

      await api.getPayoutBalance('biz-1');
      expect(cap.last.url.path, '/api/accounting/payout-balance');
      expect(cap.last.url.queryParameters['business_id'], 'biz-1');

      await api.getPayouts('biz-1');
      expect(cap.last.url.path, '/api/accounting/payouts');
      expect(cap.last.url.queryParameters['business_id'], 'biz-1');

      await api.getReconciliation('biz-1');
      expect(cap.last.url.path, '/api/accounting/reconciliation');
      expect(cap.last.url.queryParameters['business_id'], 'biz-1');
    });

    test('requestAutoPayout is the one call that moves money', () async {
      final cap = Capture();
      await cap.client().requestAutoPayout('biz-1', amountGhs: 450.0);

      expect(cap.last.method, 'POST');
      // NOT /payouts, which only records a transfer already sent by hand.
      expect(cap.last.url.path, '/api/accounting/payouts/auto');
      expect(cap.lastBody, {'business_id': 'biz-1', 'amount_ghs': 450.0});
    });

    test('an OTP-blocked payout surfaces the 409 rather than looking pending',
        () async {
      final api = Capture().client(
          body: {
            'success': false,
            'error': 'Transfer requires OTP approval on the Paystack dashboard'
          },
          status: 409);

      await expectLater(
        api.requestAutoPayout('biz-1', amountGhs: 10),
        throwsA(isA<ApiException>().having((e) => e.status, 'status', 409)),
      );
    });

    test('recordManualPayout omits blank optional fields', () async {
      final cap = Capture();
      await cap.client().recordManualPayout('biz-1',
          amountGhs: 200, momoNumber: '', momoNetwork: 'mtn', note: 'cash out');

      expect(cap.last.url.path, '/api/accounting/payouts');
      expect(cap.lastBody,
          {'business_id': 'biz-1', 'amount_ghs': 200.0, 'momo_network': 'mtn', 'note': 'cash out'});
    });

    test('addExpense defaults category and date server-side when omitted',
        () async {
      final cap = Capture();
      await cap.client().addExpense('biz-1', amountGhs: 35.5);

      expect(cap.last.url.path, '/api/accounting/expenses');
      expect(cap.lastBody, {'business_id': 'biz-1', 'amount_ghs': 35.5});

      await cap.client().addExpense('biz-1',
          amountGhs: 35.5, category: 'transport', expenseDate: '2026-07-30');
      expect(cap.lastBody['category'], 'transport');
      expect(cap.lastBody['expense_date'], '2026-07-30');
    });

    test('profit-loss and expenses accept an optional date range', () async {
      final cap = Capture();
      await cap.client().getProfitLoss('biz-1');
      expect(cap.last.url.queryParameters, {'business_id': 'biz-1'});

      await cap.client().getProfitLoss('biz-1', from: '2026-07-01', to: '2026-07-31');
      expect(cap.last.url.queryParameters['from'], '2026-07-01');
      expect(cap.last.url.queryParameters['to'], '2026-07-31');

      await cap.client().getExpenses('biz-1', from: '2026-07-01');
      expect(cap.last.url.path, '/api/accounting/expenses');
      expect(cap.last.url.queryParameters['from'], '2026-07-01');
    });

    test('getDailySales omits the date to mean today', () async {
      final cap = Capture();
      await cap.client().getDailySales('biz-1');

      expect(cap.last.url.queryParameters.containsKey('date'), isFalse);

      await cap.client().getDailySales('biz-1', date: '2026-07-30');
      expect(cap.last.url.queryParameters['date'], '2026-07-30');
    });
  });
}

/// --------------------------------------------------------------------------
/// Response-envelope negotiation (Phase 3).
///
/// Route groups migrate to the v2 envelope one at a time, so a deployed build
/// must handle a server that is answering BOTH shapes depending on the route.
/// --------------------------------------------------------------------------
void envelopeTests() {
  group('envelope negotiation', () {
    test('the version header is only sent when opted in', () async {
      final cap = Capture();
      final api = cap.client();

      await api.get('/api/categories');
      expect(cap.last.headers.containsKey('X-API-Version'), isFalse,
          reason: 'legacy must stay the default for deployed builds');

      api.useV2Envelope = true;
      await api.get('/api/categories');
      expect(cap.last.headers['X-API-Version'], '2');
    });

    test('a v2 success is unwrapped so call sites stay unchanged', () async {
      final api = Capture().client(body: {
        'success': true,
        'data': {
          'categories': [
            {'id': 'c1', 'name': 'drinks'}
          ]
        },
      });

      final res = await api.get('/api/categories');

      // Every existing call site reads res['categories'] directly.
      expect(res['categories'], isA<List>());
      expect(res['categories'][0]['name'], 'drinks');
      expect(res['success'], isTrue);
    });

    test('v2 meta is flattened alongside the data', () async {
      final api = Capture().client(body: {
        'success': true,
        'data': {'orders': []},
        'meta': {'total': 42},
      });

      final res = await api.get('/api/orders');

      expect(res['orders'], isEmpty);
      expect(res['total'], 42);
    });

    test('a legacy success passes through untouched', () async {
      final api = Capture().client(body: {
        'success': true,
        'categories': [
          {'id': 'c1'}
        ]
      });

      final res = await api.get('/api/categories');
      expect(res['categories'][0]['id'], 'c1');
    });

    test('a v2 error exposes code and per-field reasons', () async {
      final api = Capture().client(body: {
        'success': false,
        'error': {
          'code': 'validation_error',
          'message': 'name is required',
          'fields': {'name': 'is required', 'sort_order': 'must be a whole number'},
        },
      }, status: 400);

      try {
        await api.post('/api/categories');
        fail('should have thrown');
      } on ApiException catch (e) {
        expect(e.status, 400);
        expect(e.code, 'validation_error');
        expect(e.isValidation, isTrue);
        expect(e.message, 'name is required');
        // The point of the whole layer: a form can mark the right input.
        expect(e.fieldError('name'), 'is required');
        expect(e.fieldError('sort_order'), 'must be a whole number');
        expect(e.fieldError('nothing'), isNull);
      }
    });

    test('a v2 error with no fields still parses', () async {
      final api = Capture().client(
          body: {
            'success': false,
            'error': {'code': 'not_found', 'message': 'Category not found'}
          },
          status: 404);

      try {
        await api.get('/api/categories/x');
        fail('should have thrown');
      } on ApiException catch (e) {
        expect(e.code, 'not_found');
        expect(e.fields, isEmpty);
        expect(e.isValidation, isFalse);
      }
    });

    test('a legacy error still surfaces its string as both message and code',
        () async {
      // auth.routes.js returns a bare `error: 'link_required'` and login.dart
      // branches on e.code — dropping this mapping silently breaks
      // Clerk-linked sign-in, which no other test would catch.
      final api = Capture().client(
          body: {'success': false, 'error': 'link_required'}, status: 409);

      try {
        await api.post('/api/auth/mobile/verify');
        fail('should have thrown');
      } on ApiException catch (e) {
        expect(e.code, 'link_required');
        expect(e.message, 'link_required');
        expect(e.fields, isEmpty);
      }
    });

    test('a 200 carrying a v2 error envelope is still an error', () async {
      final api = Capture().client(body: {
        'success': false,
        'error': {'code': 'conflict', 'message': 'Already refunded'}
      });

      await expectLater(
          api.post('/api/orders/x/refund'),
          throwsA(isA<ApiException>()
              .having((e) => e.code, 'code', 'conflict')));
    });
  });
}
