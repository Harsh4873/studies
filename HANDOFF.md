# Handoff — harsh.bet/studies

A ranked, filterable front-end for Texas A&M's Aggie Research Volunteers registry.
TAMU publishes an open API for these 86 studies but **no browse UI** — the official page
renders empty. This is the front-end that's missing.

## State: green

```
836/836 tests pass ·  tsc --noEmit clean ·  astro check 0/0/0 ·  build 81 pages
86 raw records → 79 after dedupe → 63 live → 48 rankable
0 plaintext email addresses in built output (verified against dist/, not source)
fixture pipeline and shipped snapshot.json agree on all 79 rates, zero mismatches
```

## Setup

```bash
nvm use              # Node 22.22.2 — Astro 7 requires >=22.12
npm install
npm run fetch:data   # pull all 86 studies live from the ARV API
npm run test:run
npm run build
npm run dev
```

A frozen 86-record snapshot lives at `fixtures/arv-snapshot.json`. **Every unit test runs
against it — nothing in the suite touches the network.** `fetch:data` is the only thing
that does.

⚠️ **`npm run fetch:data` after changing any parser.** `src/data/snapshot.json` is a build
artifact; stale data will fail tests that are actually correct.

## What this thing is for

It ranks studies by **effective hourly pay** — the number that tells you $400 for six weeks
of stool samples is a worse deal than $50 for an hour of VR. Everything else is scaffolding
around getting that number right.

Getting it right is hard because every field is free text written by a different grad
student: `"$20/ hr"`, `"20$"`, `"Up to $30 <br>Paid as Amazon gift card"`, `"$50 for the
screening visit and $125 for each study visit (3). Total $425"`.

## Read this file first: `src/lib/__audit__.md`

600+ lines, three rounds of adversarial audit, each written by an agent that authored none
of the code it was checking. It is the most valuable artifact in the repo.

**It caught a bug that 764 passing tests did not.** The ranking was wrong at the top of the
board — 4 of the top 10 materially misreported, every one in the direction that costs the
reader. The unit tests passed because they encoded the same misunderstanding as the code.
Only a row-by-row read of all 86 records against the raw strings found it.

The headline case: `"1 screening visit lasting up to 2 hours followed by 6 study days
lasting up to 7 hours"` parsed to **9 hours**. Truth: `2 + 6×7 = 44`. A $620 study
advertised at **$68.89/hr** that actually pays **$14.09/hr** for six fasted clinic days.

Track record across rounds: **12 wrong rows → 6 → 2.** Round 3 was the cleanest
regression sweep of the three: three rates moved, and all three were meant to.

## Fixed and locked by named regression tests

