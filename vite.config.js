import { defineConfig } from 'vite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Local disk cache for tarkov.dev tiles/SVG: /tiles/<path> -> https://assets.tarkov.dev/<path>
function assetCache() {
  return {
    name: 'tarkov-asset-cache',
    configureServer(server) {
      server.middlewares.use('/tiles', async (req, res) => {
        const path = req.url.split('?')[0];
        const file = `.cache${path}`;
        try {
          const buf = await readFile(file);
          res.setHeader('Content-Type', path.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
          res.setHeader('Cache-Control', 'max-age=604800');
          return res.end(buf);
        } catch {}
        const upstream = await fetch(`https://assets.tarkov.dev${path}`);
        if (!upstream.ok) { res.statusCode = upstream.status; return res.end(); }
        const buf = Buffer.from(await upstream.arrayBuffer());
        await mkdir(dirname(file), { recursive: true });
        writeFile(file, buf).catch(() => {});
        res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'image/png');
        res.setHeader('Cache-Control', 'max-age=604800');
        res.end(buf);
      });
    },
  };
}

export default defineConfig({
  plugins: [assetCache()],
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
