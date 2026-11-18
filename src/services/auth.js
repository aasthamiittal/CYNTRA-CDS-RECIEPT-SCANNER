import { LOGIN_SOURCE } from '../config.js';

const SESSION_KEY = 'receipt_cds_session';
const DEVICE_KEY = 'receipt_cds_device_id';
const LAST_STORE_KEY = 'receipt_cds_last_store';
// Backend tokens expire 30 minutes after login; log out a minute early.
const TOKEN_TTL_MS = 29 * 60 * 1000;

// Stable per-browser id: the backend registers a terminal per device_id on login.
export function getDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `rcpt-${crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

// Store the device last signed in to, so the login form can prefill it.
export const getLastStoreId = () => localStorage.getItem(LAST_STORE_KEY) || '';

export function getSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (s && s.store_id && s.expiresAt > Date.now()) return s;
  } catch {
    /* corrupt value */
  }
  localStorage.removeItem(SESSION_KEY);
  return null;
}

export function logout() {
  localStorage.removeItem(SESSION_KEY);
}

// The store is taken from the employee record returned by the backend.
export async function login(emp_no, password) {
  const device_id = getDeviceId();
  const res = await fetch(`${__API_BASE__}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emp_no, password, source: LOGIN_SOURCE, device_id })
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  if (res.status === 202 || body?.data?.password_reset === 1) {
    throw new Error(body?.message || 'Password reset required — reset it in the Cyntra portal first.');
  }
  if (!res.ok || !body?.status) {
    const m = body?.message;
    throw new Error(m ? (typeof m === 'string' ? m : JSON.stringify(m)) : `Login failed (${res.status})`);
  }
  const d = body.data;
  if (!d?.auth_token) throw new Error('Login response did not include a token.');
  const store_id = String(d.employee?.store_id ?? d.store_details?.store_id ?? '');
  if (!store_id) throw new Error("Login response did not include the employee's store.");
  if (!d.session_id) {
    throw new Error(`No employee session found for this user. Open a session on the POS for store ${store_id} first.`);
  }
  const session = {
    auth_token: d.auth_token,
    session_id: String(d.session_id),
    store_session_id: d.store_session_id ? String(d.store_session_id) : '',
    emp_no: d.employee?.emp_no || emp_no,
    emp_name: d.employee?.emp_name || emp_no,
    store_id,
    store_name: d.store_details?.store_name || '',
    currency: d.store_details?.store_currency || '',
    device_id,
    expiresAt: Date.now() + TOKEN_TTL_MS
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  localStorage.setItem(LAST_STORE_KEY, store_id);
  return session;
}
