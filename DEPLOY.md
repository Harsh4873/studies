# Deploying to `harsh.bet/r/studies`

This is a fully static site. There is no server, no database, and no runtime
secret — `npm run build` emits a directory of files and the whole deploy is
"put these files where that URL points".

Everything below exists because of one fact that makes this harder than it
sounds: **the site lives at a subpath, not at a domain root.** That single
detail is responsible for essentially every way this deploy can break.

---

## 1. What the build produces

```
npm run build          # = npm run fetch:data && astro build
```

```
dist/
├── index.html                 the ranked listing
├── about/index.html
├── study/<slug>/index.html    79 detail pages
├── rss.xml                    feed of new listings
├── api/studies.json           the normalized dataset
└── _astro/                    hashed CSS + JS
```

Two properties of this output drive everything else:

| Fact | Consequence |
|---|---|
| `astro.config.mjs` sets `base: '/r/studies'`, so every emitted link and asset URL is absolute and prefixed — e.g. `href="/r/studies/_astro/global.<hash>.css"` | The browser will request `/r/studies/…` **from `harsh.bet`**, no matter where the files physically live. Serving `dist/` at a domain root gives you an unstyled page and a 404 for every asset. |
| `trailingSlash: 'always'` + `build.format: 'directory'` | Internal links all end in `/` and resolve to `index.html`. Configure the host to match, or you get a redirect on every navigation. Bare `/r/studies` (no slash) is **not** a route — the rules in §3 and §5 each handle it explicitly. |

`rss.xml` and `api/studies.json` keep their extensions and are *not* affected
by `trailingSlash` — they are served at exactly those two paths.

### Build requirements

| | |
|---|---|
| Node | ≥ 22.12 (`.nvmrc` pins 22.22.2) |
| Build command | `npm run build` — **not** `astro build`. The `fetch:data` half is what puts `src/data/*.json` on disk, and three modules import those files directly, so a bare `astro build` fails to resolve `@/data/snapshot.json`. |
| Output directory | `dist` |
| Install command | `npm ci` |
| Network at build time | Wanted, not required. `fetch:data` falls back to `fixtures/arv-snapshot.json` and exits 0 if `research.tamu.edu` is unreachable, so a TAMU outage produces a stale deploy rather than a failed one. Check the build log for `source FIXTURE  <-- STALE DATA`. |
| Runtime env vars | **None.** Nothing in the browser bundle reads a secret, and nothing calls an API at runtime — the upstream registry sends no `Access-Control-Allow-Origin`, so all fetching is build-time by necessity. |

---

## 2. Repository setup (do this once)

The two workflows only exist once the project is a Git repo on GitHub:

```bash
git init && git add . && git commit -m "initial" && git branch -M main
gh repo create <owner>/studies-site --private --source . --push
```

Then, in **Settings → Actions → General → Workflow permissions**, select
**Read and write permissions**. `refresh.yml` declares `permissions: contents:
write`, but a workflow can only narrow the repository default, never widen it.
If the repo default is read-only, the refresh job runs green and silently fails
at `git push`.

### Secrets

| Secret | Required? | Used by | What it is |
|---|---|---|---|
| `DEPLOY_HOOK_URL` | Only if the host is **not** connected to the repo | `refresh.yml` | A POST-to-rebuild URL. Vercel: *Project → Settings → Git → Deploy Hooks*. Cloudflare Pages: *Project → Settings → Builds & deployments → Deploy hooks*. |
| `GITHUB_TOKEN` | automatic | `refresh.yml` | Provided by Actions. Nothing to configure. |

If Vercel or Cloudflare Pages is connected to the GitHub repo, skip
`DEPLOY_HOOK_URL` entirely — the data commit that `refresh.yml` pushes is an
ordinary push and the host's GitHub App redeploys on it. (This does not create
a loop with `ci.yml`: a push made with `GITHUB_TOKEN` deliberately does not
trigger `on: push` workflows, while the webhook to third-party apps still
fires.)

### One thing that will look like a bug

`src/data/` is in `.gitignore`, and `refresh.yml` commits into it with
`git add -f`. That is intentional, not an oversight:

- It is ignored because it is **generated** — every build recreates it, and
  keeping it out of ordinary commits stops 240 KB of churn on every PR.
- It is force-committed by the refresh job because `snapshot.json` is also the
  **diff baseline**. `fetch:data` computes "what changed" by comparing against
  the snapshot already on disk. With nothing committed, every run sees an empty
  baseline and reports all 79 studies as newly added.

