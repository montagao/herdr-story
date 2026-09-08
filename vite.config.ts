import { defineConfig } from 'vite';
import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
let publicOutput = '';
const publicBuild = process.env.HERDR_STORY_PUBLIC_BUILD === '1';
export default defineConfig({
  publicDir: publicBuild ? false : 'public',
  plugins: publicBuild ? [{
    name: 'redistributable-public-files',
    configResolved(config) { publicOutput = resolve(config.root, config.build.outDir); },
    closeBundle() {
      for (const path of ['assets/open', 'assets/studio', 'demo']) {
        const dest = resolve(publicOutput, path);
        mkdirSync(resolve(dest, '..'), { recursive: true });
        cpSync(resolve('public', path), dest, { recursive: true });
      }
    },
  }] : [],
  server: {
    port: 5173,
    // Tailscale Serve proxies this loopback listener; neither Vite nor the Herdr bridge needs to
    // be exposed to the LAN. MagicDNS HTTPS names end in .ts.net.
    host: '127.0.0.1',
    allowedHosts: ['localhost', '127.0.0.1'],
    // Keep browser traffic same-origin; Tailscale Serve forwards both HTTP and WebSocket traffic.
    proxy: { '/ws': { target: 'ws://localhost:7788', ws: true }, '/api': { target: 'http://localhost:7788' } },
  },
  build: { target: 'es2022' },
});
