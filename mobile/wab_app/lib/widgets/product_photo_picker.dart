import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../theme.dart';

/// Taking or choosing a product photo.
///
/// The merchant's photo is on their phone, which is the whole reason this
/// exists — before it, both surfaces asked for a URL, which assumes the image
/// is already hosted somewhere.
///
/// **The shrink is the important part.** A phone camera original is 3–5 MB.
/// `image_picker` resizes natively via [maxWidth]/[maxHeight]/[imageQuality],
/// so the file is reduced *before* it is read into memory or sent — on a
/// metered Ghanaian connection those megabytes are the merchant's own money,
/// and on a low-end device never materialising the full bitmap matters too.
/// The numbers match the web dashboard's canvas resize so a photo looks the
/// same whichever surface uploaded it.
const _maxEdge = 1200.0;
const _quality = 82;

/// The picker is injectable so tests can drive this without a platform channel.
typedef PickerFactory = ImagePicker Function();

class ProductPhotoPicker {
  ProductPhotoPicker({PickerFactory? pickerFactory})
      : _pickerFactory = pickerFactory ?? ImagePicker.new;

  final PickerFactory _pickerFactory;

  /// Returns the shrunk bytes, or null if the merchant backed out.
  ///
  /// Throws nothing for a cancelled pick — that is a normal outcome, not an
  /// error, and showing a failure message for it would be wrong.
  Future<({List<int> bytes, String contentType})?> pick(
      ImageSource source) async {
    final file = await _pickerFactory().pickImage(
      source: source,
      maxWidth: _maxEdge,
      maxHeight: _maxEdge,
      imageQuality: _quality,
    );
    if (file == null) return null;
    final bytes = await file.readAsBytes();
    return (bytes: bytes, contentType: _contentTypeFor(file.path, file.mimeType));
  }

  /// What the server should be told the bytes are.
  ///
  /// The server re-derives the real type from the magic bytes and rejects a
  /// mismatch, so this only has to be honest enough to get past the body
  /// parser — but sending image/jpeg for a PNG would be refused, so it is
  /// derived rather than hardcoded.
  static String _contentTypeFor(String path, String? mimeType) {
    if (mimeType != null && mimeType.startsWith('image/')) return mimeType;
    final lower = path.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    return 'image/jpeg';
  }
}

/// Asks whether to use the camera or the gallery.
///
/// Camera first: a merchant adding a photo to a product is usually holding the
/// thing they are photographing.
Future<ImageSource?> showPhotoSourceSheet(BuildContext context) {
  return showModalBottomSheet<ImageSource>(
    context: context,
    builder: (ctx) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(height: 8),
          ListTile(
            leading: const Icon(Icons.photo_camera_rounded,
                color: WabColors.accentInk),
            title: const Text('Take a photo',
                style: TextStyle(fontWeight: FontWeight.w600)),
            onTap: () => Navigator.pop(ctx, ImageSource.camera),
          ),
          ListTile(
            leading: const Icon(Icons.photo_library_rounded,
                color: WabColors.accentInk),
            title: const Text('Choose from gallery',
                style: TextStyle(fontWeight: FontWeight.w600)),
            onTap: () => Navigator.pop(ctx, ImageSource.gallery),
          ),
          const SizedBox(height: 8),
        ],
      ),
    ),
  );
}