---

## 3. Option A — Vercel

1. **New Project → import the repo.** Framework preset: Astro.
2. Build command `npm run build`, output directory `dist`, install `npm ci`.
3. Node version: Vercel reads `.nvmrc`. Confirm it resolved to 22.x in the log.
4. Add `vercel.json` at the repo root:

```json
{
  "trailingSlash": true,
  "rewrites": [
    { "source": "/r/studies", "destination": "/index.html" },
    { "source": "/r/studies/:path*", "destination": "/:path*" }
  ],
  "headers": [
    {
      "source": "/api/studies.json",
      "headers": [
        { "key": "Access-Control-Allow-Origin", "value": "*" },
        { "key": "Content-Type", "value": "application/json; charset=utf-8" },
        { "key": "Cache-Control", "value": "public, max-age=600, s-maxage=3600" }
      ]
    },
    {
      "source": "/rss.xml",
      "headers": [
        { "key": "Content-Type", "value": "application/rss+xml; charset=utf-8" },
        { "key": "Cache-Control", "value": "public, max-age=600, s-maxage=3600" }
      ]
    },
    {
      "source": "/_astro/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }
      ]
    }
  ]
}
```

**Why the rewrites.** `dist/index.html` is deployed at the root of the Vercel
deployment, so it answers at `/`. But the HTML inside it asks for
`/r/studies/_astro/…`, and whatever fronts `harsh.bet` will forward requests
that still carry the `/r/studies` prefix. The two rewrite rules make the
deployment answer at *both* paths, which means the same deployment works when
you hit the `*.vercel.app` URL directly and when it is proxied under the real
subpath. Without them you get a page that renders as unstyled HTML — the
classic symptom of a base-path mismatch.

`_astro/` filenames are content-hashed, hence the one-year immutable cache. Do
**not** cache `index.html`, `rss.xml`, or `api/studies.json` that aggressively:
their URLs are stable while their contents change twice a day.

---

## 4. Option B — Cloudflare Pages

1. **Workers & Pages → Create → Pages → Connect to Git.**
2. Build command `npm run build`, output directory `dist`.
3. Add an environment variable `NODE_VERSION = 22.22.2` — Pages does not read
   `.nvmrc` reliably and its default Node is too old for this project.
4. Cloudflare Pages takes routing and header config from two files that must
   end up at the **root of `dist/`**. Astro copies `public/` to the output root
   verbatim (public files are *not* moved under `base`), so create them there:

`public/_redirects`

```
# Serve the subpath from the same deployment as the root.
# 200 = rewrite (serve this content), not a redirect - the browser URL keeps
# the /r/studies prefix, which is what the emitted HTML expects.
/r/studies/*  /:splat  200
```

`public/_headers`

```
/api/studies.json
  Access-Control-Allow-Origin: *
  Content-Type: application/json; charset=utf-8
  Cache-Control: public, max-age=600

/rss.xml
  Content-Type: application/rss+xml; charset=utf-8
  Cache-Control: public, max-age=600

/_astro/*
  Cache-Control: public, max-age=31536000, immutable
```

If `harsh.bet` proxies with the prefix intact, add the prefixed variants too
(`/r/studies/api/studies.json`, `/r/studies/rss.xml`) — `_headers` matches on
the request path, not on the file that ends up being served.

Cloudflare Pages defaults to redirecting `/foo` → `/foo/`, which already
matches `trailingSlash: 'always'`. Leave it alone.

---

## 5. Pointing `harsh.bet/r/studies` at the deployment

The contract to hold onto, whatever fronts the apex:

> The HTML contains absolute paths beginning `/r/studies/`. The browser
> therefore requests `https://harsh.bet/r/studies/…`. The **only** open
> question is what the edge does with that prefix on the way to the files.

Prefer a **rewrite / reverse proxy**, not a redirect. A 301 to another hostname
changes the address bar, splits the origin, and breaks the canonical URLs and
the feed's self-link.

### If the apex is on Vercel

In the **apex** project's `vercel.json` (the site that owns `harsh.bet`):

```json
{
  "rewrites": [
    { "source": "/r/studies", "destination": "https://studies-site.vercel.app/r/studies" },
    { "source": "/r/studies/:path*", "destination": "https://studies-site.vercel.app/r/studies/:path*" }
  ]
}
```

The prefix is preserved on both sides, and the studies project's own rewrites
(§3) resolve it to the right file.

