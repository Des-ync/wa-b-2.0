import 'client.dart';

/// Customer segments and tags.
///
/// The summary endpoint had no client anywhere. What made it worth
/// surfacing is not the three numbers — it is that the SAME filter spec
/// (`segment`, `tag`, `min_spend_ghs`) already drives both the customer list
/// and broadcast targeting server-side, so a count is one tap away from
/// "show me these people" and "message these people".
extension SegmentsApi on ApiClient {
  /// Live counts for each predefined segment, plus the top 20 tags in use.
  ///
  /// Returns `{segments: [{key, label, count}], tags: [{tag, n}]}`.
  Future<Map<String, dynamic>> getSegmentSummary(String businessId) {
    return get('/api/customers/segments/summary',
        query: {'business_id': businessId});
  }
}

/// The predefined segments, mirroring src/utils/audience.js.
///
/// The summary response carries its own labels, so this exists only for the
/// places that need a segment key BEFORE the summary has loaded — the
/// broadcast composer already keeps its own copy for the same reason.
const customerSegments = <String, String>{
  'ordered_30d': 'Ordered in last 30 days',
  'inactive_60d': 'Inactive for 60+ days',
  'abandoned_cart': 'Has an abandoned cart',
};

/// What each segment is actually useful FOR.
///
/// A count on its own does not tell a merchant what to do with it. These are
/// the reason each segment exists, shown next to it.
const segmentPurpose = <String, String>{
  'ordered_30d': 'Your active buyers — good for a thank-you or a new arrival.',
  'inactive_60d': 'Slipping away. A win-back message goes here.',
  'abandoned_cart': 'They started an order and stopped. A nudge often finishes it.',
};
