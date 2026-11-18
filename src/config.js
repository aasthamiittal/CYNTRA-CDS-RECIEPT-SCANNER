// ---------------------------------------------------------------------------
// Hard-coded order values. Everything that is NOT read from the receipt or
// from the login (items, tax, payment) lives here. The store is whichever
// store the employee signed in to — see services/auth.js.
// ---------------------------------------------------------------------------

// Food API backend. In dev, /api calls go through the Vite proxy to this URL;
// in a production build they are sent to it directly (see vite.config.js).
export const API_URL = 'https://cyntra-dev-food-api.cravrr.com';

// Login "source" sent to /api/auth/login. 'leap' = POS app; the employee needs
// breez/leap/swift login access, and the store must be open (day started).
export const LOGIN_SOURCE = 'leap';

// Static store_details sent with every order. store_id and the employee
// fields (emp_no, emp_name, emp_session_id, device_id) come from the login session.
export const STORE_DETAILS = {
  integration: 'Cyntra',
  currencycode: 'USD'
};

// Tax % applied to every item (NJ sales tax 6.625% → $12.99 gives $0.86,
// matching the sample Bikanervala receipt).
export const TAX_PCT = 6.625;
export const TAX_DESC = 'Sales Tax';

// Items added to every scanned order.
export const DEFAULT_ITEMS = [
  {
    item_id: 'RICE_BOWL',
    sku: '7900001',
    item_name: 'Rice Bowl',
    price: 12.99,
    quantity: 1,
    modifiers: ['NO Boiled Rice']
  }
];

// The order lands on the CDS in this state / status.
//   order_status CLOSE  -> paid order (third-party already collected payment)
//   order_state  READY  -> shows in the "Ready" column on the CDS.
//   Note: if the store has general_config.order_auto_ready enabled, the backend
//   turns any CLOSE order into COMPLETED — keep that setting off for this store.
export const ORDER_SOURCE = 'QR Order';
export const ORDER_SOURCE_CODE = 'QR';

export const ORDER_STATUS = 'CLOSE';
export const ORDER_STATE = 'READY';

// Receipt order type (e.g. "Doordash - Delivery") → backend order_code.
// Adjust codes to match the order types configured for the store
// (POST /api/transaction/order-type returns them).
export const ORDER_CODE_BY_TYPE = {
  delivery: 'DL',
  pickup: 'PU',
  takeout: 'TA',
  'take away': 'TA',
  'dine in': 'DI'
};
export const DEFAULT_ORDER_CODE = 'DL';

// Known third-party platforms that print their name on the receipt.
export const PLATFORMS = ['Doordash', 'Uber Eats', 'UberEats', 'Grubhub', 'Postmates', 'Seamless', 'Caviar'];