### If the apex is on Cloudflare (DNS proxied, orange cloud)

Add a Worker on the route `harsh.bet/r/studies*`:

```js
export default {
  async fetch(request) {
    const url = new URL(request.url);
    // Keep the path exactly as-is; only the origin changes.
    url.hostname = 'studies-site.pages.dev';
    return fetch(new Request(url, request));
  },
};
```

Alternatively, if the studies project is itself a Pages project on the same
Cloudflare account, skip the Worker: give it the custom domain `harsh.bet`
only if nothing else owns the apex. Otherwise the Worker is the clean answer.

### If the apex is on nginx

```nginx
location /r/studies/ {
    proxy_pass         https://studies-site.pages.dev/r/studies/;
    proxy_set_header   Host studies-site.pages.dev;
    proxy_ssl_server_name on;
}
location = /r/studies {
    return 308 /r/studies/;
}
```

### If the apex is on Netlify

`_redirects` on the apex site:

```
/r/studies/*  https://studies-site.pages.dev/r/studies/:splat  200
```

### If your edge strips the prefix

Some proxies forward `/r/studies/foo` upstream as `/foo`. That is fine and it
is exactly what the Vercel/Pages rules in §3–§4 already handle — those rules
make the deployment answer on both the bare and prefixed forms. What must
*never* change is `base` in `astro.config.mjs`: the prefix in the emitted HTML
is what the browser uses, and it has to keep matching the public URL.

### Serving the files directly (no proxy)

If `harsh.bet` is a plain static host you control, the simplest correct answer
is to skip all rewrites and copy the build into the matching directory:

```bash
rsync -a --delete dist/ /var/www/harsh.bet/r/studies/
```

The directory structure then *is* the URL structure and nothing needs
rewriting. This is the least breakable option available.

---

## 6. Automation

Two workflows, doing two different jobs.

### `.github/workflows/ci.yml` — the gate

Runs on every push to `main` and every pull request: `npm ci` →
`fetch:data` → typecheck (`astro check` + `tsc --noEmit`) → `vitest run` →
`astro build` → assert `dist/index.html`, `dist/rss.xml`, and
`dist/api/studies.json` exist and parse. Uploads `dist/` as an artifact.

Step order matters: `fetch:data` runs **before** the typecheck, because
`src/data/` is git-ignored and `index.astro`, `study/[slug].astro`, and
`api/studies.json.ts` all `import` `@/data/snapshot.json` directly. Without the
fetch, the typecheck fails with a module-resolution error that reads like a
code bug and is really a missing build input.

The fetch step itself is not a gate — it falls back to the fixture — but a
follow-up step fails the run if that still left no usable snapshot.

### `.github/workflows/refresh.yml` — the twice-daily pull

Runs at 11:17 and 23:17 UTC (≈ 06:17 / 18:17 America/Chicago; cron does not
follow daylight saving) and on manual dispatch. It fetches, decides whether the
result is publishable, verifies the site still builds from it, commits
`src/data/snapshot.json` and `src/data/diff.json`, and triggers a deploy.

Three refusals are built in, and each one exists because of a specific way this
could publish something wrong:

| Condition | What happens | Why |
|---|---|---|
| `fetch:data` fell back to the fixture | Warn; commit nothing | Fixture data would overwrite real data, and the next run's diff would then report dozens of phantom additions and removals. |
| Record count dropped by more than half | Warn; commit nothing | A partial upstream response can parse cleanly. Publishing it would gut the index for twelve hours. Re-run manually if upstream genuinely shrank. |
| Only `fetchedAt` differs | Commit nothing | `snapshot.json` embeds a fetch timestamp, so it is byte-different on every single run. `git diff --quiet` would therefore commit twice a day forever. The check compares `studies` only. |

That last check still catches the passage of time: `isExpired` and `staleness`
are recomputed against the clock, so a posting lapsing overnight is a real
change and does trigger a commit and a deploy even when upstream sent identical
bytes.

Concurrency group `refresh-data`, `cancel-in-progress: false` — cancelling a
run between `git commit` and `git push` is worse than waiting.

**Manual run:** Actions → *Refresh study data* → *Run workflow*. Tick
*Redeploy even if the data did not change* to force a rebuild.

---

## 7. The two new public artifacts

### `/r/studies/rss.xml`

