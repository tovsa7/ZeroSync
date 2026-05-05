import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // VITE_BASE_PATH: set to repo name for GitHub Pages (e.g. '/zerosync/'),
  // or '/' for custom domain / local dev.
  base: process.env.VITE_BASE_PATH ?? '/',
  resolve: {
    // Force a single instance of these packages across the bundle. Without
    // this, file:-linked workspace packages (`@tovsa7/zerosync-react`) bring
    // their own copy via devDependencies, and the demo gets two:
    //   - yjs   — two instances break constructor checks (yjs/yjs#438)
    //   - react — two instances cause "Cannot read properties of null
    //             (reading 'useState')" because hooks dispatcher mismatches
    //             between the React the component imports vs. the one that
    //             actually rendered the tree.
    dedupe: ['yjs', 'react', 'react-dom'],
  },
})
