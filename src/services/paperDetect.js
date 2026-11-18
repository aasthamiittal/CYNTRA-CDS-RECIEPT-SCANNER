// Finds the receipt paper in a photo so OCR only reads the receipt, not the
// table / background around it (wood grain, shadows and hands produce lots of
// false "text" and make Tesseract both slower and less accurate).
//
// Works on a small copy of the image (~200px wide). Receipt paper is bright
// and colourless; backgrounds are usually darker or coloured. Each pixel gets
// a "paperness" score = darkest channel − saturation − warmth, Otsu splits paper from
// background, then the longest run of mostly-paper columns (and within it, of
// rows) is taken as the receipt.

function otsu(values) {
  const hist = new Array(256).fill(0);
  for (const v of values) hist[v]++;
  const total = values.length;
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

// Longest run of indices where ok(i) is true, bridging gaps up to maxGap.
function longestRun(n, ok, maxGap) {
  let best = [0, -1];
  let start = -1;
  let lastOk = -1;
  for (let i = 0; i <= n; i++) {
    if (i < n && ok(i)) {
      if (start === -1 || i - lastOk - 1 > maxGap) start = i;
      lastOk = i;
      if (lastOk - start > best[1] - best[0]) best = [start, lastOk];
    }
  }
  return best[1] >= best[0] ? best : null;
}

/**
 * @param {Uint8ClampedArray|Uint8Array} px pixel data
 * @param {number} w
 * @param {number} h
 * @param {number} [channels] 4 for RGBA (canvas), 3 for RGB
 * @returns {{x:number,y:number,w:number,h:number}} crop as fractions (0..1);
 *   the whole image if no clear receipt is found
 */
export function findPaper(px, w, h, channels = 4) {
  const FULL = { x: 0, y: 0, w: 1, h: 1 };
  const score = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += channels) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const mn = Math.min(r, g, b);
    const mx = Math.max(r, g, b);
    // warm (wood / skin) tones are penalised on top of saturation
    score[p] = Math.max(0, mn - (mx - mn) - Math.max(0, r - b));
  }
  const t = otsu(score);
  // If paper and background are not clearly different, don't crop.
  let paperMean = 0;
  let bgMean = 0;
  let nPaper = 0;
  for (const s of score) {
    if (s > t) {
      paperMean += s;
      nPaper++;
    } else bgMean += s;
  }
  if (!nPaper || nPaper === score.length) return FULL;
  paperMean /= nPaper;
  bgMean /= score.length - nPaper;
  if (paperMean - bgMean < 35) return FULL;

  const isPaper = (x, y) => score[y * w + x] > t;
  const colFrac = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = 0; y < h; y++) if (isPaper(x, y)) n++;
    colFrac[x] = n / h;
  }
  const cols = longestRun(w, (x) => colFrac[x] > 0.35, Math.round(w * 0.02));
  if (!cols || cols[1] - cols[0] + 1 < w * 0.2) return FULL;

  const cw = cols[1] - cols[0] + 1;
  const rows = longestRun(
    h,
    (y) => {
      let n = 0;
      for (let x = cols[0]; x <= cols[1]; x++) if (isPaper(x, y)) n++;
      return n / cw > 0.5;
    },
    Math.round(h * 0.03)
  );
  if (!rows) return FULL;

  const mx = Math.round(w * 0.03);
  const my = Math.round(h * 0.02);
  const x0 = Math.max(0, cols[0] - mx);
  const x1 = Math.min(w - 1, cols[1] + mx);
  const y0 = Math.max(0, rows[0] - my);
  const y1 = Math.min(h - 1, rows[1] + my);
  return { x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h };
}
