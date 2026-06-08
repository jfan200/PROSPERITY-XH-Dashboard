import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const outDir = path.resolve(repoRoot, 'dist');
const assetCopies = [
  ['style.css', 'style.css'],
  ['mobile.css', 'mobile.css'],
  ['app.js', 'app.js'],
  ['mobile.js', 'mobile.js'],
  ['view-switch.js', 'view-switch.js'],
];

function copyLegacyAssets() {
  return {
    name: 'copy-legacy-assets',
    closeBundle() {
      for (const [from, to] of assetCopies) {
        fs.copyFileSync(path.resolve(repoRoot, from), path.resolve(outDir, to));
      }
    },
  };
}

export default defineConfig({
  root: __dirname,
  plugins: [react(), copyLegacyAssets()],
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        mobile: path.resolve(__dirname, 'mobile.html'),
      },
    },
  },
});
