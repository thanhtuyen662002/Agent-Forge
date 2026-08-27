import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const isGitHubActionsWindows =
  process.env.GITHUB_ACTIONS === 'true' &&
  process.platform === 'win32';

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    testTimeout: 30000,
    hookTimeout: 60000,
    ...(isGitHubActionsWindows ? { maxWorkers: 2 } : {}),
  },
});
