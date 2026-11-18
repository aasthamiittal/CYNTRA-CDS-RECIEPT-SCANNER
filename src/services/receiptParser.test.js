import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReceipt } from './receiptParser.js';

const SAMPLE = `101
BIKANERVALA
815 Newark Avn, NJ 07306
201-659-3842
www.bikanervalausa.com
-------------------------------
Test - Delivery
-------------------------------
Aum M
(855) 222-8111
1 DoorDash Value
San Francisco, CA 94103
Server: Default 0
Check #999
DD 5f7823c2 Aum M
Ordered: 11/16/26 7:00 PM
Rice Bowl $12.99
`;

test('parses the sample Bikanervala receipt', () => {
  // "Test - Delivery": no platform on the order-type line, so none is sent,
  // even though DoorDash appears elsewhere on the receipt.
  const r = parseReceipt(SAMPLE);
  assert.equal(r.orderType, 'Delivery');
  assert.equal(r.platform, '');
  assert.equal(r.serviceType, 'Delivery');
  assert.equal(r.checkNumber, '101');
  assert.equal(r.customerName, 'Aum M');
});

test('tolerates OCR noise', () => {
  const r = parseReceipt('Door Dash — Delivery\nCheck H1O1\n');
  assert.equal(r.orderType, 'Doordash - Delivery');
  assert.equal(r.checkNumber, '101');
});

test('other platforms and pickup', () => {
  const r = parseReceipt('Uber Eats - Pick Up\nCheck # 57');
  assert.equal(r.orderType, 'Uber Eats - Pickup');
  assert.equal(r.checkNumber, '57');
});

test('falls back to top number when check line is unreadable', () => {
  const r = parseReceipt('204\nSOME STORE\nDelivery\n');
  assert.equal(r.checkNumber, '204');
  assert.equal(r.orderType, 'Delivery');
});

test('empty text', () => {
  const r = parseReceipt('');
  assert.equal(r.checkNumber, '');
  assert.equal(r.orderType, '');
});

test('real noisy OCR output from the Bikanervala photo', () => {
  const noisy = `ga15 Newark Avn. NJ 07306 Ee
— = Doordash - Del 1 Very — a
= Tl peg Aun NH =
gu  T ee (855) 222-8111 a
ee Ea check #101
—— eo DD S5f7823c2 Aum M —
— — Be Due: 11 /16726 7207 PM ——`;
  const r = parseReceipt(noisy);
  assert.equal(r.orderType, 'Doordash - Delivery');
  assert.equal(r.checkNumber, '101');
  assert.equal(r.customerName, 'Aum M');
});

test('strips OCR junk after the customer name', () => {
  const r = parseReceipt('~ Coe I Doordash - Delivery =\nris Fa ae Aum M = =\ncheck #101\n— DD 5f7823c2 Aum M Ee —');
  assert.equal(r.customerName, 'Aum M');
});

import { mergeReceipts } from './receiptParser.js';

test('check-number OCR variants', () => {
  const cases = {
    'Chk #57': '57',
    'CHECK NO. 204': '204',
    'Check: 88': '88',
    'Cheek #101': '101',
    'Chcck #1O1': '101',
    'check#305': '305',
    'Check # l2S': '125',
    'Gheck #42': '42'
  };
  for (const [line, want] of Object.entries(cases)) {
    assert.equal(parseReceipt(`STORE\n${line}\n`).checkNumber, want, line);
  }
});

test('ignores non-numeric text after Check', () => {
  assert.equal(parseReceipt('STORE\nCheck Out Our Menu\n').checkNumber, '');
});

test('top number with OCR junk around it', () => {
  assert.equal(parseReceipt('| 1O1 |\nBIKANERVALA\n').checkNumber, '101');
});

test('no platform when it is not on the order-type line (DD line ignored)', () => {
  const r = parseReceipt('STORE\nxx - Dellvery\nAum M\nCheck #12\nDD 5f7823c2 Aum M\n');
  assert.equal(r.orderType, 'Delivery');
  assert.equal(r.platform, '');
  assert.equal(r.customerName, 'Aum M');
});

test('no platform from DoorDash support number or address lines', () => {
  const r = parseReceipt('Take away\n(855) 222-8111\n1 DoorDash Value\nCheck #7');
  assert.equal(r.orderType, 'Take Away');
  assert.equal(r.platform, '');
});

test('take out / dine in normalised', () => {
  assert.equal(parseReceipt('Grubhub - Take Out\nCheck #3').orderType, 'Grubhub - Takeout');
  assert.equal(parseReceipt('Dine In\nCheck #3').orderType, 'Dine In');
});

test('fuzzy platform names', () => {
  assert.equal(parseReceipt('Uber Eat5 - Pick Up\nCheck #9').orderType, 'Uber Eats - Pickup');
  assert.equal(parseReceipt('Grub hub = Dellvery\nCheck #9').orderType, 'Grubhub - Delivery');
});

test('does not take a receipt label as the customer name', () => {
  const r = parseReceipt('Doordash - Delivery\nServer: Default 0\nCheck #5');
  assert.equal(r.customerName, '');
});

test('merges OCR passes by vote, preferring a platform', () => {
  const m = mergeReceipts([
    { orderType: 'Delivery', platform: '', serviceType: 'Delivery', checkNumber: '107', customerName: '' },
    { orderType: 'Doordash - Delivery', platform: 'Doordash', serviceType: 'Delivery', checkNumber: '101', customerName: 'Aum M' },
    { orderType: '', platform: '', serviceType: '', checkNumber: '101', customerName: 'Aum M' }
  ]);
  assert.equal(m.orderType, 'Doordash - Delivery');
  assert.equal(m.checkNumber, '101');
  assert.equal(m.customerName, 'Aum M');
});

import { findPaper } from './paperDetect.js';

test('finds white receipt paper on a wood-coloured table', () => {
  const w = 100, h = 150;
  const px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    const paper = x >= 35 && x < 75;
    const c = paper ? [205, 210, 215] : [165, 140, 115];
    px.set(c, i);
  }
  const r = findPaper(px, w, h, 3);
  assert.ok(r.x > 0.28 && r.x < 0.36, `x=${r.x}`);
  assert.ok(r.x + r.w > 0.74 && r.x + r.w < 0.8, `right=${r.x + r.w}`);
});

test('does not crop when there is no distinct paper', () => {
  const px = new Uint8Array(50 * 50 * 3).fill(200);
  assert.deepEqual(findPaper(px, 50, 50, 3), { x: 0, y: 0, w: 1, h: 1 });
});

test('in-store "Take away" receipt without a platform', () => {
  const r = parseReceipt('190\nBIKANERVALA\n815 Newark Avn, NJ 07306\n------\nTake away\n------\nAum M\nServer: Default 0\nCheck #190\n');
  assert.equal(r.orderType, 'Take Away');
  assert.equal(r.platform, '');
  assert.equal(r.checkNumber, '190');
  assert.equal(r.customerName, 'Aum M');
});
