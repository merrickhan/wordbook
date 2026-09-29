import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // 相对路径让同一份静态产物可用于 Pages 仓库子路径或自定义域名。
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
    // 部署产物保留可读代码，方便浏览器中定位问题。
    minify: false,
    cssMinify: false,
    sourcemap: true,
  },
});
