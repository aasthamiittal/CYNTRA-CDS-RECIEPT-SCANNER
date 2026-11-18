import { useEffect, useRef, useState } from 'react';
import CameraScanner from './components/CameraScanner.jsx';
import Login from './components/Login.jsx';
import { getSession, logout } from './services/auth.js';
import { prepareImage, recognizePass, warmUpOcr } from './services/ocr.js';
import { parseReceipt, parseOrderType, mergeReceipts, isCompleteReceipt } from './services/receiptParser.js';
import { buildOrderPayload, placeOrder, AuthError } from './services/orderApi.js';
import { DEFAULT_ITEMS, TAX_PCT } from './config.js';

const money = (n) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
const newScanId = () => Date.now().toString(36);
// OCR passes on the cropped receipt top (psm 6 = one block of text; automatic
// layout analysis drops the boxed "Doordash - Delivery" line).
// Main round (progress bar): normal + shadow-robust variants, run in parallel.
// Extra round (background, only if service type or check # is missing): strong
// sharpening for blur. Results are shown after the main round; the extra round
// only fills fields that are still empty.
const MAIN_ROUND = [
  { mode: 'gray', sharpen: 0.8, psm: '6' },
  { mode: 'adaptive', sharpen: 0.8, psm: '6' }
];
const EXTRA_ROUND = [
  { mode: 'binary', sharpen: 2, psm: '6' },
  { mode: 'gray', sharpen: 2.5, psm: '11' }
];
// Platform is optional: in-store receipts have none.
const hasEssentials = (r) => Boolean(r.serviceType && r.checkNumber);

const EXPIRED_MSG = 'Your session expired — sign in again. Your scanned receipt is kept.';

