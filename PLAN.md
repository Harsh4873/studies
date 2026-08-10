# harsh.bet/studies — Build Plan

A ranked, filterable front-end for Texas A&M's paid research study registry.

Every technical claim below was verified against the live API, not assumed. Where a
design decision is non-obvious, the reason is included, because most of them only
became obvious after getting them wrong once.

---

## 1. Why this is worth building

TAMU runs **Aggie Research Volunteers** — an IRB-stamped registry of studies recruiting
paid participants. The public browse page at `research.tamu.edu/arv/` renders **empty**.
There is no search, no filter, no listing, no RSS. The only way a student finds these
studies today is a lab emailing them directly.

The data is all there and completely open. There is just no front-end. That's the gap.

**Scope of the corpus:** 86 studies. Not huge, which is good news — it means no database,
no pagination, no search infrastructure. The whole dataset fits in a JSON file you can
commit to git.

---

## 2. Verified API facts

```
GET https://research.tamu.edu/wp-json/wp/v2/study?per_page=100
```

| Fact | Value | Consequence |
|---|---|---|
| `X-WP-Total` | 86 | Entire corpus is one request |
| `X-WP-TotalPages` | 1 | No pagination needed *today* — still handle it |
| `Access-Control-Allow-Origin` | **absent** | Browser fetch is impossible. Server-side only. |
| Auth | none | No keys, no secrets, no rate-limit headers observed |
| ID range | 4591–12780 | Non-sequential; don't infer recency from ID |

Taxonomy endpoints exist and give you filter facets for free:
`/wp-json/wp/v2/aux_study_topic` (6 terms), `aux_study_category` (16),
`aux_study_location` (10), `aux_study_session_type` (6).

### Exact meta keys

Verified against all 86 records, with non-empty counts:

| Key | Non-empty | Type — **read this column** |
|---|---|---|
| `aux_study_item_compensation` | 77/86 | string, contains literal `<br>` `<u>` HTML |
| `aux_study_item_duration` | 83/86 | string, free text |
| `aux_study_item_contact_email` | 86/86 | string |
| `aux_study_item_contact_name` | 86/86 | string |
| `aux_study_item_contact_phone_number` | 39/86 | string, inconsistent format |
| `aux_study_item_pi_name` | 85/86 | string, often prefixed `"PI: "` |
| `aux_study_item_irb_number` | 86/86 | string |
| `aux_study_item_irb_approval_date` | 86/86 | ISO-ish, **no timezone** |
| `aux_study_item_minimum_age` | 86/86 | integer-as-string |
| `aux_study_item_maximum_age` | 86/86 | integer-as-string |
| `aux_study_item_expiration_date` | 16/86 | string, `''`, **or literal `null`** |
| `aux_study_item_recruitment_start_date` | 16/86 | string or `''` |
| `aux_study_item_lifecycle` | 86/86 | **number** `3\|6\|12` |
| `aux_study_item_button_link_object` | 86/86 | **object** `{url}`, url empty on all 86 |
| `aux_is_internal` | 86/86 | **boolean** |

**Four of these are not strings.** `.trim()` on `expiration_date` throws on 4 records
(ids 8903, 6750, 6747, 5701). Type your schema tolerantly and normalize defensively.

### Three findings that shape the whole product

**`lifecycle` is not a status field.** It's the posting duration in months (3/6/12).
Nothing in the entire API says whether a study is still enrolling. That question is
unanswerable from data — the site can only surface staleness, never resolve it.

**Expired postings are still served.** 16 records carry an `expiration_date` and many
are in the past (2025-01-02, 2025-04-02, 2025-10-02, 2026-01-28). `status` is `"publish"`
on all of them. If you don't compute expiry yourself, you will show dead listings as live.

**Age sentinels.** `maximum_age` of `100` (25 records) and `125` (2 records) mean "no
upper bound," not literally 100. And `minimum_age` goes as low as `2` — the corpus
includes child studies, so an "18+" assumption is unsafe.

---

## 3. Architecture

Static-first. A build-time fetch, a committed JSON snapshot, zero runtime backend.

```
GitHub Action (2x daily)
  └─ npm run fetch:data
       ├─ fetch all 86 records server-side
       ├─ normalize + parse + dedupe
       ├─ diff against previous snapshot
       └─ write src/data/{snapshot,diff}.json
  └─ commit if changed → triggers deploy

Astro static build
  └─ dist/  → index, /study/<slug> per study, /about, /rss.xml, /api/studies.json
```

**Stack:** Astro (static) + TypeScript strict + Vitest + Tailwind.

