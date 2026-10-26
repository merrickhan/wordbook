import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

type Handler = (request: Request) => Promise<Response>;

// Serves the same /api handler as the Vercel function during `pnpm dev`, reading DATABASE_URL,
// WORDBOOK_PASSWORD and WORDBOOK_SESSION_SECRET from .env.local (for example via `vercel env pull`).
function devApi(): Plugin {
  return {
    name: 'wordbook-dev-api',
    apply: 'serve',
    configureServer(server) {
      const env = loadEnv(server.config.mode, process.cwd(), '');
      let handler: Promise<Handler> | undefined;
      server.middlewares.use(async (req, res, next) => {
        const path = req.url ?? '';
        if (path !== '/api' && !path.startsWith('/api/') && !path.startsWith('/api?')) return next();
        try {
          handler ??= server.ssrLoadModule('/server/handler.ts')
            .then(module => (module.createHandler as (env: Record<string, string>) => Handler)(env));
          const handle = await handler;
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers))
            if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          const method = req.method ?? 'GET';
          const body = method === 'GET' || method === 'HEAD' ? undefined : Readable.toWeb(req) as unknown as ReadableStream;
          const response = await handle(new Request(new URL(path, `http://${req.headers.host ?? 'localhost'}`),
            { method, headers, body, duplex: 'half' } as RequestInit));
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

export default defineConfig({
  // Relative paths keep the static build portable between a root domain and a subpath.
  base: './',
  plugins: [
    react(),
    devApi(),
    {
      name: 'third-party-notices',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'THIRD-PARTY-NOTICES.md',
          source: readFileSync(new URL('./THIRD-PARTY-NOTICES.md', import.meta.url), 'utf8'),
        });
      },
    },
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Keep deployed code readable for browser debugging.
    minify: false,
    cssMinify: false,
    sourcemap: true,
  },
});