An RSS 2.0 feed of newly listed studies, so the site can be subscribed to
rather than checked. Every item title leads with the money —
`$25/hr - $50 total - Study Name` — because a reader shows the title and
little else. The same five mutually exclusive cases the site's `RateBadge`
enforces apply: `Unpaid`, `Drawing entry only`, `$400 total, rate unknown`,
`Pay unclear`. A raffle prize never appears as a dollar figure in a title.

**Worth knowing if you change it:** the feed is *not* built purely from
`diff.json`, even though `diff.json` is the obvious source. The diff is
ephemeral in a way that fights the deploy model — `npm run build` re-runs
`fetch:data`, which re-diffs against the snapshot the refresh job committed
minutes earlier and produces an empty diff; and a host building from a clean
checkout has no committed snapshot at all, so its diff reports all 79 studies
as new. A diff-only feed would swing between 0 and 79 items depending on which
of those happened.

So the feed's spine is `postedDate` (upstream `date_gmt`) — a property of the
study itself, identical on every machine — and `diff.added` is folded in as a
hint. Item `<guid>`s are permalinks, so a reader notifies you exactly once per
study however many times the site rebuilds. Change notices (pay, time, or
expiry edited) appear only when the build had a real baseline, and their guids
are content hashes, so an edit announces itself once.

> Not yet wired: `<link rel="alternate" type="application/rss+xml" …>` in
> `src/layouts/Base.astro`, which is what makes browsers and readers
> auto-discover the feed from the page. That file belongs to the UI layer.

### `/r/studies/api/studies.json`

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
and both workflows grep the whole of `dist/` as a backstop, so this cannot
regress silently. `meta.schemaVersion` is `2` as of that change.

**This is why §3 and §4 set headers.** With `output: 'static'` Astro runs the
endpoint at build time and writes the body to a file; the `Headers` in the
`Response` only take effect under `astro dev` and `astro preview`. In
production the `Access-Control-Allow-Origin: *` that makes the dataset usable
from a browser has to come from the host. Skip that config and the file still
serves — it just cannot be fetched cross-origin, which defeats the point of
publishing it.

---

## 8. Verifying a deploy

```bash
# 1. Locally, honouring `base` - this is what catches subpath mistakes.
npm run build && npm run preview      # -> http://localhost:4321/r/studies/

# 2. After deploying, in order of what breaks most often:
curl -sI https://harsh.bet/r/studies/ | head -1                   # 200
curl -s  https://harsh.bet/r/studies/ | grep -o '/r/studies/_astro/[^"]*' | head -1
curl -sI "https://harsh.bet$(curl -s https://harsh.bet/r/studies/ | grep -o '/r/studies/_astro/[^"]*' | head -1)" | head -1   # 200, not 404

curl -s https://harsh.bet/r/studies/rss.xml | head -5             # <?xml ...
curl -sI https://harsh.bet/r/studies/api/studies.json | grep -i access-control
curl -s  https://harsh.bet/r/studies/api/studies.json | jq '.meta.count, .meta.generatedAt'
curl -sI https://harsh.bet/r/studies/study/aperiodic-slope-and-mri/ | head -1   # 200
```

The second and third commands are the important pair: a 200 on the page plus a
404 on its stylesheet is the signature of a base-path or rewrite mistake, and
it is easy to miss because the page still "loads".

Then check freshness: `.meta.generatedAt` in the JSON should be within about
twelve hours, and the footer timestamp on the page should agree with it.

## 9. Troubleshooting

| Symptom | Cause |
|---|---|
| Page renders as unstyled HTML | Assets 404. `dist/` is being served at a root instead of under `/r/studies/`, or the rewrite in §3/§4 is missing. |
| `Cannot find module '@/data/snapshot.json'` | The build ran `astro build` without `fetch:data`. Use `npm run build`. |
| Every study shows as new in the feed | No committed `snapshot.json`, so the diff had no baseline. Expected on a first deploy; resolves after the first `refresh.yml` run. Feed guids are permalinks, so nobody gets notified twice. |
| Refresh job green but nothing deploys | Verdict was `unchanged` (nothing material moved) or `skip` (fixture fallback / suspicious record count). Check the job summary. |
| Refresh job green but no commit lands | Repo workflow permissions are read-only — see §2. |
| Site shows a stale footer timestamp after a refresh | The host is not connected to the repo and `DEPLOY_HOOK_URL` is unset. |
| `source FIXTURE <-- STALE DATA` in the build log | Upstream was unreachable at build time. The deploy is intentionally still good; the data is as old as the fixture. |
