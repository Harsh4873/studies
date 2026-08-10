# Deploying to `harsh.bet/studies`

This is a fully static site. There is no server, no database, and no runtime
secret — `npm run build` emits a directory of files and the whole deploy is
"put these files where that URL points".

It is deployed as a **GitHub Pages project site**, and one structural fact
does most of the work: the user site (`harsh4873.github.io`) carries the
`harsh.bet` custom domain, so every project repo on the account is served at
the path named after it. This repo is named `studies`, therefore the site is
`https://harsh.bet/studies/`. **The repo name IS the route** — renaming the
repo moves the site, and no CNAME file belongs in this repo (the domain
mapping lives entirely on the user site).

---

## 1. What the build produces

```
npm run build          # = npm run fetch:data && astro build
```

```
dist/
├── index.html                 the ranked listing
├── about/index.html
├── study/<slug>/index.html    one detail page per live study
├── rss.xml                    feed of new listings
├── api/studies.json           the normalized dataset
└── _astro/                    hashed CSS + JS
```

Two properties of this output drive everything else:

| Fact | Consequence |
|---|---|
| `astro.config.mjs` sets `base: '/studies'`, so every emitted link and asset URL is absolute and prefixed — e.g. `href="/studies/_astro/global.<hash>.css"` | The browser will request `/studies/…` **from `harsh.bet`**, no matter where the files physically live. Serving `dist/` anywhere but under `/studies/` gives you an unstyled page and a 404 for every asset. On Pages the repo name keeps this true by construction. |
| `trailingSlash: 'always'` + `build.format: 'directory'` | Internal links all end in `/` and resolve to `index.html`. GitHub Pages redirects bare directory paths (`/studies/about`) to the slashed form, which matches. |

`rss.xml` and `api/studies.json` keep their extensions and are *not* affected
by `trailingSlash` — they are served at exactly those two paths.

### Build requirements

| | |
|---|---|
| Node | ≥ 22.12 (`.nvmrc` pins 22.22.2) |
| Build command | `npm run build` — **not** `astro build`. The `fetch:data` half is what puts `src/data/*.json` on disk, and three modules import those files directly, so a bare `astro build` fails to resolve `@/data/snapshot.json`. (The workflows run the two halves as separate steps for the same reason.) |
| Output directory | `dist` |
| Install command | `npm ci` |
| Network at build time | Wanted, not required. `fetch:data` falls back to `fixtures/arv-snapshot.json` and exits 0 if `research.tamu.edu` is unreachable, so a TAMU outage produces a stale deploy rather than a failed one. Check the build log for `source FIXTURE  <-- STALE DATA`. |
| Runtime env vars | **None.** Nothing in the browser bundle reads a secret, and nothing calls an API at runtime — the upstream registry sends no `Access-Control-Allow-Origin`, so all fetching is build-time by necessity. |

---

## 2. Repository setup (already done, recorded for reference)

The repo is `harsh4873/studies`, public (GitHub Pages on a personal account
requires it). Pages is configured with build type **GitHub Actions** —
`deploy-pages.yml` runs `actions/configure-pages` with `enablement: true`, so
the Pages site created itself on the first deploy; there was no manual
*Settings → Pages* step.

One setting that must hold: **Settings → Actions → General → Workflow
permissions → Read and write permissions.** `refresh.yml` declares
`permissions: contents: write`, but a workflow can only narrow the repository
default, never widen it. If the repo default is read-only, the refresh job
runs green and silently fails at `git push`.

No secrets are required. Everything runs on the automatic `GITHUB_TOKEN`.

### One thing that will look like a bug

`src/data/` is in `.gitignore`, and `refresh.yml` commits into it with
`git add -f`. That is intentional, not an oversight:

- It is ignored because it is **generated** — every build recreates it, and
  keeping it out of ordinary commits stops 240 KB of churn on every PR.
- It is force-committed by the refresh job because `snapshot.json` is also the
  **diff baseline**. `fetch:data` computes "what changed" by comparing against
  the snapshot already on disk. With nothing committed, every run sees an empty
  baseline and reports every study as newly added.

---

## 3. The three workflows

### `.github/workflows/deploy-pages.yml` — the deploy

Runs on every push to `main` and on manual dispatch: `npm ci` → `fetch:data`
(fixture fallback) → require a usable snapshot → typecheck → `vitest run` →
`astro build` → validate the artifact (the `/studies/` prefix is present, no
CNAME, no plaintext contact addresses anywhere in `dist/`) → upload →
`actions/deploy-pages`. **Pushing to `main` IS the deploy.**

