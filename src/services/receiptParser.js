// Pulls the order type ("Doordash - Delivery"), check number ("101") and
// customer name out of raw OCR text. OCR on thermal receipts is noisy, so every
// rule is lenient and has a fallback; the user can still edit the values before
// placing the order.

const PLATFORM_RE =
  /(door\s*dash|uber\s*eats|grub\s*hub|postmates|seamless|caviar)\s*[-–—:~=]+\s*(delivery|pick\s*-?\s*up|take\s*-?\s*out|take\s*-?\s*away|dine\s*-?\s*in)/i;

const TYPE_ONLY_RE = /\b(delivery|pick\s*-?\s*up|take\s*-?\s*out|take\s*-?\s*away|dine\s*-?\s*in)\b/i;

// "<anything> - Delivery" on its own line: the order-type line even when the
// platform word is unreadable or replaced (e.g. "Test - Delivery").
const TYPE_LINE_RE =
  /^[^\n]{0,40}?\s*[-–—~=]\s*(delivery|pick\s*-?\s*up|take\s*-?\s*out|take\s*-?\s*away|dine\s*-?\s*in)\b/i;

const PRETTY_PLATFORM = {
  doordash: 'Doordash',
  ubereats: 'Uber Eats',
  grubhub: 'Grubhub',
  postmates: 'Postmates',
  seamless: 'Seamless',
  caviar: 'Caviar'
};

const SERVICE_TYPES = {
  delivery: 'Delivery',
  pickup: 'Pickup',
  takeout: 'Takeout',
  takeaway: 'Take Away',
  dinein: 'Dine In'
};

const splitLines = (text) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

// OCR commonly confuses letters and digits inside numbers.
const fixDigits = (s) =>
  s
    .replace(/[Oo]/g, '0')
    .replace(/[Il|!]/g, '1')
    .replace(/S/g, '5')
    .replace(/Z/g, '2')
    .replace(/B/g, '8');

// lowercase, common digit→letter OCR swaps, letters only
const compact = (s) =>
  s
    .toLowerCase()
    .replace(/[1!|]/g, 'i')
    .replace(/0/g, 'o')
    .replace(/5/g, 's')
    .replace(/[^a-z]/g, '');

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

// Does `word` appear in `s` allowing up to `maxDist` edits? Returns end index.
function fuzzyFind(s, word, maxDist) {
  for (let len = Math.max(1, word.length - maxDist); len <= word.length + maxDist; len++) {
    for (let i = 0; i + len <= s.length; i++) {
      if (editDistance(s.slice(i, i + len), word) <= maxDist) return i + len;
    }
  }
  return -1;
}

const normaliseType = (raw) => {
  const key = compact(raw);
  return SERVICE_TYPES[key] || raw;
};

const result = (platform, serviceType) => ({
  orderType: platform ? `${platform} - ${serviceType}` : serviceType,
  platform,
  serviceType
});

// "Doordash - Del 1 Very" → { platform, serviceType }
function fuzzyPlatformTypeLine(line) {
  const c = compact(line);
  if (c.length < 8) return null;
  for (const key of Object.keys(PRETTY_PLATFORM)) {
    const end = fuzzyFind(c, key, 1);
    if (end === -1) continue;
    const rest = c.slice(end, end + 14);
    for (const [typeKey, typeName] of Object.entries(SERVICE_TYPES)) {
      if (fuzzyFind(rest.slice(0, typeKey.length + 4), typeKey, 2) !== -1) {
        return { platform: PRETTY_PLATFORM[key], serviceType: typeName };
      }
    }
  }
  return null;
}

// Service type from a line that has a separator before it but maybe noisy
// spelling: "Test - Dellvery", "xx — Pick Up".
function fuzzyTypeLine(line) {
  const m = line.match(/[-–—~=]\s*([A-Za-z0-9 |!]{4,14})\s*$/);
  if (!m) return '';
  const c = compact(m[1]);
  for (const [typeKey, typeName] of Object.entries(SERVICE_TYPES)) {
    if (editDistance(c, typeKey) <= (typeKey.length >= 7 ? 2 : 1)) return typeName;
  }
  return '';
}

function findOrderType(text) {
  const lines = splitLines(text);
  // 1. Clean "<Platform> - <Type>".
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(PLATFORM_RE);
    if (m) {
      const key = m[1].replace(/\s+/g, '').toLowerCase();
      return { index: i, platform: PRETTY_PLATFORM[key], serviceType: normaliseType(m[2]) };
    }
  }
  // 2. Fuzzy "<Platform> - <Type>".
  for (let i = 0; i < lines.length; i++) {
    const f = fuzzyPlatformTypeLine(lines[i]);
    if (f) return { index: i, ...f };
  }
  // 3. "<something> - <Type>" line. The platform is only ever taken from the
  //    order-type line itself: a receipt that mentions DoorDash elsewhere (e.g.
  //    "1 DoorDash Value", "DD <id>") but not on that line gets no platform.
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TYPE_LINE_RE);
    const type = m ? normaliseType(m[1]) : fuzzyTypeLine(lines[i]);
    if (type) return { index: i, platform: '', serviceType: type };
  }
  // 4. Bare service type word anywhere.
  const t = text.match(TYPE_ONLY_RE);
  if (t) {
    const index = lines.findIndex((l) => TYPE_ONLY_RE.test(l));
    return { index, platform: '', serviceType: normaliseType(t[1]) };
  }
  return null;
}

