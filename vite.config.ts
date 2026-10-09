import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import WindowsTestSequencer from './scripts/windows-test-sequencer.mjs';

const windowsProfileSequence = process.env.AGENTFORGE_WINDOWS_PROFILE_SEQUENCE === '1';
delete process.env.AGENTFORGE_WINDOWS_PROFILE_SEQUENCE;

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
    ...(windowsProfileSequence ? { sequence: { sequencer: WindowsTestSequencer } } : {}),
    testTimeout: 30000,
    hookTimeout: 60000,
    setupFiles: ['./tests/testOutputSanitizer.ts'],
  },
});
