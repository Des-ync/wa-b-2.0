// Does shrinkImage() actually shrink a photo? That is the whole value of the
// feature on a metered connection, so it is measured rather than assumed.
(async function () {
  const out = {};
  function makePhoto(w, h) {
    // A noisy image, so JPEG cannot trivially compress it to nothing — a flat
    // colour would make the saving look far better than a real photo's.
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    let seed = 42;
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      img.data[i] = seed & 255;
      img.data[i + 1] = (seed >> 8) & 255;
      img.data[i + 2] = (seed >> 16) & 255;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return new Promise(r => c.toBlob(r, 'image/jpeg', 0.95));
  }

  try {
    const original = await makePhoto(3000, 2250);      // a phone camera original
    const file = new File([original], 'photo.jpg', { type: 'image/jpeg' });
    const shrunk = await shrinkImage(file);

    const probe = new Image();
    const url = URL.createObjectURL(shrunk);
    await new Promise((res, rej) => { probe.onload = res; probe.onerror = rej; probe.src = url; });

    out.originalKB = Math.round(original.size / 1024);
    out.shrunkKB = Math.round(shrunk.size / 1024);
    out.reductionPct = Math.round((1 - shrunk.size / original.size) * 100);
    out.longestEdge = Math.max(probe.width, probe.height);
    out.withinCap = shrunk.size <= 2 * 1024 * 1024;
    out.outputType = shrunk.type;
    URL.revokeObjectURL(url);

    // A non-image must be rejected, not silently uploaded as garbage.
    try {
      await shrinkImage(new File([new Blob(['not an image'])], 'x.txt', { type: 'text/plain' }));
      out.rejectsNonImage = false;
    } catch (e) { out.rejectsNonImage = true; }

    // An image already smaller than the cap must not be scaled UP.
    const small = await makePhoto(400, 300);
    const smallOut = await shrinkImage(new File([small], 's.jpg', { type: 'image/jpeg' }));
    const p2 = new Image();
    const u2 = URL.createObjectURL(smallOut);
    await new Promise((res, rej) => { p2.onload = res; p2.onerror = rej; p2.src = u2; });
    out.smallImageEdge = Math.max(p2.width, p2.height);
    out.doesNotUpscale = out.smallImageEdge === 400;
    URL.revokeObjectURL(u2);
  } catch (e) {
    out.error = e.message;
  }
  document.getElementById('out').textContent = JSON.stringify(out, null, 1);
})();
