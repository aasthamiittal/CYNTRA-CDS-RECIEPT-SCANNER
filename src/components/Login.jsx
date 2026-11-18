import { useState } from 'react';
import { login } from '../services/auth.js';

export default function Login({ onLogin, notice }) {
  const [empNo, setEmpNo] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (!empNo.trim() || !password) return setError('Enter employee no. and password.');
    setBusy(true);
    setError('');
    try {
      onLogin(await login(empNo.trim(), password));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card login" onSubmit={submit}>
      <h2>Sign in</h2>
      {notice && <div className="notice">{notice}</div>}
      <label>
        Employee No.
        <input value={empNo} autoComplete="username" onChange={(e) => setEmpNo(e.target.value)} />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error && <div className="error">{error}</div>}
      <button className="btn primary" type="submit" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
