/**
 * Tailwind v4 is CSS-first: the source of truth for theme tokens is the
 * `@theme` block in src/styles/global.css. This file exists for the bits that
 * still want JS (content globs, plugins) and is wired up explicitly via the
 * `@config "../../tailwind.config.mjs";` directive in that stylesheet.
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
};
