# TAMU Paid Research Studies

A browsable, sortable index of the paid research studies Texas A&M University
recruits volunteers for — ranked by **effective hourly pay**.

Live at <https://harsh.bet/r/studies>.

## Why this exists

Texas A&M publishes its Aggie Research Volunteers study listings through an
open WordPress REST API at `https://research.tamu.edu/wp-json/wp/v2/study`.
There are 86 active records. There is no browse UI in front of them — no way
to sort, filter, compare, or even see them all on one page.

That matters because the interesting question a prospective participant has is
not "what studies exist" but "which of these is actually worth my time." That
answer is buried: compensation and duration are stored as unstructured free
text (`"Up to $30 <br>Paid as Amazon gift card"`, `"One-session study lasting
about 2 hours"`), so comparing two listings means reading both in full and
doing mental arithmetic. This site parses that free text, computes a
guaranteed dollars-per-hour figure, and sorts by it.

Two things the raw API will not tell you, which this site surfaces:

- **Expired listings are still served.** Records carry expiration dates well
  in the past (2025-01-02, 2025-04-02, …) while `status` remains `"publish"`.
  The API gives you no signal. Expired postings here are detected and visually
  separated rather than presented as live opportunities.
- **`aux_study_item_lifecycle` is not a status.** Its values (3, 6, 12) are the
  posting duration in months. It is easy to misread as a state field.

## Architecture

```
scripts/fetch-data.ts   Build-time fetch of raw API + taxonomy payloads
fixtures/               Frozen 86-record snapshot; the fixture for all tests
src/types.ts            THE CENTRAL CONTRACT - shared by every module
src/lib/html.ts         stripHtml / decodeEntities / truncate
src/lib/                Parsers, ranking, eligibility matching
src/pages/              Astro routes (static output)
src/styles/global.css   Tailwind v4 CSS-first theme tokens
```

**Data flows one way, at build time only:**

```
research.tamu.edu API  ──(node, build time)──>  src/data/*.json
                                                      │
                              parse + normalize + rank ▼
                                             StudyRecord[]  ──> static HTML
```

The critical constraint: **the upstream API sends no
`Access-Control-Allow-Origin` header**, so a browser `fetch()` against it is
blocked by CORS. Fetching therefore happens server-side in Node during the
build and the results are baked into static HTML. Do not add client-side calls
to `research.tamu.edu`; they will fail in every browser.

(Upstream does send `Access-Control-Expose-Headers: X-WP-Total,
X-WP-TotalPages, Link`. `per_page=100` returns all 86 records in a single page;
`fetch-data.ts` hard-fails if that ever stops being true rather than quietly
publishing a partial index.)

Tests never touch the network. They run against `fixtures/arv-snapshot.json`,
a real complete capture of all 86 records, so parser behaviour is pinned to
actual upstream data and stays reproducible offline.

## Running it

Requires Node ≥ 22.12 (see `.nvmrc`).

```bash
nvm use
npm install

npm run fetch:data   # pull fresh data into src/data/ (network required)
npm run dev          # dev server
npm run build        # fetch:data + static build into dist/
npm run preview      # serve the built output

npm run test         # vitest, watch mode
npm run test:run     # vitest, single run (CI)
npm run typecheck    # astro check + tsc --noEmit
```

`src/data/` is generated and git-ignored. `fixtures/` is committed on purpose.

## Deploying under the `/r/studies` subpath

The site is not served from a domain root, which is the usual source of broken
static deploys. `astro.config.mjs` sets:

```js
site: 'https://harsh.bet',
base: '/r/studies',
trailingSlash: 'always',
build: { format: 'directory' },
```

`npm run build` emits `dist/`, whose contents map to `https://harsh.bet/r/studies/`.
Upload `dist/` so that `dist/index.html` resolves at `/r/studies/index.html`.

Two rules when writing links and asset paths:

- Always prefix internal URLs with the base — use `import.meta.env.BASE_URL`
  or Astro's `<a href={`${import.meta.env.BASE_URL}foo/`}>`. A bare `/foo/`
  will 404 in production while working fine in `astro dev`.
- Keep trailing slashes on internal links, matching `trailingSlash: 'always'`.

Use `npm run preview` before shipping — it honours `base`, so subpath mistakes
surface locally instead of in production.

Because the data is fetched at build time, the published site is a snapshot.
Rebuild on a schedule to keep listings and expiry states current.

## Disclaimer

**This site is not affiliated with, endorsed by, or operated by Texas A&M
University.** It is an independent, unofficial project that reformats publicly
available data from Texas A&M's open research API for easier browsing.

Listings may be out of date, and parsed compensation and duration figures are
derived automatically from free-text fields and may be wrong. Always confirm
details — pay, time commitment, eligibility, and whether a study is still
recruiting — with the study contact and the official listing on
`research.tamu.edu` before participating. Every entry links back to its
official source.
