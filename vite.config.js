import { defineConfig } from 'vite';

// Pure frontend app. No backend, no proxy. Everything runs in the browser.
export default defineConfig({
  // pdfjs-dist ships an ESM worker that Vite can bundle as a URL import.
  // Nothing special is required here, but we keep the config explicit.
  server: {
    open: true, // `npm run dev` opens a browser tab
  },
  preview: {
    // `vite preview` (used by the Playwright tests' webServer) must NOT open a
    // browser. Preview otherwise inherits server.open, so disable it explicitly.
    open: false,
  },
  optimizeDeps: {
    // pdfjs-dist + pdf-lib are large; let Vite pre-bundle them.
    include: ['pdfjs-dist', 'pdf-lib'],
  },
});
