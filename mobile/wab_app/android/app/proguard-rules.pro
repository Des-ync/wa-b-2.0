# R8/ProGuard rules for release builds (minifyEnabled/shrinkResources).
#
# Most Flutter plugins (Firebase, local_auth, mobile_scanner, etc.) ship their
# own consumer-rules.pro bundled in their AAR, which R8 picks up
# automatically — this file only adds rules for classes that have historically
# needed them across Flutter/Firebase projects, as a defensive baseline.
# VERIFY on a real device after this change: sign-in (Clerk), push
# notifications, barcode scanning, and voice product updates specifically,
# since these are the reflection/JNI-touching features. Passkeys are Clerk's
# own responsibility now (a WebView, not androidx.credentials) — no rules
# needed here for them.

# Firebase (some paths use Gson-style reflection for model (de)serialization).
-keep class com.google.firebase.** { *; }
-dontwarn com.google.firebase.**

# flutter_local_notifications reflectively references a couple of Gson
# TypeToken/TypeAdapter classes for scheduled-notification persistence.
-keep class com.dexterous.** { *; }
-keep class * extends com.google.gson.TypeAdapter
-keep class com.google.gson.reflect.TypeToken { *; }
-keep class * extends com.google.gson.reflect.TypeToken

# Keep annotation-based Play Core deferred-components hooks flutter_local_
# notifications' AAR expects to exist, even though this app doesn't use
# deferred components — avoids an R8 "missing class" hard failure some
# Flutter/Play-Core version combinations hit.
-dontwarn com.google.android.play.core.**
