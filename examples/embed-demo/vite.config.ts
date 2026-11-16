import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';

const repoRoot = path.resolve(__dirname, '../..');

export default defineConfig({
  root: __dirname,
  publicDir: path.resolve(repoRoot, 'public'),
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(repoRoot, 'src'),
      react: path.resolve(repoRoot, 'node_modules/react'),
      'react-dom': path.resolve(repoRoot, 'node_modules/react-dom'),
      remotion: path.resolve(repoRoot, 'node_modules/remotion'),
      '@remotion/layout-utils': path.resolve(repoRoot, 'node_modules/@remotion/layout-utils'),
      '@astrid/editor-sdk': path.resolve(repoRoot, 'src/sdk/index.ts'),
      '@workspace-effects': path.resolve(repoRoot, '../../banodoco-workspace/effects'),
      '@workspace-animations': path.resolve(repoRoot, '../../banodoco-workspace/animations'),
      '@workspace-transitions': path.resolve(repoRoot, '../../banodoco-workspace/transitions'),
    },
    dedupe: [
      'react',
      'react-dom',
      'react-reconciler',
      'remotion',
      '@banodoco/timeline-composition',
      '@banodoco/timeline-theme-2rp',
    ],
  },
  server: {
    fs: {
      allow: [path.resolve(repoRoot, '..', '..')],
    },
  },
  build: {
    outDir: path.resolve(repoRoot, 'dist/examples/embed-demo'),
    emptyOutDir: true,
  },
});
