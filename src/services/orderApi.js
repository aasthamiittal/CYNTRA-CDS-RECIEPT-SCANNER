import {
  STORE_DETAILS,
  TAX_PCT,
  TAX_DESC,
  ORDER_STATUS,
  ORDER_STATE,
  ORDER_CODE_BY_TYPE,
  ORDER_SOURCE,
  ORDER_SOURCE_CODE,
  DEFAULT_ORDER_CODE
} from '../config.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function buildItem(item, index) {
  const qty = Number(item.quantity) || 1;
  const price = Number(item.price) || 0;
  const gross = round2(price * qty);
  const tax = round2((gross * TAX_PCT) / 100);
  return {
    item_id: item.item_id,
    sku: item.sku,
    item_name: item.item_name,
    item_seq: index + 1,
    quantity: qty,
    regular_sales_unit_price: price,
    sub_total: gross,
    extended_amount: gross,
    total_gross_sale: gross,
    total_net_sale: gross,
    total_item_tax: tax,
    taxAmount: tax,
    tax: [{ tax_dsc: TAX_DESC, tax_pct: TAX_PCT, tax_amount: tax }],
    // Modifiers are shown on the KDS/CDS as item notes.
    modifiers: (item.modifiers || []).map((name) => ({ name, price: 0, quantity: 1 })),
    comment: (item.modifiers || []).join(', ')
  };
}

/**
 * Build the /transaction/order-place payload from the scanned receipt values
 * plus the hard-coded config.
 *
 * The receipt check number goes to store_details.order_reference_no (and the
 * offline_invoice_no key). It is deliberately NOT sent as invoice_no: the
 * backend treats a payload invoice_no as "modify the existing order with this
 * invoice number" and would skip allocating a fresh one.
 */
export function buildOrderPayload({ orderType, platform, serviceType, checkNumber, customerName, items, scanId, session }) {
  const item_details = items.map(buildItem);
  const sub_total = round2(item_details.reduce((s, i) => s + i.sub_total, 0));
  const total_item_tax = round2(item_details.reduce((s, i) => s + i.total_item_tax, 0));
  const grand = round2(sub_total + total_item_tax);

  const typeKey = (serviceType || '').toLowerCase();
  const order_code = ORDER_CODE_BY_TYPE[typeKey] || DEFAULT_ORDER_CODE;
  const source = platform || 'Third Party';

  return {
    store_details: {
      ...STORE_DETAILS,
      // Always the store the employee is signed in to.
      store_id: session.store_id,
      emp_session_id: session.session_id,
      emp_no: session.emp_no,
      emp_name: session.emp_name,
      device_id: session.device_id,
      ...(session.currency ? { currencycode: session.currency } : {}),
      order_code,
      order_des: orderType || source,
      order_reference_no: String(checkNumber)
    },
    item_details,
    payment_details:
      ORDER_STATUS === 'CLOSE'
        ? [
            {
              tnd_code: source.toUpperCase().replace(/\s+/g, '_'),
              tnd_type: 'Third Party',
              tnd_des: source,
              amount: grand,
              transaction_id: `${source}-${checkNumber}`
            }
          ]
        : [],
    customer_details: [
      { cust_mobile: 'NA', cust_first_name: customerName || 'Guest', cust_address: 'NA' }
    ],
    order_status: ORDER_STATUS,
    order_state: ORDER_STATE,
    order_type: serviceType || orderType,
    order_source: ORDER_SOURCE,
    order_source_code: ORDER_SOURCE_CODE,
    // Unique per scan: retrying the same scan won't create a duplicate order.
    offline_invoice_no: `RCPT-${session.store_id}-${checkNumber}-${scanId}`,
    comment: `${orderType} | Check #${checkNumber}`,
    sub_total,
    total_item_tax,
    total_discount: 0,
    total_gross_sale: sub_total,
    total_net_sale: sub_total,
    total_charges: 0,
    charges: [],
    transaction_grand_amount: grand,
    tip_amount: 0,
    tip_percentage: 0
  };
}

// Thrown when the backend rejects the token (expired / invalid) — the UI
// sends the user back to the login screen.
export class AuthError extends Error {}

export async function placeOrder(payload, authToken) {
  // The backend expects the raw JWT in Authorization (no "Bearer " prefix).
  const headers = { 'Content-Type': 'application/json', Authorization: authToken };

  const res = await fetch('/api/transaction/order-place', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (res.status === 401 || body?.authentication_failed) {
    throw new AuthError(typeof body?.message === 'string' ? body.message : 'Authentication failed');
  }
  if (!res.ok || !body?.status) {
    const msg = body?.message
      ? typeof body.message === 'string'
        ? body.message
        : JSON.stringify(body.message)
      : `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return body.data;
}
