import 'client.dart';

/// The four deeper analytics views, none of which had a client.
///
/// Each answers a question the overview cannot: where the money actually
/// comes from after cost, whether customers come back, whether deliveries
/// arrive when promised, and which channel is worth the effort.
extension AnalyticsApi on ApiClient {
  /// Gross margin from what actually SOLD — paid line items × each product's
  /// cost price. Not the same as the catalog margin in Inventory, which is
  /// price-minus-cost per listing and unweighted by sales.
  ///
  /// Products with no cost price set are counted in revenue but excluded
  /// from margin, so the response carries `margin_known_pct` to say how much
  /// of the revenue the profit picture actually covers.
  Future<Map<String, dynamic>> getProfit(String businessId, {int days = 30}) {
    return get('/api/analytics/profit',
        query: {'business_id': businessId, 'days': days});
  }

  /// New vs returning customers in the window, plus the 7- and 30-day
  /// repeat-purchase rates. Both rates are returned regardless of the window
  /// asked for, since comparing them is the point.
  Future<Map<String, dynamic>> getCohorts(String businessId, {int days = 30}) {
    return get('/api/analytics/cohorts',
        query: {'business_id': businessId, 'days': days});
  }

  /// Time from rider assignment to delivery, and lateness against the
  /// merchant's own ETA. Orders with no ETA set cannot be late and are
  /// excluded from the late rate, but still count toward the average time.
  Future<Map<String, dynamic>> getDeliverySla(String businessId,
      {int days = 30}) {
    return get('/api/analytics/delivery-sla',
        query: {'business_id': businessId, 'days': days});
  }

  /// Orders and revenue split by where the order STARTED — a storefront
  /// guest checkout counts as storefront even though it resolves to the same
  /// WhatsApp customer identity.
  Future<Map<String, dynamic>> getChannels(String businessId, {int days = 30}) {
    return get('/api/analytics/channels',
        query: {'business_id': businessId, 'days': days});
  }
}

/// Which windows each view actually accepts, mirroring analytics.routes.js.
///
/// These differ, and the difference matters: the server silently falls back
/// to its default when handed a window it does not accept, so offering 90d
/// on a view that only supports 7 and 30 would show 30-day figures under a
/// "90d" label. The UI clamps to this instead of guessing.
const analyticsWindows = <String, List<int>>{
  'overview': [7, 30],
  'profit': [7, 30, 90],
  'cohorts': [7, 30],
  'delivery': [7, 30, 90],
  'channels': [7, 30, 90],
};
