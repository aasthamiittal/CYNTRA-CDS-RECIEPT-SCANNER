# Receipt Scan → CDS

React (Vite) web app: scan a third-party receipt with the camera, read the
**Order Type** (e.g. `Doordash - Delivery`) and **Check #** (e.g. `101`), and
place the order into the store you signed in to, so it shows on that store's CDS.

## Run

```bash
npm install
npm run dev            # https://localhost:5173  (or https://<pc-ip>:5173 on a phone)
npm test               # receipt parser tests
```

The dev server uses a self-signed HTTPS cert (the camera only works on HTTPS);
accept the browser warning once. `/api/*` is proxied to `API_URL` (hard-coded in `src/config.js`).

## Flow

1. Sign in with Store ID + employee no + password (the Store ID is remembered on the device).
1. Camera opens → **Capture**, or **Add manual** to type Order Type / Check # / Customer without scanning.
2. OCR runs in the browser (tesseract.js) → Order Type, Check #, Customer are filled in (editable).
3. Hard-coded items from `src/config.js` are shown (qty adjustable).
4. **Send to CDS** → `POST /api/transaction/order-place`.

## Mapping

| Receipt            | Order payload                                                  |
|--------------------|----------------------------------------------------------------|
| `Doordash - Delivery` | `order_source: Doordash`, `order_type: Delivery`, `store_details.order_des` |
| `Check #101`       | `store_details.order_reference_no: "101"`                      |
| Customer (`Aum M`) | `customer_details[0].cust_first_name`                           |

The store (`store_id`, currency) and employee session come from the login. Everything else (items, tax, payment, status)
is hard-coded in `src/config.js`.