export function parseOrderType(text = '') {
  const found = findOrderType(text);
  if (!found) return { orderType: '', platform: '', serviceType: '' };
  return result(found.platform, found.serviceType);
}

// Words OCR produces for "Check": Check, Chk, Cheek, Chcck, Gheck, Cneck, Ck.
const isCheckWord = (w) => {
  const c = w.toLowerCase().replace(/3/g, 'e');
  if (['chk', 'ck', 'chek', 'chck'].includes(c)) return true;
  // "checkh" = "Check" + misread "#"
  return c.length >= 4 && c.length <= 6 && editDistance(c.replace(/h$/, ''), 'check') <= 1;
};

const CHECK_CANDIDATE_RE =
  /([A-Za-z3]{2,6})\s*\.?\s*(?:(?:no|num|number)\.?\s*)?[#H*:№]{0,2}\s*([0-9OoIlSZB|]{1,7})(?![0-9A-Za-z])/gi;

function checkLineNumber(text) {
  for (const line of splitLines(text)) {
    for (const m of line.matchAll(CHECK_CANDIDATE_RE)) {
      if (!isCheckWord(m[1])) continue;
      if (!/\d/.test(m[2])) continue; // "Check Il" is not a number
      const n = fixDigits(m[2]);
      if (/^\d+$/.test(n)) return n.replace(/^0+(?=\d)/, '');
    }
  }
  return '';
}

// The check number is also printed large, alone, at the very top of the receipt.
function topNumber(text) {
  for (const line of splitLines(text).slice(0, 3)) {
    const m = line.match(/^[^A-Za-z0-9]*([0-9OoIlS]{1,6})[^A-Za-z0-9]*$/);
    if (!m || !/\d/.test(m[1])) continue;
    const n = fixDigits(m[1]);
    if (/^\d+$/.test(n)) return n;
  }
  return '';
}

export function parseCheckNumber(text = '') {
  // The big top number is printed in a large font and is the most reliable
  // read; the "Check #" line is the fallback.
  return topNumber(text) || checkLineNumber(text);
}

// Customer name is the first text line after the order-type line ("Aum M").
// Fallback: DoorDash prints "DD <order-id> <Customer Name>" under the check no.
const DD_LINE_RE = /\bD[DO0]\s+[0-9a-z]{6,10}\s+([A-Za-z][A-Za-z .'-]{1,30}?)\s*[-—=|~_.]*\s*$/i;
const NAME_RE = /^[A-Z][A-Za-z.'-]*(?: [A-Za-z][A-Za-z.'-]*){0,3}$/;
const NOT_NAME_RE =
  /\b(server|check|order|ordered|due|total|subtotal|tax|phone|guest|table|cashier|delivery|pickup|dasher|value)\b/i;

export function parseCustomerName(text = '') {
  const lines = splitLines(text);
  const found = findOrderType(text);
  if (found && found.index !== -1) {
    for (const raw of lines.slice(found.index + 1, found.index + 3)) {
      if (/^[-=_~—]{3,}/.test(raw)) continue;
      const line = raw.replace(/\s+/g, ' ');
      if (NAME_RE.test(line) && !NOT_NAME_RE.test(line)) return line;
    }
  }
  for (const line of lines) {
    const m = line.match(DD_LINE_RE);
    if (!m) continue;
    // OCR often glues junk ("Aum M Ee") onto the end. The name is also printed
    // above the phone number, so keep the longest prefix that appears twice.
    const tokens = m[1].replace(/\s+/g, ' ').trim().split(' ');
    // Names are capitalised; trailing all-lowercase tokens are OCR noise.
    while (tokens.length > 1 && /^[a-z]+$/.test(tokens[tokens.length - 1])) tokens.pop();
    for (let k = tokens.length; k >= 1; k--) {
      const candidate = tokens.slice(0, k).join(' ');
      if (text.split(candidate).length - 1 >= 2) return candidate;
    }
    return tokens.join(' ');
  }
  return '';
}

export function parseReceipt(text = '') {
  const { orderType, platform, serviceType } = parseOrderType(text);
  return {
    orderType,
    platform,
    serviceType,
    checkNumber: parseCheckNumber(text),
    customerName: parseCustomerName(text)
  };
}

export const isCompleteReceipt = (r) => Boolean(r.platform && r.serviceType && r.checkNumber && r.customerName);

// Combine results from several OCR passes: each field is decided by vote among
// the passes that found it; ties go to the earliest pass. An order type with a
// platform always beats one without.
export function mergeReceipts(results) {
  const vote = (values) => {
    const counts = new Map();
    values.filter(Boolean).forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
    let best = '';
    let bestN = 0;
    for (const [v, n] of counts) if (n > bestN) [best, bestN] = [v, n];
    return best;
  };
  const withPlatform = results.filter((r) => r.platform);
  const typeSource = withPlatform.length ? withPlatform : results;
  const orderType = vote(typeSource.map((r) => r.orderType));
  const chosen = typeSource.find((r) => r.orderType === orderType) || {};
  return {
    orderType,
    platform: chosen.platform || '',
    serviceType: chosen.serviceType || '',
    checkNumber: vote(results.map((r) => r.checkNumber)),
    customerName: vote(results.map((r) => r.customerName))
  };
}