### `.github/workflows/ci.yml` — the gate

Runs on every push to `main` and every pull request: same fetch → typecheck →
test → build pipeline, then asserts `dist/index.html`, `dist/rss.xml`, and
`dist/api/studies.json` exist and parse, and greps `dist/` for leaked contact
addresses. Uploads `dist/` as an inspectable artifact.

Step order matters in both: `fetch:data` runs **before** the typecheck,
because `src/data/` is git-ignored and `index.astro`, `study/[slug].astro`,
and `api/studies.json.ts` all `import` `@/data/snapshot.json` directly.
Without the fetch, the typecheck fails with a module-resolution error that
reads like a code bug and is really a missing build input.

### `.github/workflows/refresh.yml` — the twice-daily pull

Runs at 11:17 and 23:17 UTC (≈ 06:17 / 18:17 America/Chicago; cron does not
follow daylight saving) and on manual dispatch. It fetches, decides whether
the result is publishable, verifies the site still builds from it, commits
`src/data/snapshot.json` and `src/data/diff.json`, and then **dispatches
`deploy-pages.yml`**.

The dispatch is load-bearing: the snapshot commit is pushed with
`GITHUB_TOKEN`, and a `GITHUB_TOKEN` push deliberately does not fire
`on: push` workflows (the same guard that stops the refresh job looping with
`ci.yml`). Pages therefore only picks up new data because the refresh job
explicitly asks for a deploy — which an API call with `GITHUB_TOKEN` *is*
allowed to do (`permissions: actions: write`).

Three refusals are built in, each because of a specific way this could
publish something wrong:

| Condition | What happens | Why |
|---|---|---|
| `fetch:data` fell back to the fixture | Warn; commit nothing | Fixture data would overwrite real data, and the next run's diff would then report dozens of phantom additions and removals. |
| Record count dropped by more than half | Warn; commit nothing | A partial upstream response can parse cleanly. Publishing it would gut the index for twelve hours. Re-run manually if upstream genuinely shrank. |
| Only `fetchedAt` differs | Commit nothing | `snapshot.json` embeds a fetch timestamp, so it is byte-different on every single run. `git diff --quiet` would therefore commit twice a day forever. The check compares `studies` only. |

That last check still catches the passage of time: `isExpired` and
`staleness` are recomputed against the clock, so a posting lapsing overnight
is a real change and does trigger a commit and a deploy even when upstream
sent identical bytes.

Concurrency group `refresh-data`, `cancel-in-progress: false` — cancelling a
run between `git commit` and `git push` is worse than waiting.

**Manual run:** Actions → *Refresh study data* → *Run workflow*. Tick
*Redeploy even if the data did not change* to force a rebuild.

---

## 4. The two public artifacts

### `/studies/rss.xml`

An RSS 2.0 feed of newly listed studies, so the site can be subscribed to
rather than checked. Every item title leads with the money —
`$25/hr - $50 total - Study Name` — because a reader shows the title and
little else. The same five mutually exclusive cases the site's `RateBadge`
enforces apply: `Unpaid`, `Drawing entry only`, `$400 total, rate unknown`,
`Pay unclear`. A raffle prize never appears as a dollar figure in a title.

**Worth knowing if you change it:** the feed is *not* built purely from
`diff.json`, even though `diff.json` is the obvious source. The diff is
ephemeral in a way that fights the deploy model — the deploy build re-fetches
and re-diffs against the snapshot the refresh job committed minutes earlier
and produces an empty diff; and a build from a clean checkout has no committed
snapshot at all, so its diff reports every study as new. A diff-only feed
would swing between 0 and everything depending on which of those happened.

So the feed's spine is `postedDate` (upstream `date_gmt`) — a property of the
study itself, identical on every machine — and `diff.added` is folded in as a
hint. Item `<guid>`s are permalinks, so a reader notifies you exactly once per
study however many times the site rebuilds. Change notices (pay, time, or
expiry edited) appear only when the build had a real baseline, and their guids
are content hashes, so an edit announces itself once.

> Not yet wired: `<link rel="alternate" type="application/rss+xml" …>` in
> `src/layouts/Base.astro`, which is what makes browsers and readers
> auto-discover the feed from the page. That file belongs to the UI layer.

