import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.VITE_API_PROXY || 'http://localhost:4000';

// Same-origin /api in dev, so there is one URL to configure and no CORS story.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: api, changeOrigin: true },
    },
  },
});
