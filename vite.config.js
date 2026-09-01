import { defineConfig } from 'vite';
import { localGameDerivedDevPlugin } from './scripts/lib/local-game-derived-dev.mjs';
import { tarkovAssetCacheDevPlugin } from './scripts/lib/tarkov-asset-cache-dev.mjs';
import { vegetationArraytexDevPlugin } from './scripts/lib/vegetation-arraytex-dev.mjs';
import { vegetationAuthoredDevPlugin } from './scripts/lib/vegetation-authored-dev.mjs';

export default defineConfig({
  // `localGameDerivedDevPlugin`, `vegetationAuthoredDevPlugin` and
  // `vegetationArraytexDevPlugin` are all `apply: 'serve'`: their packages live
  // outside `public/`, so a production build can neither copy them in nor gain
  // the routes that read them.
  //
  // All three must be registered. A `/@…` prefix with no plugin behind it does
  // NOT 404 — Vite's SPA fallback answers it with HTTP 200 and index.html, so
  // `response.ok` is true and the miss only surfaces as a JSON parse error deep
  // inside a consumer. That is exactly how the texture-array route was missing
  // while the app reported a healthy authored-vegetation mount.
  plugins: [
    tarkovAssetCacheDevPlugin(),
    localGameDerivedDevPlugin(),
    vegetationAuthoredDevPlugin(),
    vegetationArraytexDevPlugin(),
  ],
  server: {
    proxy: {
      '/api/graphql': { target: 'https://api.tarkov.dev', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
      // The AI assistant is a Vercel function; in dev it runs under `vercel dev` (default :3000).
      // Without it the panel just reports that the assistant is unreachable — nothing else breaks.
      '/api/assistant': {
        target: `http://127.0.0.1:${process.env.VERCEL_DEV_PORT || 3000}`,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('error', (_err, _req, res) => {
            if (!res || res.headersSent || !res.writeHead) return;
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Assistant offline in dev — run `vercel dev` (port 3000) alongside `npm run dev`.' }));
          });
        },
      },
    },
  },
});
