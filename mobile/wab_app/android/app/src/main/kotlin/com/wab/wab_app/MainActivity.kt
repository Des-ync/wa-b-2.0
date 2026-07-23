package com.wab.wab_app

import io.flutter.embedding.android.FlutterFragmentActivity

// local_auth's Android biometric prompt needs a FragmentActivity host —
// plain FlutterActivity throws at runtime when authenticate() is called.
class MainActivity : FlutterFragmentActivity()
