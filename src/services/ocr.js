import { createWorker } from 'tesseract.js';
import { findPaper } from './paperDetect.js';
import { processGray } from './imageOps.js';

// ---------------------------------------------------------------------------
// Image preparation
// ---------------------------------------------------------------------------
// 1. Find the receipt paper and crop away the table/background around it.
// 2. Keep only the top of the receipt (≈1.4 × its width): order type, customer,
//    check # and the DoorDash line are all printed there; the item list,
//    totals and QR code below only cost time (a QR code is very slow to OCR).
// 3. Scale so the receipt is ~1000px wide — big enough for thermal print,
//    small enough to be fast.
// Each OCR pass then renders its own variant (see imageOps.processGray).

const TARGET_WIDTH = 1000;
const FULL_TARGET_WIDTH = 1400;
const TOP_ASPECT = 1.4;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function detectPaper(img) {
  const w = 200;
  const h = Math.max(1, Math.round((img.height / img.width) * w));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  return findPaper(ctx.getImageData(0, 0, w, h).data, w, h, 4);
}

/**
 * Decode the photo into a grayscale buffer ready for OCR.
 * @param {string} dataUrl
 * @param {{crop?: boolean}} [opts] crop=true (default): receipt top only;
 *   crop=false: the whole photo (fallback when the crop missed something)
 */
export async function prepareImage(dataUrl, { crop = true } = {}) {
  const img = await loadImage(dataUrl);
  let sx = 0;
  let sy = 0;
  let sw = img.width;
  let sh = img.height;
  if (crop) {
    const r = detectPaper(img);
    sx = Math.round(r.x * img.width);
    sy = Math.round(r.y * img.height);
    sw = Math.round(r.w * img.width);
    sh = Math.min(Math.round(r.h * img.height), Math.round(sw * TOP_ASPECT));
  }
  const scale = Math.min(2.5, (crop ? TARGET_WIDTH : FULL_TARGET_WIDTH) / sw);
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    gray[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
  return { gray, w, h };
}

function toCanvas(pixels, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const frame = ctx.createImageData(w, h);
  for (let i = 0, p = 0; p < pixels.length; i += 4, p++) {
    frame.data[i] = frame.data[i + 1] = frame.data[i + 2] = pixels[p];
    frame.data[i + 3] = 255;
  }
  ctx.putImageData(frame, 0, 0);
  return canvas;
}

// ---------------------------------------------------------------------------
// Worker pool
// ---------------------------------------------------------------------------
// Two Tesseract workers are started as soon as the app loads (warmUpOcr), so
// the language model is already in memory when the user captures, and two OCR
// passes run in parallel.

const POOL_SIZE = 2;
const pool = []; // { promise, busy, onProgress }
const waiting = [];

// A pass that takes longer than this is abandoned and its worker restarted
// (phones can stall or kill a worker under memory pressure, which would
// otherwise leave the scan hanging forever).
const PASS_TIMEOUT_MS = 25000;

function startWorker(slot) {
  slot.promise = createWorker('eng', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text' && slot.onProgress) slot.onProgress(m.progress);
    }
  });
  slot.promise.catch(() => {
    const i = pool.indexOf(slot);
    if (i !== -1) pool.splice(i, 1);
  });
}

function ensurePool() {
  while (pool.length < POOL_SIZE) {
    const slot = { busy: false, onProgress: null, promise: null };
    startWorker(slot);
    pool.push(slot);
  }
}

export function warmUpOcr() {
  ensurePool();
}

function acquire() {
  ensurePool();
  const free = pool.find((s) => !s.busy);
  if (free) {
    free.busy = true;
    return Promise.resolve(free);
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release(slot) {
  slot.onProgress = null;
  const next = waiting.shift();
  if (next) next(slot);
  else slot.busy = false;
}

/**
 * Run one OCR pass.
 * @param {{gray: Float32Array, w: number, h: number}} prepared from prepareImage()
 * @param {object} opts
 * @param {'gray'|'adaptive'|'binary'} [opts.mode]
 * @param {number} [opts.sharpen] unsharp-mask amount (0 = off)
 * @param {string} [opts.psm] page segmentation: '4' single column of
 *   variable-size text (receipts), '6' uniform block, '11' sparse text
 * @param {(p: number) => void} [opts.onProgress] 0..1
 * @returns {Promise<string>}
 */
export async function recognizePass(prepared, { mode = 'gray', sharpen = 0, psm = '6', onProgress } = {}) {
  const image = toCanvas(processGray(prepared, mode, sharpen), prepared.w, prepared.h);
  const slot = await acquire();
  try {
    const worker = await slot.promise;
    await worker.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: '1' });
    slot.onProgress = onProgress || null;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('OCR pass timed out')), PASS_TIMEOUT_MS);
    });
    try {
      // Only plain text is needed; skipping hOCR/TSV/blocks output saves ~15%.
      const job = worker.recognize(image, {}, { text: true, blocks: false, hocr: false, tsv: false });
      const { data } = await Promise.race([job, timeout]);
      return data.text || '';
    } catch (e) {
      if (e.message === 'OCR pass timed out') {
        worker.terminate().catch(() => {});
        startWorker(slot);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    release(slot);
  }
}

/** Convenience: single pass straight from a data URL. */
export async function recognizeReceipt(dataUrl, onProgress, mode = 'gray', psm = '6') {
  return recognizePass(await prepareImage(dataUrl), { mode, psm, sharpen: 0.8, onProgress });
}

// ---------------------------------------------------------------------------
// Sharpness (used by the camera to pick the least blurry frame)
// ---------------------------------------------------------------------------
// Variance of the Laplacian on a small grayscale copy: higher = sharper.
export function sharpnessScore(source, sw, sh) {
  const w = 320;
  const h = Math.max(1, Math.round((sh / sw) * w));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) g[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}
