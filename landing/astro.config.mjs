// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // Deploys to gh-pages at tovsa7.github.io/ZeroSync/
  site: 'https://tovsa7.github.io',
  base: '/ZeroSync/',
  build: {
    format: 'directory',
    assets: 'assets',
  },
  vite: {
    plugins: [tailwindcss()],
  },
});