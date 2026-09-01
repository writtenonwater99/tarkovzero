import { defineConfig } from 'vite';
import { localGameDerivedDevPlugin } from './scripts/lib/local-game-derived-dev.mjs';
import { tarkovAssetCacheDevPlugin } from './scripts/lib/tarkov-asset-cache-dev.mjs';

export default defineConfig({
  // `localGameDerivedDevPlugin` is `apply: 'serve'`: the user-owned Customs
  // package lives outside `public/`, so a production build can neither copy it
  // nor gain the route that reads it.
  plugins: [tarkovAssetCacheDevPlugin(), localGameDerivedDevPlugin()],
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
