import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? '';
const isProjectPage = Boolean(repositoryName && !repositoryName.endsWith('.github.io'));
const base = process.env.GITHUB_PAGES === 'true' && isProjectPage ? `/${repositoryName}/` : '/';

export default defineConfig({
  base,
  css: { postcss: { plugins: [tailwindcss()] } },
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  server: { host: '0.0.0.0', port: 3000, strictPort: true },
  build: { outDir: 'dist/client', emptyOutDir: true },
});
