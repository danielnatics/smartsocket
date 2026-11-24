import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon-192.svg', 'icons/icon-512.svg', 'favicon.ico'],
      manifest: {
        name: 'PowerSense Smart Sockets',
        short_name: 'PowerSense',
        description: 'Smart energy monitoring, appliance protection and remote control.',
        start_url: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0B1120',
        theme_color: '#0B1120',
        icons: [
          {
            src: '/icons/icon-192.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
          {
            src: '/icons/icon-512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
        categories: ['utilities', 'productivity'],
        shortcuts: [
          {
            name: 'My Sockets',
            url: '/',
            description: 'View all your PowerSense sockets',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico}'],
        // Cache MQTT broker connections are live — don't cache API calls
        navigateFallback: 'index.html',
      },
      devOptions: {
        enabled: false, // keep dev fast; PWA only active in production build
      },
    }),
  ],
  server: {
    port: 3000,
    host: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
