import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const certPath = path.resolve(__dirname, '../certs/cert.pem');
const keyPath  = path.resolve(__dirname, '../certs/key.pem');

const httpsConfig = (fs.existsSync(certPath) && fs.existsSync(keyPath))
  ? { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }
  : undefined;

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // injectManifest: vite-plugin-pwa builds src/sw.js, injects the
      // precache manifest into self.__WB_MANIFEST, and outputs dist/sw.js.
      // This merges our Workbox caching with the push notification handlers
      // without one overwriting the other.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',

      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png', 'manifest.json'],

      manifest: {
        name: 'DIS-RUPTURE Early Warning',
        short_name: 'DIS-RUPTURE',
        description: 'Predictive Early Warning Command Center for Jabodetabek disruptions',
        start_url: '/',
        display: 'standalone',
        orientation: 'portrait-primary',
        background_color: '#0a0f1e',
        theme_color: '#6366f1',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          { src: '/icons/icon-180.png', sizes: '180x180', type: 'image/png' },
        ],
        shortcuts: [
          {
            name: 'Live Feed',
            short_name: 'Feed',
            description: 'View active threat alerts',
            url: '/?tab=feed',
            icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }],
          },
        ],
      },

      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    allowedHosts: ['gk-m1mini.tail68c554.ts.net', '.tail68c554.ts.net', 'localhost'],
    https: httpsConfig,
  },
});
