import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { API_URL } from './src/config.js';

// The camera (getUserMedia) only works on https:// or http://localhost.
// basicSsl gives a self-signed https cert so the app can be opened from a
// phone on the same network (https://<your-pc-ip>:5173).
// In dev, /api calls are proxied to the Food API backend, so there is no CORS
// or mixed-content (https page -> http backend) problem.
export default defineConfig(({ command }) => ({
  plugins: [react(), basicSsl()],
  // Dev: '' (calls go through the proxy below). Build: full API URL, called directly.
  define: {
    __API_BASE__: JSON.stringify(command === 'build' ? API_URL : '')
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: API_URL,
        changeOrigin: true,
        secure: false
      }
    }
  }
}));
