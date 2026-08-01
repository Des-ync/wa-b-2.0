/**
 * Making browser-supplied text safe to put in an ops alert.
 *
 * The CSP and client-error endpoints are unauthenticated by necessity —
 * browsers post to them with no credentials, and an error can fire before
 * login. That means anyone can POST a crafted message and have it delivered
 * to the ops phone as a WhatsApp message and to admins as a push
 * notification.
 *
 * The risk is not code execution; a WhatsApp message is not executable. It is
 * phishing. An alert arriving through the company's own monitoring channel
 * carries far more credibility than a cold email, and a tappable link inside
 * one is the whole attack:
 *
 *     {"message":"URGENT: dashboard compromised, reset at https://wa-b-secure.test"}
 *
 * So links are defanged rather than removed — for a CSP report the URIs *are*
 * the signal, and an alert with them stripped would be useless. Defanged, they
 * stay readable and stop being one tap away.
 */

/**
 * Characters removed or flattened before text reaches an alert.
 *
 * Filtered by code point rather than a regex literal on purpose: written as a
 * character class these are invisible bytes in the source, which is both
 * unreadable and easy to edit wrongly.
 *
 * - **Control characters, newlines and tabs** become a single space. Newlines
 *   are not cosmetic: the alert body separates its fields with them, so
 *   untrusted text containing one can forge a line the browser never sent —
 *   `boom\npage: https://real.test` reads exactly like a genuine `page:`
 *   field. A stack trace loses its line breaks, which is a fair trade for a
 *   field that cannot be spoofed.
 * - **Zero-width and bidi controls** are dropped entirely. They can hide part
 *   of a domain, or reverse how one reads.
 */
function isControl(code) {
  return code <= 0x1f || code === 0x7f;
}

function isInvisible(code) {
  return (code >= 0x200b && code <= 0x200f)   // zero-width, LTR/RTL marks
    || (code >= 0x202a && code <= 0x202e)     // bidi embedding/override
    || (code >= 0x2060 && code <= 0x2064)     // word joiner, invisible operators
    || code === 0xfeff;                       // zero-width no-break space
}

function stripUnsafeChars(s) {
  let out = '';
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    if (isInvisible(code)) continue;
    out += isControl(code) ? ' ' : ch;
  }
  return out;
}

/**
 * Defangs anything a messaging client would turn into a tappable link.
 *
 * `https://evil.test/x` → `hxxps://evil.test/x`, `www.evil.test` →
 * `www[.]evil.test`. Both remain readable by a human reading the alert, and
 * neither is a link any more.
 */
function defangLinks(s) {
  // No \b anchors: a word boundary would skip `xhttps://evil.test`, because
  // there is no boundary between two word characters. The scheme is defanged
  // wherever it appears, not only where it looks tidy.
  return String(s)
    .replace(/https?:\/\//gi, m => (m.toLowerCase().startsWith('https') ? 'hxxps://' : 'hxxp://'))
    .replace(/www\./gi, 'www[.]');
}

/**
 * Prepares untrusted text for inclusion in an outbound alert.
 *
 * Truncation happens last so a defanged link cannot be cut back into a live
 * one at the boundary.
 */
function safeForAlert(s, maxLength = 300) {
  return defangLinks(stripUnsafeChars(s == null ? '' : s)).slice(0, maxLength);
}

module.exports = { safeForAlert, defangLinks, stripUnsafeChars };