**Two version traps** found the hard way: `@astrojs/tailwind` peers on Astro ≤5 and
Tailwind 3 — with Astro 7 + Tailwind 4 you must wire Tailwind through
`@tailwindcss/vite` instead. And `@astrojs/check` peers TypeScript `^5||^6`, so
TypeScript 7 breaks `astro check` even though it's published.

**Base path:** the site lives at a subpath, so `base: '/studies'` in `astro.config.mjs`,
and every internal link and asset must respect it. This is the single most common way a
subpath deploy silently ships broken.

**Fetch resilience:** retry with backoff, and on total failure fall back to the committed
fixture rather than shipping an empty site. A stale site beats a broken deploy.

---

## 4. The hard part: parsing money

This is 80% of the real work and the entire value of the product. Everything else is
CRUD.

Compensation is free text written by a different grad student each time. Real examples
from the live data:

```
"$400.00"                    "20$"                    "$20/ hr"   (stray space)
"Up to $30 <br>Paid as Amazon gift card"
"60 gift card to Amazon AND entered into a raffle for one of two $50 Amazon gift card"
"$50 for the screening visit and $125 for each study visit (3). Total $425 compensation"
"Participants will be compensated $20 per visit ... completion bonus of $500 ... totally $1000"
"Participants can elect to be entered into a drawing for one of three $10 Amazon gift cards"
```

### Four semantic rules that matter more than the regexes

**1. Raffle money is not guaranteed money.** A "$100 drawing" must never rank above a
guaranteed $50. Track `guaranteedMin/Max` and `raffleMax` separately. 14 records carry
raffle amounts.

**2. Contingent money is not guaranteed money either.** Distinguish a *completion* bonus
(reasonably yours if you finish) from a *performance* bonus (you might not earn it).
Conflating them inflated one study 2x.

**3. Calendar span is not contact hours.** `"Approximately 6 weeks"` is not 1,008 hours.
When a duration gives only a span, contact hours must be `null` — never derived. This
distinction is *the reason the site exists*: it's what separates "$400 for six weeks of
stool samples" from "$50 for one hour of VR."

**4. Prefer a stated total over summing parts.** Summing double-counts when the listing
gives both. Verified clean across all 11 records that state a total.

### The bug that broke the product

Duration strings like:

```
"1 screening visit lasting up to 2 hours followed by 6 study days lasting up to 7 hours"
```

parse naively to **9 hours**. The truth is **2 + (6 × 7) = 44 hours**. A $620 study
displayed at **$68.89/hr** when it's actually **$14.09/hr**.

Five records hit this, inflating rates 2.3x–4.9x — and because inflated rates sort to the
top, **all five landed in the top 10**. An audit of the shipped ranking found 4 of the
top 10 materially wrong, every one in the direction that costs the reader.

The fix: recognise `<count> <visit-noun> ... <duration>` as distributive even without the
word "each." The corroborating evidence is in a *different field* — the compensation text
`"$20 + 6 × $100 = $620"` only closes at six study days. **Cross-field validation is
mandatory, not a nicety.**

Guard against over-correcting: `"2 hours (in the form of two 1-hour visits)"` states a
total and must stay 2h, not become 4h.

### Invisible money

Some coordinators put pay in the description instead of the compensation field. One
$420 six-visit study renders as "Pay unclear" despite its body itemising every payment.
Another pasted a movie-ticket perk into the *duration* field.

Build a conservative fallback that scans `content.rendered` **only** when the meta field
is empty, caps confidence at medium, and tags the provenance visibly. Extracting nothing
beats extracting a wrong number. Roughly $2,425 of guaranteed pay is currently invisible
without this.

### Derived model

```
effectiveHourly = explicit hourly rate, else guaranteedMax / totalHoursMax, else null
```

Never `0`, never `Infinity`, never `NaN`. `null` means unknown, and unknown studies get
their own clearly-labelled section **below** the ranked ones — never interleaved, never
silently sorted as zero. Within the unknown bucket, order by guaranteed total, or the
$1,000 study sinks below studies paying nothing.

### Eligibility

Parse `content.rendered` into structured flags: `requiresRightHanded`, `requiresMriSafe`,
`requiresFasting`, `excludesCardiovascular`, `excludesPregnancy`, `excludesSeizure`,
`requiresSpecificCondition`, `sexRestriction`.

**Be conservative.** Return `ineligible` only on a hard conflict; return `unknown`
whenever the profile lacks a field the study cares about. A false "you're eligible" wastes
someone's trip; a false "check with the lab" costs nothing. Frame every output as a
filtering hint, never a medical or official determination.

### Deduplication

