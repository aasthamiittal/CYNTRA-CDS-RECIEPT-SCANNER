// Pure image operations on grayscale buffers (no DOM), shared by the OCR
// pipeline and the tests.

function integralImage(src, w, h) {
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
    }
  }
  return integral;
}

// Calls fn(index, mean of the (2r+1)² window around the pixel).
function forEachWindowMean(src, w, h, r, fn) {
  const I = integralImage(src, w, h);
  const W = w + 1;
  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - r);
    const y2 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - r);
      const x2 = Math.min(w, x + r + 1);
      const sum = I[y2 * W + x2] - I[y1 * W + x2] - I[y2 * W + x1] + I[y1 * W + x1];
      fn(y * w + x, sum / ((x2 - x1) * (y2 - y1)));
    }
  }
}

function unsharp(gray, w, h, amount, radius) {
  if (!amount) return gray;
  const out = new Float32Array(gray.length);
  forEachWindowMean(gray, w, h, radius, (i, mean) => {
    const v = gray[i] + amount * (gray[i] - mean);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  });
  return out;
}

function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i] | 0]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}


export function processGray({ gray, w, h }, mode, sharpen) {
  const src = unsharp(gray, w, h, sharpen, Math.max(2, Math.round(w / 500)));
  const out = new Uint8ClampedArray(w * h);
  if (mode === 'adaptive') {
    // Bradley–Roth: ink if ~15% darker than its neighbourhood (window ≈ w/16).
    forEachWindowMean(src, w, h, Math.max(8, Math.round(w / 32)), (i, mean) => {
      out[i] = src[i] < mean * 0.85 ? 0 : 255;
    });
  } else if (mode === 'binary') {
    const t = otsu(src);
    for (let i = 0; i < src.length; i++) out[i] = src[i] > t ? 255 : 0;
  } else {
    let min = 255;
    let max = 0;
    for (let i = 0; i < src.length; i++) {
      if (src[i] < min) min = src[i];
      if (src[i] > max) max = src[i];
    }
    const range = Math.max(1, max - min);
    for (let i = 0; i < src.length; i++) out[i] = ((src[i] - min) / range) * 255;
  }
  return out;
}
