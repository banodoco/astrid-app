import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';

const appRoot = path.resolve(__dirname, '../../..');
const publicCheckout = process.env.ASTRID_PUBLIC_CHECKOUT;
if (!publicCheckout || !path.isAbsolute(publicCheckout)) throw new Error('ASTRID_PUBLIC_CHECKOUT must be absolute');
const publicRoot = path.join(fs.realpathSync(publicCheckout), 'astrid');

export default defineConfig({
  root: __dirname,
  base: '/astrid-preview/',
  publicDir: path.join(appRoot, 'public'),
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.join(appRoot, 'src'),
      '@astrid/editor-sdk': path.join(appRoot, 'src/sdk/index.ts'),
      '@astrid-public': publicRoot,
      react: path.join(appRoot, 'node_modules/react'),
      'react-dom': path.join(appRoot, 'node_modules/react-dom'),
      remotion: path.join(appRoot, 'node_modules/remotion'),
      '@remotion/layout-utils': path.join(appRoot, 'node_modules/@remotion/layout-utils'),
      '@remotion/media': path.join(appRoot, 'node_modules/@remotion/media'),
      '@banodoco/timeline-schema': path.join(appRoot, 'src/test/shims/banodoco/timeline-schema.ts'),
    },
    dedupe: ['three', '@remotion/three', 'react', 'react-dom', 'remotion', '@banodoco/timeline-composition'],
  },
  server: { host: '127.0.0.1', strictPort: true, fs: { allow: [appRoot, publicCheckout] } },
});
