import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Builds everything into one self-contained dist/index.html that works offline.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: { target: 'es2022' },
  worker: { format: 'iife' }, // classic worker: module workers fail when opened from file://
});
