import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.VITE_API_PROXY || 'http://localhost:4000';

// Same-origin /api in dev, so there is one URL to configure and no CORS story.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: api,
        changeOrigin: true,
        // When the API dies, the proxy otherwise leaves the browser's
        // /api/stream hanging open, so EventSource never reconnects and the
        // page goes stale. Closing the socket makes it reconnect and refetch.
        configure: (proxy) => proxy.on('error', (_err, _req, res) => res.destroy?.()),
      },
    },
  },
});