The registry contains genuine duplicate postings — same IRB number, near-identical title,
different ID (e.g. 11896 and 11324). Collapse on IRB number, keep the most recently
modified, retain dropped IDs. 86 records → 79 after dedupe → 63 live → 48 rankable.

---

## 5. Testing strategy

The audit is what made this project honest, so treat verification as a first-class
deliverable rather than a phase-5 afterthought.

**Fixture-driven, never networked.** Commit a full 86-record snapshot. Unit tests hit
disk, so they're deterministic and run offline.

**Table-driven over every distinct real string.** Enumerate the distinct values of each
messy field from the fixture and assert an explicit expectation for each. This is where
the bugs actually live.

**Invariant sweeps over all 86 records.** No NaN, no Infinity, no negatives,
`guaranteedMin ≤ guaranteedMax`, raffle never in guaranteed, nulls always sink in sort.

**A golden top-10 ranking test.** Assert the exact expected order. This is the test that
catches a parser change silently reshuffling the board — the highest-value test in the
suite, and the one nobody thinks to write.

**Named regression tests by study ID**, with the raw string in a comment and the corrected
number. `9815 = 44h`, `4611 = 58h`, `11315 = $60.00 exactly, not $60.01`.

**Adversarial audit as a real step.** Have something that didn't write the parsers dump all
86 rows — raw string, parsed output, computed rate — and adjudicate each by hand against
the source text. Nothing else found the ranking bug. Unit tests all passed while the top
of the board was wrong, because the tests encoded the same misunderstanding as the code.

**Deterministic time.** Inject "now" into staleness logic or the tests rot.

---

## 6. Product surface

**Listing** — mobile-first, default sort by effective hourly descending, unknown-rate
section below. Each card: title, headline rate, total pay, humanised time commitment
("4 sessions, ~5h over 6 weeks"), age range, eligibility chips, staleness badge, canonical
link.

**Honesty requirements, non-negotiable:**
- Raffle-only pay must be visually distinct from guaranteed pay
- Expired postings dimmed, badged, behind a default-off toggle — *shown, not deleted*,
  since a lapsed posting is often still worth an email
- Source text disclosure on detail pages so users can audit the parser themselves

**Profile** — localStorage only, never transmitted, with an explicit "prefer not to say"
on every field. Powers a "hide what I'm ineligible for" filter.

**Mailto templates** — prefilled inquiry per study including the IRB number and an explicit
"are you still recruiting?" question. If the profile declares a condition the study screens
for, the generated body **discloses it**. Never optimise the draft for acceptance odds by
hiding a health condition.

**Email protection** — contacts are personal addresses of grad students who never consented
to spam harvesting. Assemble in JS on reveal; verify no plaintext address survives in
built HTML.

**RSS of newly-added studies** — replaces polling with a subscription.

---

## 7. Ops

- **CI:** typecheck + vitest + build on every push. Gate merges on it.
- **Refresh:** scheduled Action twice daily → fetch → commit only if changed → deploy.
  Concurrency guard. Must not fail when upstream is briefly down.
- **Static outputs:** `/rss.xml` and `/api/studies.json` so the normalized data is reusable
  by anyone else who wants it.

---

## 8. Etiquette and positioning

- Descriptive User-Agent with a contact URL. You're a guest on a university server.
- Cache hard; never fetch from the client.
- **Link out, don't replace.** Summarize and link to the canonical
  `research.tamu.edu/study/` page rather than republishing full descriptions.
- Prominent "not affiliated with or endorsed by Texas A&M University."
- State that parsed figures are best-effort and the canonical page is authoritative.

That framing keeps you clearly an aggregator. If the Division of Research ever emails you,
it's the difference between "nice, thanks" and "take it down."

---

## 9. Sequencing

| Phase | Work | Notes |
|---|---|---|
| 0 | Scaffold, types, fixture capture | Types are the contract; get them right first |
| 1 | Compensation + duration parsers | The actual product. Budget most of your time here |
| 2 | Eligibility, staleness, dedupe, diff | |
| 3 | Test suites + golden ranking test | Concurrent with 1–2, not after |
| 4 | Listing UI + filters | |
| 5 | Profile, detail pages, mailto | |
| 6 | CI, cron, RSS, deploy | |
| 7 | **Adversarial audit + fix round** | Not optional. This is where correctness happens |

Phases 1 and 7 are the project. Everything else is scaffolding around them.

---

## 10. Future

- Fold in lab pages that never file ARV postings — Anderson, Mathur, the Peterson HCI labs.
  That's where Dream Lab–type CS studies surface *first*, and it's the long tail ARV misses.
- Notify on new studies matching a saved profile.
- Generalise: every university with a WordPress-based IRB registry has this same gap.
