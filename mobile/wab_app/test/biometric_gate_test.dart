import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:local_auth_platform_interface/local_auth_platform_interface.dart';
import 'package:mocktail/mocktail.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';
import 'package:wab_app/services/biometric_gate.dart';

/// The gate in front of payouts — the one place in the app where getting the
/// answer wrong moves money, or blocks a merchant from their own earnings.
///
/// Its two failure directions are deliberately asymmetric, and that asymmetry
/// is the whole design:
///   - nothing enrolled on the device  → fail OPEN  (there is no lock screen
///     protecting the phone either; refusing would add friction, not security)
///   - the platform channel errors out → fail CLOSED (we genuinely could not
///     tell, so assume the worst)
/// A regression that flipped either direction would be invisible in manual
/// testing on a normal, enrolled handset.

class MockLocalAuthPlatform extends Mock
    with MockPlatformInterfaceMixin
    implements LocalAuthPlatform {}

class FakeAuthMessages extends Fake implements AuthMessages {}

class FakeAuthenticationOptions extends Fake
    implements AuthenticationOptions {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late MockLocalAuthPlatform platform;

  setUpAll(() {
    registerFallbackValue(FakeAuthMessages());
    registerFallbackValue(FakeAuthenticationOptions());
    registerFallbackValue(<AuthMessages>[]);
  });

  setUp(() {
    platform = MockLocalAuthPlatform();
    LocalAuthPlatform.instance = platform;
  });

  test('a successful check unlocks the screen', () async {
    when(() => platform.isDeviceSupported()).thenAnswer((_) async => true);
    when(() => platform.authenticate(
        localizedReason: any(named: 'localizedReason'),
        authMessages: any(named: 'authMessages'),
        options: any(named: 'options'))).thenAnswer((_) async => true);

    expect(await BiometricGate.authenticate('View payouts'), isTrue);
  });

  test('a refused or failed check keeps the screen locked', () async {
    when(() => platform.isDeviceSupported()).thenAnswer((_) async => true);
    when(() => platform.authenticate(
        localizedReason: any(named: 'localizedReason'),
        authMessages: any(named: 'authMessages'),
        options: any(named: 'options'))).thenAnswer((_) async => false);

    expect(await BiometricGate.authenticate('View payouts'), isFalse);
  });

  test('an unsupported device fails OPEN and never prompts', () async {
    when(() => platform.isDeviceSupported()).thenAnswer((_) async => false);

    expect(await BiometricGate.authenticate('View payouts'), isTrue);

    // No lock screen exists to prompt against — asking would be a dead end.
    verifyNever(() => platform.authenticate(
        localizedReason: any(named: 'localizedReason'),
        authMessages: any(named: 'authMessages'),
        options: any(named: 'options')));
  });

  test('a platform-channel error fails CLOSED', () async {
    when(() => platform.isDeviceSupported()).thenAnswer((_) async => true);
    when(() => platform.authenticate(
            localizedReason: any(named: 'localizedReason'),
            authMessages: any(named: 'authMessages'),
            options: any(named: 'options')))
        .thenThrow(PlatformException(code: 'no_fragment_activity'));

    // Unlike "nothing enrolled", this means we could not tell either way.
    expect(await BiometricGate.authenticate('View payouts'), isFalse);
  });

  test('a throwing isDeviceSupported also fails CLOSED', () async {
    when(() => platform.isDeviceSupported())
        .thenThrow(PlatformException(code: 'unavailable'));

    expect(await BiometricGate.authenticate('View payouts'), isFalse);
  });

  test('the caller-supplied reason reaches the system prompt', () async {
    when(() => platform.isDeviceSupported()).thenAnswer((_) async => true);
    when(() => platform.authenticate(
        localizedReason: any(named: 'localizedReason'),
        authMessages: any(named: 'authMessages'),
        options: any(named: 'options'))).thenAnswer((_) async => true);

    await BiometricGate.authenticate('Confirm your payout of GH¢450.00');

    final captured = verify(() => platform.authenticate(
        localizedReason: captureAny(named: 'localizedReason'),
        authMessages: any(named: 'authMessages'),
        options: any(named: 'options'))).captured.single as String;
    expect(captured, 'Confirm your payout of GH¢450.00');
  });

  test('the device passcode is accepted as a fallback', () async {
    when(() => platform.isDeviceSupported()).thenAnswer((_) async => true);
    when(() => platform.authenticate(
        localizedReason: any(named: 'localizedReason'),
        authMessages: any(named: 'authMessages'),
        options: any(named: 'options'))).thenAnswer((_) async => true);

    await BiometricGate.authenticate('View payouts');

    // biometricOnly: false — a merchant whose fingerprint sensor is wet or
    // whose face is not recognised must still be able to reach their money.
    final opts = verify(() => platform.authenticate(
            localizedReason: any(named: 'localizedReason'),
            authMessages: any(named: 'authMessages'),
            options: captureAny(named: 'options')))
        .captured
        .single as AuthenticationOptions;
    expect(opts.biometricOnly, isFalse);
  });
}
