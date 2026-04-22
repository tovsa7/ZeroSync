# ZeroSync Landing Page

Astro-based static landing page. Deploys to `https://tovsa7.github.io/ZeroSync/`.

## Stack

- **Astro 5+** (static site generator, zero JS on the client for most pages)
- **Tailwind CSS 4** via `@tailwindcss/vite` (CSS-based config, see `src/styles/global.css`)
- **TypeScript strict**
- **Dark mode only** (light-mode toggle planned for v2)

## Structure

```
landing/
├── src/
│   ├── layouts/
│   │   └── Base.astro              Meta / OG / JSON-LD / favicon / global styles
│   ├── pages/
│   │   └── index.astro             Composes all sections
│   ├── components/
│   │   ├── Hero.astro              Above-the-fold: headline + CTAs + diagram
│   │   ├── Why.astro               5 value bullets with icons
│   │   ├── UseCases.astro          5 industry cards
│   │   ├── QuickStart.astro        React + Vanilla code examples (tabs)
│   │   ├── HowItWorks.astro        Protocol diagram + 4 bullets
│   │   ├── Comparison.astro        Table vs Liveblocks / Yjs / Jazz.tools
│   │   ├── Pricing.astro           4-tier cards
│   │   ├── ForCompanies.astro      Design-partners CTA
│   │   └── Footer.astro            Links + copyright
│   └── styles/
│       └── global.css              Tailwind @theme + design tokens
├── public/
│   └── favicon.svg                 Minimal mark — teal Z shape
├── astro.config.mjs                base: '/ZeroSync/'
└── tsconfig.json                   Extends astro/tsconfigs/strict
```

## Local development

```bash
npm install
npm run dev            # http://localhost:4321/ZeroSync/
npm run build          # → dist/
npm run preview        # serve built output locally
```

Because `astro.config.mjs` sets `base: '/ZeroSync/'`, local dev serves at
`http://localhost:4321/ZeroSync/` (not the root). This matches the production
gh-pages path.

## Deployment

Handled by `.github/workflows/pages.yml` on every push to `main`:

1. Build `packages/client` (so `demo/` dependency resolves)
2. Build `landing/` (Astro → `landing/dist/`)
3. Build `demo/` with `VITE_BASE_PATH=/ZeroSync/demo/` (Vite → `demo/dist/`)
4. Combine: `landing/dist/` at root, `demo/dist/` at `/demo/`
5. Upload + deploy to GitHub Pages

Result:
- `tovsa7.github.io/ZeroSync/` → landing page (this directory)
- `tovsa7.github.io/ZeroSync/demo/` → React demo (the `demo/` directory)

## Content source of truth

All copy is grounded in the main repo `README.md` and canonical pricing doc.
If you change pricing, update **both** this landing AND the main repo README.
If you change use-case framing, update **both**.

## Design tokens

See `src/styles/global.css` `@theme` block. Key colors:

- Accent: `#5EEAD4` (teal)
- Success: `#86EFAC`
- Danger: `#F87171`
- Backgrounds use Tailwind's `neutral-950` / `neutral-900` scales

## Troubleshooting

**Local styles don't match production?** Clear `.astro/` cache: `rm -rf .astro node_modules/.vite && npm run dev`.

**Code blocks unstyled?** Astro's `<Code>` component lazy-loads Shiki themes.
First run after install might show unstyled code for a second.

**Images not loading on gh-pages?** Always use `import.meta.env.BASE_URL` or
absolute paths with `/ZeroSync/` prefix. Plain `/foo.png` will 404 on
gh-pages.
