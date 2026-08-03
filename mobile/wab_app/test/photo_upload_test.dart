import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';
import 'package:wab_app/api/client.dart';
import 'package:wab_app/api/upload_api.dart';
import 'package:wab_app/state/session.dart';
import 'package:wab_app/widgets/product_photo_picker.dart';
import 'package:wab_app/widgets/product_quick_edit.dart';

/// Product photo upload.
///
/// Two things carry real risk. The upload must send the bytes as the RAW body
/// with the right content type, because the server identifies the image from
/// its magic bytes and refuses a mismatch. And the stored value must render:
/// uploads are saved as a RELATIVE path so the value survives a domain change
/// and works as a `src` on the web, but a Flutter app has no page origin to
/// resolve against — get that wrong and every uploaded photo is silently blank.

class _FakePicker extends ProductPhotoPicker {
  _FakePicker(this._result) : super();
  final ({List<int> bytes, String contentType})? _result;
  bool called = false;
  ImageSource? usedSource;

  @override
  Future<({List<int> bytes, String contentType})?> pick(ImageSource source) async {
    called = true;
    usedSource = source;
    return _result;
  }
}

/// Once a product has an `image_url`, the sheet mounts a CachedNetworkImage,
/// which kicks off a real disk-cache lookup (flutter_cache_manager) with no
/// platform-channel mock in this test binding — that lookup never resolves,
/// so `pumpAndSettle()` would wait for it forever. These tests don't care
/// about the thumbnail's own load state, only the surrounding button text,
/// which updates synchronously — a bounded number of pumps is enough to
/// flush everything else (the mocked upload's Future, the bottom sheet's
/// pop animation) without waiting on the image.
Future<void> pumpABit(WidgetTester tester) async {
  for (var i = 0; i < 10; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

void main() {
  group('resolveImageUrl', () {
    test('resolves our own relative upload path against the API host', () {
      // The server returns "/wa-b/uploads/…". Rendered raw, Image.network gets
      // a path with no host and every uploaded photo shows as broken.
      final out = resolveImageUrl('/wa-b/uploads/biz-1/abc.jpg');
      expect(out, '${ApiClient.baseUrl}/wa-b/uploads/biz-1/abc.jpg');
      expect(Uri.parse(out).isAbsolute, isTrue);
    });

    test('keeps an absolute https link as-is', () {
      expect(resolveImageUrl('https://cdn.test/a.png'), 'https://cdn.test/a.png');
    });

    test('refuses a non-https absolute link', () {
      // image_url is stored data any teammate or CSV import can set, and
      // rendering it makes this device fetch whatever host it names. http://
      // would be a cleartext fetch, and can probe hosts on the merchant's own
      // network.
      expect(resolveImageUrl('http://192.168.1.1/probe.png'), '');
      expect(resolveImageUrl('file:///etc/passwd'), '');
      expect(resolveImageUrl('javascript:alert(1)'), '');
    });

    test('refuses a protocol-relative URL wearing a path\'s clothes', () {
      // "//evil.test/x.png" starts with "/" but is NOT our path — it is
      // another host. Treating it as relative would fetch from that host.
      expect(resolveImageUrl('//evil.test/x.png'), '');
    });

    test('empty and null are "no thumbnail", not an error', () {
      expect(resolveImageUrl(null), '');
      expect(resolveImageUrl(''), '');
      expect(resolveImageUrl('   '), '');
    });
  });

  group('upload', () {
    test('posts raw bytes with the declared content type', () async {
      late http.Request seen;
      final api = ApiClient(httpClient: MockClient((req) async {
        seen = req;
        return http.Response(
            jsonEncode({'success': true, 'url': '/wa-b/uploads/biz-1/x.jpg'}),
            201,
            headers: {'content-type': 'application/json'});
      }));

      final url = await api.uploadProductImage('biz-1', [0xff, 0xd8, 0xff, 0xe0],
          contentType: 'image/jpeg');

      expect(url, '/wa-b/uploads/biz-1/x.jpg');
      expect(seen.method, 'POST');
      expect(seen.url.path, '/api/uploads/product-image');
      expect(seen.url.queryParameters['business_id'], 'biz-1');
      // Raw body, not multipart and not JSON — the server reads a Buffer.
      expect(seen.headers['Content-Type'], 'image/jpeg');
      expect(seen.bodyBytes, [0xff, 0xd8, 0xff, 0xe0]);
    });

    test('a PNG is declared as PNG, not blindly as JPEG', () async {
      late http.Request seen;
      final api = ApiClient(httpClient: MockClient((req) async {
        seen = req;
        return http.Response(jsonEncode({'success': true, 'url': '/u/x.png'}), 201,
            headers: {'content-type': 'application/json'});
      }));
      await api.uploadProductImage('b', [0x89, 0x50], contentType: 'image/png');
      // The server cross-checks the header against the magic bytes and would
      // refuse a JPEG claim for PNG data.
      expect(seen.headers['Content-Type'], 'image/png');
    });

    test('a server rejection surfaces its message', () async {
      final api = ApiClient(httpClient: MockClient((_) async => http.Response(
          jsonEncode({'success': false, 'error': 'That file is not a JPEG, PNG or WebP image.'}),
          400,
          headers: {'content-type': 'application/json'})));

      await expectLater(
        api.uploadProductImage('b', [1, 2, 3]),
        throwsA(isA<ApiException>().having(
            (e) => e.message, 'message', contains('not a JPEG'))),
      );
    });
  });

  group('quick edit sheet', () {
    Widget app(ApiClient api, ProductPhotoPicker picker,
        {Map<String, dynamic>? product}) {
      final session = Session(api: api)
        ..business = {'id': 'biz-1', 'name': 'Ama'}
        ..role = SessionRole.merchant;
      return ChangeNotifierProvider<Session>.value(
        value: session,
        child: MaterialApp(
          home: Scaffold(
            body: ProductQuickEditSheet(
              product: product ?? {'id': 'p1', 'name': 'Shito', 'price_ghs': 25},
              photoPicker: picker,
            ),
          ),
        ),
      );
    }

    ApiClient okClient() => ApiClient(httpClient: MockClient((_) async =>
        http.Response(jsonEncode({'success': true, 'url': '/wa-b/uploads/biz-1/new.jpg'}),
            201, headers: {'content-type': 'application/json'})));

    testWidgets('offers a photo button, not a URL field', (tester) async {
      await tester.pumpWidget(app(okClient(), _FakePicker(null)));
      await tester.pumpAndSettle();

      expect(find.text('Add photo'), findsOneWidget);
      // The old flow asked for a link, which assumed the photo was already
      // hosted somewhere.
      expect(find.text('Photo URL'), findsNothing);
      expect(find.textContaining('there is no in-app photo upload'), findsNothing);
    });

    testWidgets('says Replace when the product already has a photo',
        (tester) async {
      await tester.pumpWidget(app(okClient(), _FakePicker(null),
          product: {'id': 'p1', 'name': 'Shito', 'price_ghs': 25,
                    'image_url': '/wa-b/uploads/biz-1/old.jpg'}));
      await pumpABit(tester);

      expect(find.text('Replace photo'), findsOneWidget);
      expect(find.text('Remove'), findsOneWidget);
    });

    testWidgets('a cancelled pick reports nothing', (tester) async {
      // Backing out of the camera is a normal outcome, not a failure — showing
      // an error for it would be wrong.
      final picker = _FakePicker(null);
      await tester.pumpWidget(app(okClient(), picker));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Add photo'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Take a photo'));
      await tester.pumpAndSettle();

      expect(picker.called, isTrue);
      expect(picker.usedSource, ImageSource.camera);
      expect(find.byType(SnackBar), findsNothing);
    });

    testWidgets('a successful upload swaps the button to Replace',
        (tester) async {
      final picker = _FakePicker((bytes: [0xff, 0xd8, 0xff, 0xe0], contentType: 'image/jpeg'));
      await tester.pumpWidget(app(okClient(), picker));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Add photo'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Choose from gallery'));
      await pumpABit(tester);

      expect(picker.usedSource, ImageSource.gallery);
      expect(find.text('Replace photo'), findsOneWidget);
    });

    testWidgets('a failed upload leaves the product without a photo',
        (tester) async {
      // The URL must only be set after the upload succeeds — otherwise the
      // merchant is left pointing at a file that was never stored.
      final failing = ApiClient(httpClient: MockClient((_) async => http.Response(
          jsonEncode({'success': false, 'error': 'That image is too large.'}), 400,
          headers: {'content-type': 'application/json'})));
      final picker = _FakePicker((bytes: [0xff, 0xd8], contentType: 'image/jpeg'));

      await tester.pumpWidget(app(failing, picker));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Add photo'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Take a photo'));
      await tester.pumpAndSettle();

      expect(find.textContaining('too large'), findsOneWidget);
      expect(find.text('Add photo'), findsOneWidget);
      expect(find.text('Replace photo'), findsNothing);
    });
  });
}