### `/studies/api/studies.json`

The full normalized dataset as one static file: `{ meta, studies }`, where each
entry is `src/types.ts`'s `StudyRecord` plus a `detailUrl`. Same parse, same
`effectiveHourly`, same `isExpired` the site itself renders, with
`compensation.raw` and `duration.raw` carried through verbatim so anyone can
check the numbers against their source text. `meta` carries counts, the
taxonomy term maps, the licence and disclaimer, and four notes covering the
rules a consumer will otherwise get wrong (chiefly: `effectiveHourly: null`
means *unknown*, never zero).

**Contact fields are redacted here.** `contactName`, `contactEmail` and
`contactPhone` are always `null` in this file — the keys stay so the
`StudyRecord` type still describes the payload, but the values are withheld.
The listings carry graduate students' personal addresses, and one downloadable
file containing all of them is precisely the harvest list that
`ContactButton.astro` tokenises the HTML to prevent. Consumers who need a
contact should follow each record's `url` to the official listing.
`api/studies.json.ts` throws at build time if an address reaches the payload,
and all three workflows grep the whole of `dist/` as a backstop, so this
cannot regress silently. `meta.schemaVersion` is `2` as of that change.

**Headers on GitHub Pages.** With `output: 'static'` Astro runs the endpoint
at build time and writes the body to a file; the `Headers` in the `Response`
only take effect under `astro dev` and `astro preview`. In production the
headers are whatever GitHub Pages sends — which happens to be exactly enough:
Pages serves everything with `Access-Control-Allow-Origin: *` (so the dataset
is fetchable from any browser), sets `Content-Type` from the file extension,
and applies its fixed ~10-minute cache, which suits data that changes twice a
day. Pages offers no per-path header config, so nothing further to do — but if
this ever moves hosts, CORS on `/studies/api/studies.json` must be recreated
deliberately or publishing the dataset stops working cross-origin.

---

## 5. Verifying a deploy

```bash
# 1. Locally, honouring `base` - this is what catches subpath mistakes.
npm run build && npm run preview      # -> http://localhost:4321/studies/

# 2. After deploying, in order of what breaks most often:
curl -sI https://harsh.bet/studies/ | head -1                   # 200
curl -s  https://harsh.bet/studies/ | grep -o '/studies/_astro/[^"]*' | head -1
curl -sI "https://harsh.bet$(curl -s https://harsh.bet/studies/ | grep -o '/studies/_astro/[^"]*' | head -1)" | head -1   # 200, not 404

curl -s https://harsh.bet/studies/rss.xml | head -5             # <?xml ...
curl -sI https://harsh.bet/studies/api/studies.json | grep -i access-control
curl -s  https://harsh.bet/studies/api/studies.json | jq '.meta.count, .meta.generatedAt'
```

The second and third commands are the important pair: a 200 on the page plus a
404 on its stylesheet is the signature of a base-path mistake, and it is easy
to miss because the page still "loads".

Then check freshness: `.meta.generatedAt` in the JSON should be within about
twelve hours, and the footer timestamp on the page should agree with it.

## 6. Troubleshooting

| Symptom | Cause |
|---|---|
| Page renders as unstyled HTML | Assets 404. `base` in `astro.config.mjs` no longer matches the repo name, or `dist/` is being served somewhere other than `/studies/`. |
| Everything 404s under `/studies/` | The Pages site is gone or was switched off the *GitHub Actions* build type. Re-run `deploy-pages.yml`; `configure-pages` re-creates it. |
| `Cannot find module '@/data/snapshot.json'` | The build ran `astro build` without `fetch:data`. Use `npm run build`. |
| Every study shows as new in the feed | No committed `snapshot.json`, so the diff had no baseline. Expected on a first deploy; resolves after the first `refresh.yml` run. Feed guids are permalinks, so nobody gets notified twice. |
| Refresh job green but nothing deploys | Verdict was `unchanged` (nothing material moved) or `skip` (fixture fallback / suspicious record count). Check the job summary. |
| Refresh job green but no commit lands | Repo workflow permissions are read-only — see §2. |
| Site shows a stale footer timestamp after a refresh | The `gh workflow run` dispatch step failed, or the dispatched deploy run failed. Check both runs in the Actions tab. |
| `source FIXTURE <-- STALE DATA` in the build log | Upstream was unreachable at build time. The deploy is intentionally still good; the data is as old as the fixture. |
