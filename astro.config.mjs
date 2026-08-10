// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// Deployed at https://harsh.bet/studies/ (GitHub Pages project site; the
// user site carries the harsh.bet custom domain, so this repo's name is the
// path segment).
//
// NOTE: `output: 'static'` is not optional here. The upstream API
// (https://research.tamu.edu/wp-json/wp/v2/study) does NOT return an
// Access-Control-Allow-Origin header, so a browser `fetch()` is blocked by
// CORS. All upstream data must be pulled server-side at build time by
// `npm run fetch:data` and baked into the output. Never fetch upstream from
// client-side code.
export default defineConfig({
  site: 'https://harsh.bet',
  base: '/studies',
  output: 'static',

  // 'always' + 'directory' keeps every internal link canonical under the
  // /studies/ subpath and works on any plain static host (GitHub Pages,
  // Cloudflare Pages, nginx) without rewrite rules.
  trailingSlash: 'always',
  build: {
    format: 'directory',
  },

  vite: {
    plugins: [tailwindcss()],
  },
});
