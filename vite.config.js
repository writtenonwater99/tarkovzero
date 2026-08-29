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
    },
  },
});
