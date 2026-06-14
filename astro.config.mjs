// @ts-check
import { defineConfig } from 'astro/config';

// GitHub Pages: https://nasircy.github.io/CCTV-RD/
export default defineConfig({
  site: 'https://nasircy.github.io',
  base: '/CCTV-RD',
  output: 'static',
  build: {
    assets: 'assets',
  },
});
