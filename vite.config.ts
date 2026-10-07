import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../app/renderer',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: [process.cwd()] },
  },
});
