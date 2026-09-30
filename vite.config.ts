import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative paths let the same static build work under a Pages repository path or a custom domain.
  base: './',
  plugins: [
    react(),
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