| ID | was | now |
|---|---|---|
| 9815 | 9h, $68.89/hr | **44h, $14.09/hr** |
| 4611 | 16h, $51.25/hr | **58h, $14.14/hr** |
| 4613 | 9h, $46.67/hr | **27h, $15.56/hr** |
| 8458 | 9h, $47.22/hr | **21h, $20.24/hr** |
| 12766 | $35.00/hr (rank 6) | **$60.00/hr (rank 4)** |
| 8874 | $7.50/hr, `low` | **$15.00/hr, `ok`** |
| 4618 | $64.29/hr | **$21.43/hr** |
| 8872 | $105.00/hr | **unrankable (null)** |
| 11899 | $21.82/hr | **$10.91/hr** (performance bonus isn't guaranteed) |
| 11315 | $60.01/hr | **$60.00/hr** |
| 4607 | "Pay unclear" | **$420** (extracted from body) |
| 8402 | "Pay unclear" | **$15 → $12.00/hr** |

**F11 fixed:** the unrated bucket now orders by guaranteed total descending. The $1,000
study — the largest payout in the corpus, unrankable because 24 weekly visits give no
parseable contact hours — previously sat *below studies with no stated pay at all*. It now
leads that block, followed by $400 and $350. Verified in rendered HTML, not just source.

Also fixed: a regression where `"Participants will earn $30"` rendered as **"Unpaid"** —
"earn" is the most ordinary verb for attendance pay in this genre, and it was zeroing
studies out entirely.

## Known-open, documented not hidden

**Rank 2 is still ~2x high.** `8331` shows **$96.00/hr**; its body says *"Each participant
will complete two sessions"* and the `"40-50 minutes"` duration is almost certainly
per-session, making the real rate **$48–60/hr**. The duration side finds no session count,
the compensation side describes two, and nothing reconciles them. **This is the highest-value
remaining fix** and it's pinned by a deliberately-failing-on-purpose test.

**Rank 10 is 1.06x high.** `8338` shows $30.00/hr; hours are arguably 4.25 not 4, giving
$28.24/hr. Trivial in itself, but it displaces `9953` from rank 10.

Everything else at the top is defensible — ranks 1, 3, 4, 5, 6, 7, 8, 9 all deliver what
the badge promises.

Others, all in `__audit__.md` with evidence:

- **F6** — 14 records rank on an "up to $X" *ceiling*. `9815`'s honest $14.09/hr has a floor
  of one $20 screening visit.
- **F7** — rate ranges and payment ladders rank on the top rung (`$15-25/hour` → $25).
- **F10** — `confidence: 'low'` parses still rank normally. `8331` sits at rank 2 with a
  low-confidence parse behind a green badge.
- **F4 / F17** — duplicate detection is IRB-number based; some twins have different IRB
  numbers, and one dedupe drops the twin advertising $10 *more*.
- **F14** — non-cash perks (Oura ring, glucometer, BP cuff, $20 lunch) are valued at $0.
- **F12** — `"first 400 participants"` caps aren't surfaced.
- **F15** — `8338` hours are 4, arguably 4.25; 6% off.

**Least-tested file:** `src/lib/extract-from-content.ts`. It scans study descriptions for
pay when the compensation field is empty. Conservative by design, but verify before trusting.

## Suggested next steps

1. Fix F9 (rank 2). Reconcile `compensation.visitCount` against `duration.sessionCount`.
2. Surface floor-vs-ceiling in the UI so "up to $620" doesn't read as a promise.
3. Rank-penalise or badge low-confidence parses.
4. **Re-run the audit after any parser change.** Dump all 86 rows and adjudicate by hand.
   This is the step that finds what tests miss.

## Architecture

Build-time fetch → normalize → parse → dedupe → commit JSON → Astro static build. No
database, no runtime backend, no client-side API calls.

The ARV API sends **no `Access-Control-Allow-Origin`**, so browser fetching is impossible by
design. `X-WP-Total: 86`, one page at `per_page=100`.

**Four meta fields aren't strings** — `lifecycle` is a number, `aux_is_internal` a boolean,
`button_link_object` an object, and `expiration_date` is literally `null` on 4 records, so
`.trim()` throws. Types are deliberately tolerant.

**`lifecycle` is not a status field** — it's posting duration in months. Nothing in the API
says whether a study still enrols. Expired postings keep being served with
`status: "publish"`, so expiry is computed, not read.

## Deploy

See `DEPLOY.md`. GitHub Pages project site: pushing to `main` runs
`.github/workflows/deploy-pages.yml`, which tests, builds, and deploys to
<https://harsh.bet/studies/>. `astro.config.mjs` sets `base: '/studies'`. For a
subdomain (`studies.harsh.bet`) instead, change that one line.

`.github/workflows/refresh.yml` re-fetches twice daily, commits only on change,
and dispatches the Pages deploy.
`.github/workflows/ci.yml` gates on typecheck + tests + build — **currently passes.**

## Positioning — keep these

Links out to the canonical `research.tamu.edu/study/<slug>/` page for every study rather
than replacing it. States that parsed figures are best-effort. Carries a "not affiliated
with or endorsed by Texas A&M University" notice. Contact addresses are assembled in JS on
click — they're personal addresses of grad students who never consented to spam harvesting.

Those four things are what keep this clearly an aggregator.
