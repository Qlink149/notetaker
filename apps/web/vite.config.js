import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  esbuild: { jsx: 'automatic' }, // JSX in test files, like the app
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // The API is reached through this same address (`/api`), so one HTTPS tunnel serves phones and laptop.
  server: { port: 5173, proxy: { '/api': 'http://localhost:8080' }, allowedHosts: true },
  test: { environment: 'jsdom', include: ['test/**/*.test.{js,jsx}'], globals: false },
  preview: {
    port: 5173,
    host: true,
    proxy: { '/api': 'http://localhost:8080' },
    allowedHosts: true,
  },
});
