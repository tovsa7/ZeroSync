import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // VITE_BASE_PATH: set to repo name for GitHub Pages (e.g. '/zerosync/'),
  // or '/' for custom domain / local dev.
  base: process.env.VITE_BASE_PATH ?? '/',
})