export default function App() {
  const [session, setSession] = useState(getSession);
  const [loginNotice, setLoginNotice] = useState('');
  const [step, setStep] = useState('scan'); // scan | review | done
  const [image, setImage] = useState(null);
  const [ocrProgress, setOcrProgress] = useState(null);
  const [refining, setRefining] = useState(false);
  const [fields, setFields] = useState({ orderType: '', checkNumber: '', customerName: '' });
  const [items, setItems] = useState(DEFAULT_ITEMS.map((i) => ({ ...i })));
  const [scanId, setScanId] = useState(newScanId);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const scanRef = useRef(0);
  // Manual entry = review form opened via "Add manual" (no captured photo).
  const manual = !image;

  // Load the OCR engine and language model in the background right away, so
  // it is ready by the time a receipt is captured.
  useEffect(() => {
    warmUpOcr();
  }, []);

  async function handleCapture(dataUrl) {
    setImage(dataUrl);
    setStep('review');
    setError('');
    setOcrProgress(0);
    setRefining(false);
    setFields({ orderType: '', checkNumber: '', customerName: '' });
    setScanId(newScanId());
    const scan = ++scanRef.current;
    const current = () => scan === scanRef.current;
    const results = [];

    // Runs passes in parallel; resolves early once every field is found.
    function runRound(prepared, passes, onProgress) {
      const progress = passes.map(() => 0);
      // Once the round has finished (possibly early), passes that are still
      // running must not touch the UI any more — their late progress events
      // would otherwise bring the progress bar back over the results.
      let done = false;
      return new Promise((resolve) => {
        const finish = () => {
          done = true;
          resolve();
        };
        let pending = passes.length;
        passes.forEach((pass, i) => {
          recognizePass(prepared, {
            ...pass,
            onProgress: (p) => {
              progress[i] = p;
              if (!done && onProgress && current()) {
                onProgress(progress.reduce((a, b) => a + b, 0) / passes.length);
              }
            }
          })
            .then((t) => {
              if (done) return;
              results.push(parseReceipt(t));
              if (isCompleteReceipt(mergeReceipts(results))) finish();
            })
            .catch((e) => console.warn('OCR pass failed:', e.message))
            .finally(() => {
              if (--pending === 0) finish();
            });
        });
      });
    }

    const show = (onlyEmpty) => {
      const parsed = mergeReceipts(results);
      // Never overwrite a value already shown (the user may have edited it).
      setFields((prev) => ({
        orderType: onlyEmpty && prev.orderType ? prev.orderType : parsed.orderType,
        checkNumber: onlyEmpty && prev.checkNumber ? prev.checkNumber : parsed.checkNumber,
        customerName: onlyEmpty && prev.customerName ? prev.customerName : parsed.customerName
      }));
      return parsed;
    };

    try {
      const prepared = await prepareImage(dataUrl);
      await runRound(prepared, MAIN_ROUND, setOcrProgress);
      if (!current()) return;
      if (!results.length) throw new Error('could not read the image');
      let parsed = show(false);
      setOcrProgress(null);
      if (hasEssentials(parsed)) return;

      // Order type or check # missing: keep trying in the background while
      // the user can already review / type the fields.
      setRefining(true);
      await runRound(prepared, EXTRA_ROUND);
      if (!current()) return;
      parsed = show(true);
      if (!parsed.orderType || !parsed.checkNumber) {
        setError('Could not read everything from the receipt — please check the fields below.');
      }
    } catch (e) {
      if (current()) setError('OCR failed: ' + e.message);
    } finally {
      if (current()) {
        setOcrProgress(null);
        setRefining(false);
      }
    }
  }

  // Skip the camera: open the same review form with empty fields to type in.
  function handleManual() {
    ++scanRef.current; // cancel any OCR still running
    setImage(null);
    setStep('review');
    setError('');
    setOcrProgress(null);
    setRefining(false);
    setFields({ orderType: '', checkNumber: '', customerName: '' });
    setScanId(newScanId());
  }

  function updateItem(idx, patch) {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  }

  const subTotal = items.reduce((s, i) => s + i.price * (Number(i.quantity) || 0), 0);
  const tax = items.reduce(
    (s, i) => s + Math.round(i.price * (Number(i.quantity) || 0) * TAX_PCT) / 100,
    0
  );

  async function handlePlaceOrder() {
    setError('');
    if (!fields.checkNumber.trim()) return setError('Check number is required.');
    if (!fields.orderType.trim()) return setError('Order type is required.');
    const activeItems = items.filter((i) => Number(i.quantity) > 0);
    if (!activeItems.length) return setError('Add at least one item.');

    const current = getSession();
    if (!current) return handleLogout(EXPIRED_MSG);

    const { platform, serviceType } = parseOrderType(fields.orderType);
    const payload = buildOrderPayload({
      orderType: fields.orderType.trim(),
      platform,
      serviceType,
      checkNumber: fields.checkNumber.trim(),
      customerName: fields.customerName.trim(),
      items: activeItems,
      scanId,
      session: current
    });
    setPlacing(true);
    try {
      const data = await placeOrder(payload, current.auth_token);
      setResult(data);
      setStep('done');
    } catch (e) {
      if (e instanceof AuthError) handleLogout(EXPIRED_MSG);
      else setError(e.message);
    } finally {
      setPlacing(false);
    }
  }

  // Scanned values stay in state, so after signing in again the user is back
  // on the same receipt and only has to press Send to CDS again.
  function handleLogout(notice = '') {
    logout();
    setLoginNotice(notice);
    setSession(null);
  }

  function reset() {
    setStep('scan');
    setImage(null);
    setFields({ orderType: '', checkNumber: '', customerName: '' });
    setItems(DEFAULT_ITEMS.map((i) => ({ ...i })));
    setResult(null);
    setError('');
  }

  return (
    <div className="app">
      <header>
        <h1>Receipt → CDS</h1>
        <div className="header-right">
          {session && <span className="badge">Store {session.store_id}</span>}
          {session && (
            <button className="link" onClick={() => handleLogout()}>
              {session.emp_name} · Logout
            </button>
          )}
        </div>
      </header>

      {!session && (
        <Login
          notice={loginNotice}
          onLogin={(s) => {
            setSession(s);
            setLoginNotice('');
          }}
        />
      )}

      {session && step === 'scan' && <CameraScanner onCapture={handleCapture} onManual={handleManual} />}

      {session && step === 'review' && (
        <div className="review">
          {image && <img className="preview" src={image} alt="Captured receipt" />}

          {refining && <div className="notice">Still checking the receipt for missing fields…</div>}
          {ocrProgress !== null ? (
            <div className="progress">
              <div className="bar" style={{ width: `${Math.round(ocrProgress * 100)}%` }} />
              <span>Reading receipt… {Math.round(ocrProgress * 100)}%</span>
            </div>
          ) : (
            <>
              <section className="card">
                <h2>Order</h2>
                <label>
                  Order Type
                  <input
                    value={fields.orderType}
                    onChange={(e) => setFields({ ...fields, orderType: e.target.value })}
                  />
                </label>
                <label>
                  Order No. (Check #)
                  <input
                    value={fields.checkNumber}
                    inputMode="numeric"
                    onChange={(e) => setFields({ ...fields, checkNumber: e.target.value.replace(/\D/g, '') })}
                  />
                </label>
                <label>
                  Customer
                  <input
                    value={fields.customerName}
                    placeholder="Guest"
                    onChange={(e) => setFields({ ...fields, customerName: e.target.value })}
                  />
                </label>
              </section>

              {!manual && (
                <section className="card">
                  <h2>Items</h2>
                  {items.map((it, idx) => (
                    <div className="item" key={it.sku}>
                      <div className="item-main">
                        <strong>{it.item_name}</strong>
                        <span>{money(it.price)}</span>
                      </div>
                      {it.modifiers?.length > 0 && (
                        <ul className="mods">
                          {it.modifiers.map((m) => (
                            <li key={m}>{m}</li>
                          ))}
                        </ul>
                      )}
                      <div className="qty">
                        <span>Qty {it.quantity}</span>
                      </div>
                    </div>
                  ))}
                  <div className="totals">
                    <div><span>Subtotal</span><span>{money(subTotal)}</span></div>
                    <div><span>Tax ({TAX_PCT}%)</span><span>{money(tax)}</span></div>
                    <div className="grand"><span>Total</span><span>{money(subTotal + tax)}</span></div>
                  </div>
                </section>
              )}
            </>
          )}

          {error && <div className="error">{error}</div>}

          <div className="actions sticky">
            <button className="btn" onClick={reset} disabled={placing}>
              {manual ? 'Back' : 'Rescan'}
            </button>
            <button
              className="btn primary"
              onClick={handlePlaceOrder}
              disabled={placing || ocrProgress !== null}
            >
              {placing ? 'Sending…' : 'Send to CDS'}
            </button>
          </div>
        </div>
      )}

      {session && step === 'done' && (
        <div className="card done">
          <div className="tick">✓</div>
          <h2>Order sent to CDS</h2>
          <p>
            {fields.orderType} · Check #{fields.checkNumber}
          </p>
          {result && (
            <p className="muted">
              Invoice #{result.invoice_no ?? '—'} {result.order_no ? `· ${result.order_no}` : ''}
            </p>
          )}
          <button className="btn primary" onClick={reset}>
            Scan next receipt
          </button>
        </div>
      )}
    </div>
  );
}
