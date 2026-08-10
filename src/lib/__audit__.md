# Adversarial correctness audit — where the money numbers lie

**Scope:** all 86 records in `fixtures/arv-snapshot.json`, run through the real
pipeline (`normalizeAndDedupe` → `parseCompensation` / `parseDuration` →
`computeEffectiveHourly` → `sortStudies`), then read row-by-row against the raw
`aux_study_item_compensation` / `aux_study_item_duration` strings **and** against
`content.rendered`, which the pipeline never reads but a human reader will.

**Source state audited** (files changed under me mid-audit; these are the hashes
the findings below were reproduced against):

| file | md5 |
|---|---|
| `parse-compensation.ts` | `70e05eecb0fac08da0a6eaf9d77480f5` |
| `parse-duration.ts` | `09bf2b5b8c57477d7ac711484ee7bacc` |
| `effective-rate.ts` | `581e53c260268efe62b2ecdfafba2382` |
| `normalize.ts` | `c64a384821729f736273ee6b6ac01fab` |

Note: an earlier revision of `parse-compensation.ts` mapped `''` → `$0/$0` at
`confidence: 'high'`. That is **fixed** in the audited revision (blank now yields
`null`/`low`/`"no compensation stated in the listing"`). Everything else in this
document was byte-identical across both revisions.

Nothing was fixed. This file is the only file added.

---

## The short version

86 records → 79 after dedupe → 63 live → **48 ranked**.

**19 rows are materially wrong about money.** They are not randomly distributed:
they cluster at the top of the board. **Four of the ten highest-ranked live
studies are overstated by 2.3x to 4.9x**, and the single biggest *understatement*
sits at rank 10 when it belongs at rank 2. The core promise — "the top of this
list is the best real deal" — does not hold.

No raffle money leaks into guaranteed pay (question 2 is clean). No explicit
total is double-counted with its parts (question 4 is clean). The damage is
concentrated in two places: **unit mismatches between the pay numerator and the
hours denominator**, and **duration undercounting on multi-visit studies whose
own compensation text proves the visit count**.

---

## Answers to the six questions

### 2. Is any raffle money leaking into guaranteed pay?

**No.** Verified across all 14 records carrying a `raffleMax`. In every case the
raffle amount is excluded from `guaranteedMin/Max` and from `effectiveHourly`:

| id | raffle | guaranteed | correct? |
|---|---|---|---|
| 11075 | $50 | $10 | yes — "$10 gift card **and** three entries" split correctly |
| 8898 / 6753 | $100 | $10 | yes |
| 8331 | $200 | $80 | yes — and the $200 is the single largest prize, not the $1,000 pool |
| 6987 | $50 | $60 | yes |
| 6969 | $100 | $5 | yes — caught with no "drawing" word present ("1 of 5 $100") |
| 8417, 6978 | $50 / $10 | $0, `raffleOnly` | yes |
| 6745, 4626, 4624 | $10 | ceiling $165 | direction is safe (see F13) |

There is, however, a **mirror-image leak in the other direction** — contingent,
non-raffle money counted *as* guaranteed. See F8 (#11899) and F14.

### 4. Are explicit totals being double-counted with their component parts?

**No.** Every record that states a total uses it *instead of* the sum, and I
checked the arithmetic on each one:

`8458` $50+3×$125=$425 ✓ · `5436` $50×2=$100 ✓ · `6995` $20×2+$20=$60 ✓ ·
`9821` $150×3+$100=$550 ✓ · `4642` $50+$75+$100=$225 ✓ · `8331` $30+$50=$80 ✓ ·
`9815` $20+6×$100=$620 ✓ · `4613` $20+4×$100=$420 ✓ · `4611` $20+4×$200=$820 ✓ ·
`11321/8876` 24×$20+$500=$980≈"$1000" ✓ · `4593` ceiling only ✓

The three summed-without-a-total records (`8872` 20+20+100, `6950` 5+10,
`4634` 10+20) are sums of genuinely distinct components, not of a total and its
parts. The "restatement dedup" fix on `11075` works.

**One anomaly, unflagged:** `8338`'s own text is internally inconsistent —
"$20 … $35 … $30 … $45" sums to **$130**, but the same sentence says "The total
compensation for completing all four sessions is **$120**." The parser silently
takes $120. That is the defensible choice, but the contradiction should surface
as a note; right now the reader has no idea the listing disagrees with itself.

### 3. Absurd effective rates

Nothing exceeds $200/hr (max is $137.50). Below $2/hr:

| id | rate | verdict |
|---|---|---|
| 11072 | **$1.67** | **Correct, and the site is right to say so.** "$30 e-gift card" against "Total time … approximately 18 hours" of creative workshops. Confirmed against `content.rendered`. This genuinely is a $1.67/hr study. |
| 6976, 6974, 6971 | **$0.00** | Correct. All three literally say "None". |

The *interesting* absurdities are the ones that sit just under the $200 tripwire
and therefore escape a naive threshold check. Ranked by how badly they mislead:

| id | shown | defensible | ratio | why |
|---|---|---|---|---|
| 9815 | $68.89 | **$14.09** | **4.9x** | 6 study days × 7h counted as one 7h day |
| 4611 | $51.25 | **$14.14** | **3.6x** | 4 study days × 14h counted as 14h total |
| 6987 | $40.00 | **$12.00** | **3.3x** | 5 appointments counted as one |
| 4613 | $46.67 | **$15.56** | **3.0x** | 4 study days × 6h counted as one |
| 4618 | $64.29 | **$23.08** | **2.8x** | $225-over-3-visits ÷ *one* visit's hours |
| 8458 | $47.22 | **$20.24** | **2.3x** | 3 study visits × 6h counted as one |
| 8872 | $105.00 | **unrankable** | — | 9 days of daily data collection paid $100, zero of it in the denominator |
| 8331 | $96.00 | **$53.33–$96** | up to 1.8x | "two sessions" (per the body); "40-50 minutes" is almost certainly per session |
| 11899 | $21.82 | **$10.91** guaranteed | 2.0x | ceiling includes a performance bonus |
| 12766 | $35.00 | **$60.00** | 0.58x | **understated** — one visit's pay ÷ both visits' hours |
| 8874 | $7.50 | **$15.00** | 0.50x | **understated** — same bug, and it drops the study into the `low` bucket |
| 11315 | $60.01 | $60.00 | — | rounding artefact (see F16) |

### 5. Does the top-10 ranking reflect the best real deals?

**No. Plainly: the ranking is wrong where it matters most, and the product
promise is broken at the top of the board.**

Live ranked top 10 as shipped, versus what a careful reader gets from the raw
strings:

| rank | id | shown | defensible | verdict |
|---|---|---|---|---|
| 1 | 9821 | $137.50 | $137.50 (floor $112.50) | ✅ correct, genuinely the best deal |
| 2 | 8872 | $105.00 | unrankable | ❌ should not be ranked at all |
| 3 | 8331 | $96.00 | $53.33 | ⚠️ ~1.8x high |
| 4 | 9815 | $68.89 | $14.09 | ❌ **4.9x high** |
| 5 | 11315 | $60.01 | $60.00 | ✅ |
| 6 | 8458 | $47.22 | $20.24 | ❌ **2.3x high** |
| 7 | 9957 | $45.00 | $45.00 | ✅ |
| 8 | 10126 | $40.00 | $40.00 | ✅ |
| 9 | 6987 | $40.00 | $12.00 | ❌ **3.3x high** |
| 10 | 12766 | $35.00 | $60.00 | ❌ understated; belongs at rank 2–3 |

Six of ten are right. Four are wrong, **all four in the direction that costs the
reader** (three inflated, one deflated so it is buried). A corrected top 10 would
be `9821, 11315, 12766, 8331, 9957, 10126, 8408, 8399, 9953, 6960` — it drops
`8872`, `9815`, `8458`, `6987` entirely and promotes four studies currently at
ranks 11–15.

Concretely, a reader who trusts this page signs up for **#9815 expecting
$68.89/hr** and discovers a commitment of one 2-hour screening plus **six fasted
7-hour clinic days — 44 hours for $620, i.e. $14.09/hr**, worse than 30 of the
studies ranked below it. That is the exact failure mode the site exists to
prevent, reproduced at rank 4.

### 6. Wasted trips and missed good studies

**Would waste a trip (rate inflated ≥2x):** `9815`, `4611`, `4613`, `8458`,
`6987`, `4618`, `8872`, `11899`, and marginally `8331`, `7660`, `4632`.

**Would be skipped despite being good:**

- **#4607 (LEAP)** — compensation meta is `''`, so the card renders **"Pay
  unclear"** with the note *"no compensation stated in the listing."* The body of
  the same record says: *"Each family will receive **$420** for participation in
  all six visits … $80 initial, $40 6-month, $90 1-year, $50 18-month, $100
  2-year, $60 30-month."* A fully itemised $420 study is presented as having no
  stated pay.
- **#8402** — same shape. Body: *"Parents schedule a 75-minute appointment and
  receive a **$15 Amazon e-gift card**."* Duration parses to 1.25h, so the site
  has everything it needs to print $12/hr. It prints "Pay unclear."
- **#10128** — body: *"participants receive a small gift of a movie ticket
  (Cinemark)."* The coordinator pasted that string into the **duration** field.
  Site shows no pay and no duration.
- **#11321 / #8876** — `$1,000` guaranteed, the largest payout in the entire
  corpus, 24 weekly visits. `spanWeeks: 26`, `totalHours: null` → unranked, sunk
  below every $0/hr study. At a plausible 1h/visit this is ~$40/hr, top-five
  material.
- **#12775** ($400), **#8404** ($350), **#6953** ($150 + glucometer + scale),
  **#4630** ($150 + BP cuff + scale), **#8333** (up to $150), **#4642** ($225) —
  all correctly unranked under the "span is never hours" stance, but that stance
  means **$2,425 of guaranteed money is invisible to the ranking**.
- **#8874** — shown at $7.50/hr, `low` bucket. Truth: $30/visit × 2 visits ÷ 4h =
  **$15/hr**, `ok` bucket. A reader filtering out `low` never sees it.
- **#12766** — shown at $35/hr when it is $60/hr.

---

## Findings, ranked by user impact

### F1 — Multi-visit durations are not multiplied even when the compensation text proves the visit count (5 records, up to 4.9x overstatement)

`parse-duration.ts` multiplies a per-session duration by a count only on explicit
distributive evidence (`each`, `per X`, attributive `two 2-hour sessions`). Four
CTRAL nutrition studies and one nutrition-intervention study use a template that
never says "each":

| id | duration string | parsed | true | shown | true |
|---|---|---|---|---|---|
| 9815 | `1 screening visit lasting up to 2 hours followed by 6 study days lasting up to 7 hours` | 9h | **44h** | $68.89 | **$14.09** |
| 4611 | `1 screening visit ~ 2hours 4 study visits ~14 hours` | 16h | **58h** | $51.25 | **$14.14** |
| 4613 | `1 screening visit (~3 hours) and a maximum of 4 study visits (~6 hours)` | 9h | **27h** | $46.67 | **$15.56** |
| 8458 | `1 screening visit (~3 hours) 3 study visit (~6 hours)` | 9h | **21h** | $47.22 | **$20.24** |
| 6987 | `30 minute pre-study …; three Neurotracker sessions at each appointment (0, 1, 4, 7, and 14), lasting approximately 1 hour` | 1.5h | **5h** | $40.00 | **$12.00** |

The "genuinely ambiguous, don't invent a multiplication" stance is defensible **in
isolation**, but it is not ambiguous here — the *compensation* field on the same
record settles it arithmetically:

- 9815: `$20 + 6 × $100 = $620` — the stated total only closes at **six** study days.
- 4613: `$20 + 4 × $100 = $420` — four.
- 8458: `$50 + 3 × $125 = $425`, and the string literally says `for each study visit (3)`.
- 4611: `$20 + $200/study day = $820` — four study days; `$200 ÷ 14h = $14.29/hr`,
  which independently confirms the 14-hours-*each* reading.
- 6987: `content.rendered` says *"two 30-minute appointments and four hour-long
  appointments"*.

Cross-checking `visitCount` against `sessionCount` would catch all five. Today
`8458` even carries `compensation.visitCount: 3` and `duration.sessionCount: 4`
and nothing reconciles them. Worse, `8458` and `4611` are emitted at
`confidence: 'high'` on the compensation side, so the card shows no caveat at all.

**Impact:** three of these are in the live top 10; two more head the expired list.

### F2 — Numerator and denominator describe different scopes on per-visit studies (3 records, 2x error in both directions)

`computeEffectiveHourly` divides `guaranteedMax ?? guaranteedMin` by
`totalHoursMax`. When one of those is per-visit and the other is whole-study, the
result is meaningless. All three cases exist in the corpus:

- **#12766** `$50 per laboratory visit; $10 parent questionnaires; $10 child
  questionnaires` / `2 hours (in the form of two 1-hour visits)`.
  Parser: `gMin = 70` (one visit's $50 + $20) ÷ **2h** (both visits) = $35/hr.
  Truth (`content`: *"two laboratory visits, each lasting approximately 60
  minutes"*): `2 × $50 + $20 = $120 ÷ 2h =` **$60/hr**. Understated 42%.
- **#8874** `$30 per visit` / `Two visits, each about 2 hours`.
  Parser: `$30 ÷ 4h =` $7.50/hr. Truth: `$60 ÷ 4h =` **$15/hr**. `duration.sessionCount`
  is already `2`. Understated 50%, and it changes the bucket from `low` to `ok`.
- **#4618** `up to $225 over 3 visits (1 visit a year)` / `Visits last around
  3-3.5 hours`. Parser: `$225` (all three visits) ÷ **3.5h** (*one* visit) =
  $64.29/hr. Truth: `$225 ÷ ~9.75h =` **$23.08/hr**. Overstated 2.8x, rank 5 of
  the expired board. (This is also a **three-year** commitment — one visit per
  year — which nothing in the output conveys.)
- **#4620** is the same shape (`$50 for each visit` / `Visits last around 1.5
  hours`) and comes out at the *right* rate ($33.33) purely because both sides
  happen to be per-visit. The displayed **total** is still wrong: $50 shown,
  $100 actual (`content`: *"2 visits to the imaging center"*).

There is no guard anywhere that asserts the two operands share a scope.

### F3 — Three studies with money written in the body are reported as having no stated pay

The pipeline reads `meta.aux_study_item_compensation` only. Nine records have it
blank; three of those nine state compensation in `content.rendered`:

- **#4607** — *"Each family will receive **$420** for participation in all six
  visits, which are prorated at $80 … $40 … $90 … $50 … $100 … $60."*
- **#8402** — *"Parents schedule a 75-minute appointment and receive a **$15**
  Amazon e-gift card."* (duration parses cleanly to 1.25h → $12/hr)
- **#10128** — *"participants receive a small gift of a movie ticket (Cinemark)."*

`parse-eligibility.ts` already reads `content.rendered` and strips the site nav
chrome; the compensation path does not. The fix is a fallback, not new
infrastructure. (I verified the reverse direction too: for the other 77 records
the body's `Compensation …` section matches the meta field exactly, so a fallback
would be safe.)

### F4 — Dedupe silently drops the *more informative* posting, and never tells the reader the two disagreed

`dedupeStudies` keys on IRB number and keeps the most recently modified posting.
Two of the seven groups lose real information:

- **`STUDY2024-0630`** — kept **#8333** (`Up to $150` / `One Month`) and dropped
  **#7003** (`$150` / `1 Baseline Assessment 1 – 2 hours 8 Interventions – 1 – 2
  hours per Intervention (over the course of a 4 weeks)`). The dropped posting is
  the only one with a parseable duration. Result: a study that **was** rankable at
  $8.33/hr now falls off the ranked board entirely into "rate unknown."
- **`STUDY2024-0633`** — kept **#8903** (`$50` / `2 hours` → $25/hr) and dropped
  **#8411** (`$60` / `2 hours` → $30/hr). Same protocol, same PI, same duration,
  **$10 disagreement about pay**, resolved silently by modification timestamp.
  The reader is never told another live posting of this study advertises $60.

Merging field-by-field (take the most specific non-empty value per field) or at
minimum emitting a `notes` entry when survivors and dropped members disagree on
money would fix both.

### F5 — #8872 is ranked #2 at $105/hr on a denominator that omits nine days of the study

`Each interview: $20 / Each survey: $20 / Smartphone-based data collection:
maximum $100` ÷ `Each interview: 45 minutes to 1 hour / Each survey: 20 minutes /
Smartphone-based data collection: several minutes each day for nine days`.

The parser sums $140 (assuming exactly one interview, one survey, and the full
$100 cap) and divides by 1.33h — the interview plus the survey. The $100
component, **71% of the numerator**, buys nine days of daily smartphone data
collection whose time contributes **zero** to the denominator. Both fields say
"each" with no count. This record is not rankable; it is currently the second-best
deal on the board. `duration.confidence` is `low`, which is right, but `low`
confidence still ranks.

### F6 — Ceilings ("up to $X") are ranked as if guaranteed — 14 records, including ranks 1, 3, 4 and 22

Fourteen records have `guaranteedMin: null, guaranteedMax: <n>`, and
`computeEffectiveHourly` feeds the ceiling straight into the ranking:

`12780 · 11899 · 9821 · 9815 · 8333 · 6750 · 6745 · 5945 · 4626 · 4624 · 4618 · 4613 · 4611 · 4593`

The field is named `guaranteedMax` and the badge does say "up to" **when the rate
can't be computed** (case 4 of `RateBadge`), but once a rate exists the "up to"
disappears and a green `$68.89/hr` badge is rendered from a number the listing
explicitly did not guarantee. `9821` and `4593` survive this fine (their floors
are close to their ceilings); `9815`, `4611`, `4613` do not — their floor is one
$20 screening visit.

### F7 — `isHourlyRate` short-circuits past a stated total that contradicts it

`computeEffectiveHourly` returns `hourlyMax` before it ever looks at
`guaranteedMax / totalHoursMax`.

- **#7660** `$20/hr for imaging session, $10/hr for lab session ($40-50 total)` /
  `1 hr lab visit followed by a 1.5-2hr imaging session`. Ranked **$20.00/hr**.
  The listing's own total says `$50 ÷ 3h =` **$16.67/hr**. The parser has both
  numbers (`guaranteedMax: 50`, `totalHoursMax: 3`) and prefers the higher one.
- **#4632** — six different rates in one string; ranked at **$22.50/hr**, the top
  of the ladder, which applies only to visit 3 of one arm. The baseline control
  arm gets **$17.50/hr**, and the string also mentions "6 to 16 hours in between
  visits completing study activities" of unclear payment status.
- **#4591** `$15-25/hour` → ranked at $25. Floor is $15.

Taking `hourlyMax` is the optimistic end of every one of these.

### F8 — Contingent performance money is counted as guaranteed on #11899 (the mirror of the raffle rule)

`Up to $20: Participants are compensated **$5 per lab visit** … Each participant
will have an **opportunity to earn an additional $5** during each lab visit for
task-related reward.`

Guaranteed: 2 visits × $5 = **$10**. The other $10 must be earned. Ranked at
`$20 ÷ 0.9167h =` **$21.82/hr**; guaranteed floor is **$10.91/hr**. The parser
correctly excludes "chance to win up to an additional $5" as raffle money on
`6745/4626/4624` — the identical construction here ("opportunity to earn an
additional $5") is not caught, so it lands in the ranking numerator.

### F9 — #8331 is ranked #3 on a duration that is almost certainly per-session

`40-50 minutes`, but the compensation string describes **two** sessions ($30 +
$50 = $80) and `content.rendered` confirms: *"Each participant will complete two
sessions."* If 40-50 min is per session, the real rate is `$80 ÷ 1.5h =`
**$53.33/hr**, not $96. Nothing in the pipeline notices that the compensation
found two sessions while the duration found none.

### F10 — Rate-relevant `confidence: 'low'` has no effect on ranking

`8872` (low/low), `8458` (high comp / low duration), `4611`, `4613`, `9815`,
`6987`, `4618`, `4620` are all flagged, and all rank exactly as if they were not.
`index.astro` sorts purely on `effectiveHourly`. The flags are rendered as prose
on the card, below the big green number the reader has already used to decide.
Given F1/F2, low-confidence durations are **systematically rate-inflating**, not
symmetric noise — they should at minimum be barred from the `great` bucket.

### 11 — `$0/hr` studies outrank six studies carrying real guaranteed money

`6976`, `6974`, `6971` correctly parse "None" to `$0.00/hr`, which puts them in
the `low` bucket. Unranked studies sink below `low`. So a $0.00/hr survey sorts
**above** #11321 ($1,000), #12775 ($400), #8404 ($350), #6953 ($150 + devices),
#4630 ($150 + devices), #8333 (up to $150). Both behaviours are individually
defensible ("known zero" ≠ "unknown"); the ordering that falls out of them is not.
`RateBadge` gets the labels right ("Unpaid" vs "$400 total, rate unknown") — the
*sort* is what misleads.

### F12 — Conditional guarantees presented as unconditional (#8898, #6753)

`The first 400 participants will be offered a $10 gift card after completing the
survey.` Ranked at **$20/hr** with no qualification. Participant 401 gets a raffle
entry and nothing else. The parser deliberately (and correctly) suppresses the
phantom `$400` here — but it also drops the condition attached to the $10.

Related, and visible in the same pair: **#8898 gets `confidence: 'low'` and #6753
gets `'high'`** for near-identical text, purely because #8898's string is 396
characters and crosses the 400-char prose threshold with the extra sentence. The
confidence signal on this pair is noise.

### F13 — Task-performance bonuses mislabelled as raffle prizes (#6745, #4626, #4624)

`with a chance to win up to an additional $5 in cash during one of the
computerized tasks` is a performance bonus, not a drawing. It is bucketed as
`raffleMax: 10` and the card will render it under the dashed "not guaranteed"
prize treatment. The exclusion from guaranteed pay is the right call; the label is
wrong, and it makes the site look like it can't tell a lottery from a task bonus.

### F14 — Non-cash perks with real resale value are worth $0 in the ranking

`6953` (Bluetooth glucometer + weight scale), `4630` (BP cuff + weight scale),
`11321/8876` (an **Oura ring**, ~$300, explicitly *"they will be able to keep the
ring"*), `6750` (a $20 lunch). `hasNonCashPerk` is set but contributes nothing.
Combined with F11 these studies are both unranked *and* undervalued.

### F15 — #8338's internal contradiction is swallowed

Components sum to $130; the stated total is $120. The parser takes $120 and says
nothing. Also, the hours are slightly short: three 60-minute sessions plus one
75-minute session is **4.25h**, not the parsed 4h, so $30/hr should be $28.24/hr.

### F16 — `$60.01/hr` on #11315

`20$ ` / `20 mins `. 20 minutes is stored as `0.3333` (4dp), so `20 / 0.3333 =
60.01`. The correct answer is exactly $60.00. One cent here, but it scales
linearly with pay and it appears in the top 5 — a page whose entire pitch is
arithmetic honesty should not show a rate that is provably off.

### F17 — Three near-identical "Employee Retention" postings are not deduped

`6976` and `6974` have the same title, same PI, same `10-15 minutes`, same
"None", and **different IRB numbers** (`STUDY2024-0836` / `STUDY2024-0612`), so
`dedupeStudies` keeps both. IRB number is the only dedupe key. Two identical dead
entries at the bottom of the board — cosmetic, but it shows the key is too narrow.

### F18 — Expired postings are ranked, just in a different bucket

`index.astro` splits live from expired, which is right. But the expired section is
itself sorted by `effectiveHourly` and three of its top four (`4618` $64.29,
`4611` $51.25, `4613` $46.67) are exactly the records overstated 2.8–3.6x by F1
and F2. If anyone ever removes that split — or reads the RSS feed's full item
list, or the `/api/studies.json` payload — those three lead the board.

---

## Full row-by-row verdict (all 86)

Legend: **OK** = parser agrees with a careful human · **WRONG** = materially
misstates money or rate · **AMB** = genuinely ambiguous source, parser's reading
is defensible but the output does not convey the ambiguity · **BLIND** = pay or
hours exist in the record but the pipeline cannot see them.

| id | comp (parsed) | raffle | hours | $/hr | verdict | note |
|---|---|---|---|---|---|---|
| 12780 | $30 ceil | — | 2h | $15 | AMB | ceiling ranked as guaranteed (F6) |
| 12775 | $400 | — | span 6w | — | OK | no contact hours anywhere in the record |
| 12766 | $70+ | — | 2h | $35 | **WRONG** | should be $120 / 2h = **$60/hr** (F2) |
| 12764 | — | — | 0.75-1h | — | OK | blank meta, no pay in body either |
| 12762 | — | — | 0.12-0.17h | — | OK | blank meta, no pay in body either |
| 11901 | $10 | — | 0.33-0.5h | $20 | OK | |
| 11899 | $20 ceil | — | 0.92h | $21.82 | **WRONG** | guaranteed is $10 → $10.91/hr (F8) |
| 11896 | $20/hr | — | 5h | $20 | OK | |
| 11324 | $20/hr | — | 5h | $20 | OK | dropped dup of 11896, identical |
| 11321 | $1000 | — | span 26w | — | AMB | largest payout in corpus, unranked (F11/F14) |
| 11319 | — | — | 0.75-1h | — | OK | blank meta, no pay in body |
| 11317 | — | — | 0.75-1h | — | OK | dropped dup of 11319 |
| 11315 | $20 | — | 0.33h | $60.01 | OK* | should be exactly $60.00 (F16) |
| 11077 | $25 | — | 1.25h | $20 | OK | |
| 11075 | $10 | $50 | 2.5h | $4 | OK | hardest raffle case in the set, handled correctly |
| 11072 | $30 | — | 18h | $1.67 | OK | genuinely $1.67/hr; verified against body |
| 10351 | $10 | — | 0.5h | $20 | OK | "$10 each" = each partner, not each session |
| 10128 | — | — | — | — | **BLIND** | movie ticket stated in body; also in the *duration* field (F3) |
| 10126 | $20 | — | 0.5h | $40 | OK | |
| 9959 | — | — | 1-1.5h | — | OK | blank meta, no pay in body |
| 9957 | $45 | — | 1h | $45 | OK | |
| 9953 | $45 | — | 1-1.5h | $30 | OK | body confirms "$45.00 total … not pro-rated" |
| 9821 | $550 ceil | — | 4h | $137.50 | OK | verified: 3×$150+$100, visits 1.5+1+1.5. Floor $112.50/hr |
| 9815 | $620 ceil | — | 9h | $68.89 | **WRONG** | 44h → **$14.09/hr** (F1) |
| 9028 | $15 | — | 0.67-1h | $15 | OK | |
| 8908 | $15 | — | 0.67-1h | $15 | OK | dropped dup of 9028 |
| 8903 | $50 | — | 2h | $25 | AMB | dedupe survivor; twin #8411 says $60 (F4) |
| 8898 | $10 | $100 | 0.33-0.5h | $20 | AMB | "first 400 participants" condition dropped (F12) |
| 8882 | $25/hr | — | 4.5h | $25 | OK | |
| 8876 | $1000 | — | span 26w | — | AMB | dropped dup of 11321 |
| 8874 | $30+ | — | 4h | $7.50 | **WRONG** | should be $60 / 4h = **$15/hr**; wrong bucket (F2) |
| 8872 | $140 | — | 1.08-1.33h | $105 | **WRONG** | unrankable; 9-day EMA excluded from denominator (F5) |
| 8458 | $425 | — | 9h | $47.22 | **WRONG** | 21h → **$20.24/hr** (F1) |
| 8420 | $20 | — | 2h | $10 | OK | |
| 8417 | $0 | $50 | 0.17-0.25h | — | OK | raffle-only, correct |
| 8411 | $60 | — | 2h | $30 | AMB | dropped in favour of the $50 twin (F4) |
| 8408 | $50 | — | 1.5h | $33.33 | OK | |
| 8406 | $60 | — | 3.5h | $17.14 | OK | listing's own $17.14/hr matches the arithmetic |
| 8404 | $350 | — | span 3w | — | OK | no contact hours stated |
| 8402 | — | — | 1.25h | — | **BLIND** | body: "$15 Amazon e-gift card" → $12/hr (F3) |
| 8399 | $50 | — | 1.5h | $33.33 | OK | |
| 8338 | $120 | — | 4h | $30 | AMB | hours are 4.25 → $28.24; $130-vs-$120 contradiction unflagged (F15) |
| 8333 | $150 ceil | — | span 4.35w | — | AMB | dedupe kept the unrankable twin (F4) |
| 8331 | $80 | $200 | 0.67-0.83h | $96 | **WRONG** | two sessions → likely **$53.33/hr** (F9) |
| 7773 | $50 | — | 2h | $25 | OK | |
| 7784 | $10 | — | 0.5h | $20 | OK | |
| 7660 | $50 | — | 2.5-3h | $20 | **WRONG** | stated total implies **$16.67/hr** (F7) |
| 7003 | $150 | — | 9-18h | $8.33 | AMB | dropped; the only rankable posting of this protocol (F4) |
| 6997 | $15 | — | — | — | OK | duration field genuinely empty |
| 6995 | $60 | — | 4h | $15 | OK | attributive "two separate two-hour sessions" handled |
| 6990 | — | — | — | — | OK | both fields blank, nothing in body |
| 6987 | $60 | $50 | 1.5h | $40 | **WRONG** | 5 appointments = 5h → **$12/hr** (F1) |
| 6980 | $175 | — | 12.5h | $14 | OK | hours and span tracked separately, correctly |
| 6978 | $0 | $10 | 0.17-0.25h | — | OK | raffle-only, correct |
| 6976 | $0 | — | 0.17-0.25h | $0 | OK | "None"; but outranks six paying studies (F11) |
| 6974 | $0 | — | 0.17-0.25h | $0 | OK | near-dup of 6976, different IRB (F17) |
| 6971 | $0 | — | 0.25h | $0 | OK | |
| 6969 | $5 | $100 | 1h | $5 | OK | correctly refuses to count the $100 drawing |
| 6960 | $30 | — | 1h | $30 | OK | |
| 6956 | $30 | — | 1-1.5h | $20 | OK | |
| 6953 | $150 | — | span 4.29w | — | AMB | + glucometer + scale valued at $0 (F14) |
| 6950 | $15 | — | 2h | $7.50 | OK | |
| 6944 | $120 | — | 10h | $12 | OK | itemised sum 2+4+4 correct |
| 6942 | $25 | — | 1-1.5h | $16.67 | OK | |
| 6753 | $10 | $100 | 0.33-0.5h | $20 | AMB | dropped dup of 8898; note the confidence split (F12) |
| 6750 | $20 ceil | — | 1h | $20 | OK | "up to" attaches to the lunch, not the gift card |
| 6747 | $25 | — | 1h | $25 | OK | |
| 6745 | $165 ceil | $10 | 12h | $13.75 | AMB | $10 is a task bonus, not a raffle (F13) |
| 5945 | $300 ceil | — | 12h | $25 | AMB | ceiling ranked as guaranteed (F6) |
| 5701 | $25/hr | — | 4h | $25 | OK | |
| 5436 | $100 | — | 6h | $16.67 | OK | total-beats-summing works |
| 4642 | $225 | — | span 26w | — | OK | breakdown correctly not double-counted |
| 4636 | $25/hr | — | 3-3.5h | $25 | OK | |
| 4634 | $30 | — | 2-2.25h | $13.33 | OK | |
| 4632 | $22.50/hr | — | 3-25h | $22.50 | **WRONG** | ranked at the top of a 6-rate ladder; baseline arm is $17.50 (F7) |
| 4630 | $150 | — | span 38.6w | — | AMB | + BP cuff + scale at $0 (F14) |
| 4626 | $165 ceil | $10 | 17.5h | $9.43 | OK | |
| 4624 | $165 ceil | $10 | 17.5h | $9.43 | OK | |
| 4620 | $50+ | — | 1.5h | $33.33 | AMB | rate right by coincidence; **total is $100, shown as $50** (F2) |
| 4618 | $225 ceil | — | 3-3.5h | $64.29 | **WRONG** | $225 over 3 visits ÷ one visit → **$23.08/hr** (F2) |
| 4615 | $10/hr | — | 0.5-2h | $10 | OK | |
| 4613 | $420 ceil | — | 9h | $46.67 | **WRONG** | 27h → **$15.56/hr** (F1) |
| 4611 | $820 ceil | — | 16h | $51.25 | **WRONG** | 58h → **$14.14/hr** (F1) |
| 4607 | — | — | — | — | **BLIND** | body states **$420** over six visits, itemised (F3) |
| 4593 | $560 ceil | — | 27h | $20.74 | OK | 3 + 12×1.5 + 3×2 = 27 — distributive multiplication works here |
| 4591 | $25/hr | — | 1h | $25 | AMB | `$15-25/hour` ranked at the top (F7) |

**Tally:** 12 WRONG · 3 BLIND · 21 AMB · 50 OK.

---

## What is actually good

Worth saying, because it is load-bearing and it means the failures above are
fixable rather than architectural:

- The raffle/guaranteed split is genuinely hard and genuinely correct on all 14
  raffle records, including `11075` (one payment described twice, guaranteed and
  raffled money in the same sentence) and `6969` (`1 of 5 $100` with no drawing
  word).
- Total-beats-summing is correct on all 11 records that state a total, including
  the `$80` gap-sizing case and the `$225` leading-total-plus-breakdown case.
- "Span is never converted to hours" is the right call and is applied
  consistently to all 8 span-only records. `12775` reporting `null` rather than
  `$0.40/hr` is exactly right.
- `RateBadge` refuses to put a raffle prize in the money slot, and distinguishes
  "Unpaid" from "rate unknown" from "$X total". The labels are honest even where
  the sort is not.
- The `''` → `$0/hr` bug (blank compensation reported as a confident zero) was
  present in an earlier revision of `parse-compensation.ts` and is **fixed** in
  the revision audited here.

---

# Round 2 re-audit

**Independent re-verification after the fix round.** Written by an agent that
authored none of the fixes and read the four fix reports only as claims to be
checked. Every number below was re-derived by running all 86 fixture records
through the real pipeline (`normalizeAndDedupe` → `parseCompensation` /
`parseDuration` → `computeEffectiveHourly` → `sortStudies`), then adjudicated
against the raw `aux_study_item_compensation` / `aux_study_item_duration`
strings and `content.rendered`. The rendered board was read back out of
`dist/index.html` after a clean `npm run build`, so nothing here rests on a
re-derivation the site does not actually ship.

**Source state re-audited:**

| file | md5 |
|---|---|
| `parse-compensation.ts` | `61840229cdf7454c2f1912b88ad6fff3` |
| `parse-duration.ts` | `1e3d3a899ac9dbefbd4c41a89c2f5cd9` |
| `effective-rate.ts` | `89c13cba94df98378b8a1fca62f39021` |
| `normalize.ts` | `ec783e0dff051208aeffffed536f2de6` |
| `extract-from-content.ts` | `4b5de7e2fb289baeab8a38b91f5e57b0` (new) |
| `index.astro` | `403f108984a7b3cb129a9047e8ad0c34` (unchanged) |

Build state: `npx vitest run` 805/805 pass · `tsc --noEmit` clean ·
`astro check` 0/0/0 · `npm run build` 81 pages, 79 study pages.
86 raw → 79 deduped → 63 live → **48 ranked**, unchanged.

## The short version

**The three worst rows are genuinely fixed. The board is materially better and
materially safer. It is still not clean, and one row is wrong by ~2x at rank 2.**

- 12 WRONG → **6 WRONG**. 3 BLIND → **0.5 BLIND**.
- The four disqualified top-10 rows (`9815`, `8458`, `6987`, `8872`) are all
  gone from the top 10, verified by reading the built HTML, not the fixture.
- `9815` — the brief's headline case — now reads **44 hours / $14.09/hr** on
  both the card and the study page, with "Sessions: 7" and the verbatim source
  string beneath it. That specific failure is closed.
- **F2 was not touched at all.** It is the largest single remaining hole and it
  owns two rows of the live top 10 and the top of the expired board.
- **F9 was not touched.** `8331` still shows **$96.00/hr at rank 2** on a
  duration that its own body proves is per-session. Real range **$48–$60/hr**.
- **Two new defects were introduced** by the contingent-money work. Neither
  fires on the current 86 records, so both are invisible today; one of them
  will render a paying study as **"Unpaid"** the first time a coordinator
  writes "you will earn $30". The site refreshes from live upstream twice a
  day (`.github/workflows/refresh.yml`, `17 11 * * *` / `17 23 * * *`), so
  "not in the fixture" is a stay of execution, not a defence.

## 1. Every original finding, re-checked

| # | verdict | evidence |
|---|---|---|
| **F1** | **FIXED** (4 of 5 exactly; 5th deviates safely) | `9815` 9h→**44h**, $68.89→**$14.09** ✓ · `4611` 16h→**58h**, $51.25→**$14.14** ✓ · `4613` 9h→**27h**, $46.67→**$15.56** ✓ · `8458` 9h→**21h**, $47.22→**$20.24** ✓ · `6987` 1.5h→**5.5h**, $40.00→**$10.91** (target was 5h/$12.00) |
| **F2** | **STILL BROKEN — nothing changed** | `12766` still **$35.00** (should be $120/2h = **$60.00**) · `8874` still **$7.50** (should be $60/4h = **$15.00**, and still in the `low` bucket) · `4618` still **$64.29** (should be $225/10.5h = **$21.43**) · `4620` still displays a **$50** total when the body says 2 visits at $50 = **$100** |
| **F3** | **FIXED** | `4607` = $420 / visitCount 6 / provenance note, and **not** $840 (the restatement trap) ✓ · `8402` = $15 giftcard → **$12.00/hr**, now ranked ✓ · `10128` perk flagged in a note ✓ (money still $0 and its duration is still unread — see below) |
| **F4** | **STILL BROKEN** | Groups unchanged: `8333` kept / `7003` dropped (7003 is the only rankable posting, parses cleanly to 9–18h → $8.33/hr) · `8903` $50 kept / `8411` **$60** dropped. No note anywhere records that a live twin advertises $10 more. |
| **F5** | **FIXED** | `8872` hours `1.08–1.33` → **null**, rate $105.00 → **null**, `spanWeeks 1.29` preserved, `guaranteedMax` still $140 so the card can still say "$140 total, rate unknown". Confirmed sitting in the unrated block of `dist/index.html`. |
| **F6** | **STILL BROKEN** | 14 ceiling records still feed `guaranteedMax` straight into the ranking. `9815`'s green `$14.09/hr` is still derived from an "up to $620" whose floor is one $20 screening visit ($10/hr). Less harmful now only because the denominator got honest. |
| **F7** | **STILL BROKEN** | `7660` **$20.00** (its own stated total says $50/3h = $16.67) · `4632` **$22.50** (top of a six-rate ladder; baseline arm is $17.50) · `4591` **$25.00** (`$15-25/hour`). |
| **F8** | **FIXED — with collateral damage** | `11899` `guaranteedMax` 20→**10**, `visitCount` null→2, **$21.82→$10.91/hr** ✓, note explains the split. But see R1/R2 below: the mechanism that achieved this is over-broad. |
| **F9** | **STILL BROKEN** | `8331` **$96.00 at live rank 2**. `content.rendered`: *"Each participant will complete two sessions."* `duration.sessionCount` is `null`, `compensation` describes two sessions ($30 + $50 = $80). Per-session reading gives **$48.00–$60.00/hr**. Nothing reconciles the two counts. |
| **F10** | **STILL BROKEN** | `8331` carries `compensation.confidence: 'low'` and ranks **2nd**, in the `great` bucket. Ranking is still `effectiveHourly` only. |
| **F11** | **STILL BROKEN** | Unrated order read from the built page: `12775, 12764, 12762, **11321**, 11319, 10128, 9959, 8872, …`. The **$1,000** study is 4th among unknowns — below two studies with *no stated pay at all* — and below all 48 ranked rows including three $0.00/hr surveys. `index.astro:71-74` still sorts the unrated block by `postedDate` alone. |
| **F12** | **STILL BROKEN** | `8898` notes: raffle + "long free-text"; no note anywhere says the $10 is limited to the first 400 participants. Confidence split with `6753` unchanged. |
| **F13** | **PARTIAL (label only)** | Note reworded to *"up to $10 is contingent on task performance (\"chance to win\"), not a drawing prize"* ✓ — but the money is still in `raffleMax`, so the UI still renders it under the lottery treatment. Honest reason given (no `contingentMax` field exists yet); the mislabel survives. |
| **F14** | **STILL BROKEN** | Oura ring, glucometer, BP cuff, scales, $20 lunch all still worth $0. |
| **F15** | **HALF FIXED** | Compensation half ✓: `8338` now carries *"the listing contradicts itself: its 4 itemised amounts sum to $130 but it states a total of $120; the stated total is used"*, and `8458`/`8331` correctly stay silent. Duration half ✗: hours are still **4**, not **4.25** (3×60 min + 1×75 min), so the rate is **$30.00** where it should be **$28.24** — and that 6% is what keeps 8338 in the top 10 and pushes `9953` out. |
| **F16** | **FIXED** | `11315` **exactly $60.00**. Verified the snap changes nothing else: re-running all 79 survivors with and without `exactHours()` produces exactly one differing rate — 11315, 60.01 → 60. |
| **F17** | **STILL BROKEN** | `6976` and `6974` both live, different IRB numbers. |
| **F18** | **PARTIAL** | Expired board, read from the built page: **`4618` $64.29**, `4620` $33.33, `4591` $25, `4636` $25, `4632` $22.50, `4593` $20.74, `5436` $16.67, `4613` $15.56, `4611` $14.14. `4611`/`4613` are corrected ✓; `4618` still leads it at 3x. |

**Score: 6 fixed, 1 half-fixed, 2 partial, 9 untouched.** The fixes that landed
are the highest-impact ones. The untouched list is not cosmetic — F2 and F9 are
both top-10 rows.

## 2. The live top 10, adjudicated row by row

Read out of `dist/index.html` after a clean build (`data-id` order in
`#section-ranked`), not re-derived:

| rank | id | shown | defensible | verdict |
|---|---|---|---|---|
| 1 | 9821 | $137.50 | $137.50 (floor $112.50) | ✅ `$150 × 3 + $100` over `1.5 + 1 + 1.5 = 4h`. Correct. |
| 2 | 8331 | **$96.00** | **$48.00–$60.00** | ❌ **1.6–2.0x high.** `40-50 minutes` is per session; the body says two sessions. F9, unfixed. |
| 3 | 11315 | $60.00 | $60.00 | ✅ Was $60.01. F16 fixed. |
| 4 | 9957 | $45.00 | $45.00 | ✅ `$45` / `1 hour`. |
| 5 | 10126 | $40.00 | $40.00 | ✅ `$20` / `30 minutes`. |
| 6 | 12766 | **$35.00** | **$60.00** | ❌ **Understated 42%.** `$50 per laboratory visit` counted once against both visits' hours. Belongs at **rank 3**. F2, unfixed. |
| 7 | 8399 | $33.33 | $33.33 | ✅ |
| 8 | 8408 | $33.33 | $33.33 | ✅ |
| 9 | 6960 | $30.00 | $30.00 | ✅ |
| 10 | 8338 | $30.00 | $28.24 | ⚠️ 6% high; 4.25h read as 4h. At the honest figure it is rank 11 and `9953` ($30.00, correct) takes rank 10. F15 duration half, unfixed. |

**Seven of ten correct, one marginal, two materially wrong** — against six of
ten correct and four materially wrong before. Real progress.

**Is this the top 10 the original audit predicted?** No. Predicted:
`9821, 11315, 12766, 8331, 9957, 10126, 8408, 8399, 9953, 6960`.
Actual: `9821, 8331, 11315, 9957, 10126, 12766, 8399, 8408, 6960, 8338`.

Membership is 9/10 identical (`8338` in, `9953` out). The three ordering
differences are **not** justified — each is a specific unfixed finding:

- `8331` sits at 2 instead of ~4 because F9 was never addressed.
- `12766` sits at 6 instead of 3 because F2 was never addressed.
- `8338` displaces `9953` at rank 10 because the F15 duration half was never
  addressed.

The `8399`/`8408` swap is a genuine tie at $33.33 broken by ascending id, and
is fine.

## 3. Regression hunt — the multiplication change

**This was the highest-risk change and it is clean on the corpus.** I
hand-adjudicated the parsed hours of all 79 survivors *and* all 7 dropped
duplicates against their raw strings, then diffed the result against the
original audit's hours column for all 86.

**Exactly six records' hours moved, and every one was a target:**
`9815` 9→44 · `4611` 16→58 · `4613` 9→27 · `8458` 9→21 · `6987` 1.5→5.5 ·
`8872` 1.08–1.33→null. **Zero other records changed. Zero over-multiplications.**

The brakes hold on every corpus case that must *not* multiply, verified
individually: `8882` `"Two visits: 3 hrs and 1.5 hrs"` → **4.5h** (enumerating,
not distributing) · `12766` `"2 hours (in the form of two 1-hour visits)"` →
**2h** · `11896` `"3 visits, 5 hours total"` → **5h** · `11075` → **2.5h** ·
`8406` `"3.5 hours (in two visits; …)"` → **3.5h** · `11899` `"55 minutes across
two lab visits (…)"` → **0.92h** · `5436` → **6h**. And the pre-existing
correct multiplications survive: `4593` 3 + 12×1.5 + 3×2 = **27h**, `7003`
1–2 + 8×(1–2) = **9–18h**, `6995` **4h**, `8874` **4h**, `8420` **2h**.

Synthetic probes confirm the guard vocabulary is doing real work:
`"6 hours total across 3 study visits"` → 6 · `"2 visits and 3 hours of online
questionnaires"` → 3 · `"2 sessions. The first lasts 1 hour."` → 1 ·
`"4 visits over 2 hours"` → 2 · `"6 study days lasting up to 7 hours in
total"` → 7.

**One latent over-multiplication class survives** (R3 below), but it runs
through the *pre-existing* `per <noun>` distributive path, not the new
juxtaposition path, so it is not a regression from this round.

## 4. Content-extraction fallback — false-positive check

**Clean. No false positives.** The gate fires on exactly the 9 blank-meta
records (`4607, 8402, 10128, 12764, 12762, 11319, 11317, 9959, 6990`) and on
nothing else; every record with a non-blank meta field parses to exactly
`parseCompensation(meta)`.

I read all nine bodies in full. Three carry participant compensation and all
three were extracted correctly:

- `4607` → `$420`, and specifically **not** `$840` — the body writes
  *"$420 … which are prorated at $80 … $40 … $90 … $50 … $100 … $60"* and the
  clause-trim cuts before the restatement. `visitCount 6`. Correct.
- `8402` → `$15` Amazon e-gift card, `confidence medium`, → **$12.00/hr**,
  now ranked. Correct.
- `10128` → no money invented; a note records the Cinemark ticket that the
  coordinator pasted into the duration field. Correct and appropriately timid.

The other six genuinely state no compensation anywhere in their bodies —
verified sentence by sentence. I also swept every survivor with null guaranteed
pay for dollar figures anywhere in `content.rendered`; the only hits are
`4632` and `4615`, both of which already parse an hourly rate from meta and are
correctly gated out. **No grant money, equipment cost, or sponsor figure was
pulled anywhere.**

One thing the fallback leaves on the table: `10128`'s body says
*"a 30-45 minute in-person study"*. The duration is right there and unread,
so the record stays unranked. Not a false positive — an unfinished true one.

## 5. New defects introduced this round

These did not exist before the fix round. None fires on the current 86 records,
which is exactly why they need writing down.

### R1 — "will earn" / "can earn" zeroes out ordinary attendance pay, and the card says **"Unpaid"**

`CONTINGENT_TRIGGER_RE` (`parse-compensation.ts:176`) includes
`(?:may|might|can|could|will)\s+(?:be\s+)?earn(?:ed)?`, and the exclusion span
runs from the trigger to the end of the sentence. Verified outputs:

| input | `guaranteed` | rate at 1h | badge |
|---|---|---|---|
| `"Participants will earn $30 for completing the survey."` | **0 / 0** | **$0.00** | **Unpaid** |
| `"You can earn $45 for the session."` | **0 / 0** | **$0.00** | **Unpaid** |
| `"You will earn up to $200 over the course of the study."` | **0 / 0** | **$0.00** | **Unpaid** |
| `"Participants will be earning $30."` | 30 / 30 | $30.00 | $30/hr |
| `"Payment is $60, which will be earned upon completion of all visits."` | 60 / 60 | $60.00 | $60/hr |

"Earn" is the single most ordinary verb for attendance pay in this genre. The
last two rows show the behaviour turns on nothing but word order and inflection
— whether the amount happens to sit before or after the trigger. `RateBadge`
renders `guaranteedMax === 0` as literally **"Unpaid"**
(`RateBadge.astro:64-67`), so a $200 study would be published as unpaid, sorted
into the `low` bucket, and filtered out by anyone screening on rate.

This is a worse *kind* of error than the one it was introduced to fix: F8
overstated one study by 2x; R1 can zero one out entirely. The compensation
agent deliberately excluded bare `reward` because `6745`'s *"will reward the
participant $45 in cash"* is attendance pay — the identical argument applies to
`will earn` and was not made. Fix: require an explicit contingency object
(`bonus`, `additional`, `task`, `performance`, `accuracy`, `reward`) inside the
span, or drop the bare `will|can earn` alternation entirely and keep only
`opportunity/chance/eligible/able to earn`, which is what actually caught
`11899`.

### R2 — "all money is contingent" returns a guaranteed **0**, not **null**

Same probes: the all-contingent path emits `guaranteedMin/Max = 0` with the note
*"every stated amount is contingent on performance; no guaranteed payment"*.
`effective-rate.ts`'s own header states the rule this breaks:

> `guaranteedMax: 0` is a measurement, `guaranteedMax: null` is the absence of
> one.

"You might earn something, we cannot say how much you are guaranteed" is the
absence of a measurement. Emitting `0` makes it a ranked, confident claim that
the study pays nothing, and — because `0` is not `null` — it also suppresses the
F3 content fallback that would otherwise go looking in the body. Should be
`null` plus the note.

### R3 — no sanity bound on multiplied hours; a headcount can become a session count

`countRegex()` allows up to two filler words between a number and a session
noun, so `"20 participants per session"` parses as **20 sessions**:

| input | parsed hours |
|---|---|
| `"20 participants per session, 1 hour"` | **20 h** |
| `"5 people per session; the session takes 1 hour"` | **5 h** |
| `"10 trials per session, 45 minutes"` | **7.5 h** |

This runs through the pre-existing `per <noun>` distributive path, so it is
**not** a regression from this round — but the round is what makes it worth
raising, because `MAX_PLAUSIBLE_SESSIONS` is **500** and there is no upper bound
on total hours anywhere in the pipeline. `effective-rate.test.ts` has a $200/hr
ceiling tripwire; there is no equivalent "no study is 200 contact hours"
tripwire, and over-multiplication now has a second, wider entry point.
Over-multiplying buries good studies, which the fix round itself identified as
the other half of the harm.

### R4 — `6987` is pinned 10% below the reading its own body supports

`5.5h / $10.91` vs the body's *"two 30-minute appointments and four hour-long
appointments"* = `5h / $12.00`. The deviation is documented in two places in the
test suite, is in the safe direction, and does not change the bucket or the
rank. **Accepted**, but it is an accepted inaccuracy, not a fix, and calling it
otherwise would be the kind of rounding-toward-success this document exists to
prevent.

## 6. What is genuinely good about this round

- **The tests do not lie.** `effective-rate.test.ts:714` `KNOWN ISSUES (pinned,
  not endorsed)` pins `12766` at the wrong `$35`, `8874` at the wrong `$7.50`,
  `4618` at the wrong `$64.29` and `8331` at the wrong `$96` — each with the
  correct arithmetic asserted beside it and an instruction not to re-pin. That
  is the right way to leave a bug you did not fix, and it is the reason this
  re-audit could confirm the gaps in minutes rather than hours.
- The `GOLDEN: the live top 10` test asserts against `dist`'s own
  `snapshot.json` as well as a fresh re-derivation, and its comments flag rows
  2, 6 and 10 as suspect rather than blessing them.
- The two clean invariants stayed clean: **no raffle money leaked** (all 11
  prize-bearing records re-verified: 11075 $50/$10 · 8898+6753 $100/$10 · 8331
  $200/$80 · 6987 $50/$60 · 6969 $100/$5 · 8417 + 6978 raffle-only $0 ·
  6745/4626/4624 $10 vs $165), and **no total was double-counted with its
  parts** (all 20 total-bearing records re-checked; `11899` $20→$10 is the only
  monetary value that moved anywhere in the corpus).
- `9815`'s study page is now a model of the thing the site is for: `$14.09/hr`,
  `44 hours spread over about 4 weeks`, `Sessions: 7`, an explicit
  low-confidence caveat, and the verbatim source string underneath.

## 7. Final verdict

**Is the top of the board now trustworthy enough that a reader acting on rank
order would not be misled?**

**No — but it is close, and the remaining lie is one fix away.**

The brief's specific failure is closed: nobody will now sign up for `#9815`
expecting $68.89/hr and discover 44 hours of fasted clinic days. Three 2.3–4.9x
inflations and one unrankable record are gone from the top 10, and the reader
who lands on any of those pages now sees honest arithmetic.

But **rank 2 is still wrong by roughly 2x.** A reader who trusts the ordering
takes `8331` at `$96.00/hr` as the second-best deal on the board and turns up to
two sessions totalling 80–100 minutes for $80 — **$48–$60/hr**, which puts it
somewhere between rank 3 and rank 5. Nothing on that card warns them: the
compensation parse is `confidence: 'low'` and low confidence still ranks (F10),
so the caveat is prose beneath a green badge the reader has already acted on.
And `12766` — the audit's original "buried at rank 10" case, explicitly named in
the brief — is still understated 42% and still six rows below where it belongs.

"Two of the top ten materially wrong, one of them at rank 2, one of them the
best-value study on the board" is not a board a reader can act on rank-first. It
is, however, a board where the *pages* are honest even when the *order* is not,
and where every remaining defect is pinned by a named, failing-on-purpose test.

The single change that closes most of what is left: **`computeEffectiveHourly`
must not divide a per-visit numerator by a whole-study denominator.** Multiply
`compensation.perVisit` by `compensation.visitCount ?? duration.sessionCount`
before dividing, and refuse to rank when the two operands' scopes cannot be
reconciled. That one guard fixes `12766` (rank 6 → rank 3), `8874` (`low` →
`ok`), `4618` (expired rank 1 → mid-board), and gives F9 the reconciliation
hook `8331` needs. It is unowned: the duration agent called it "not my files",
the compensation agent did not touch `effective-rate.ts`, and the content agent
handed it off. **Someone has to own it.**

---

# Round 3 re-audit

**Independent re-verification of the F2 / F11 / R1 / R2 round.** Written by an
agent that authored none of these fixes and read the two fix reports only as
claims. Every number below was re-derived by running all 86 fixture records
through the real pipeline, then read back out of `dist/index.html` after a
clean `npm run build`. Nothing here rests on a re-derivation the site does not
ship: the fixture pipeline and the shipped `snapshot.json` were diffed
record-by-record and agree on **all 79 rates, zero mismatches**.

**Source state re-audited:**

| file | md5 |
|---|---|
| `parse-compensation.ts` | `dd97c34cad23993f916746f2e929493e` |
| `parse-duration.ts` | `1e3d3a899ac9dbefbd4c41a89c2f5cd9` (unchanged) |
| `effective-rate.ts` | `62eea8bdccb5611eefd1117cc55be2a1` |
| `normalize.ts` | `cfafdd0d34f46f5e08705c6e56677934` |
| `extract-from-content.ts` | `4b5de7e2fb289baeab8a38b91f5e57b0` (unchanged) |
| `index.astro` | `73b0d531ebd484baa3099c99dacd6543` (**changed** — F11 wired) |

Build state: `npx vitest run` **836/836 pass** · `tsc --noEmit` clean ·
`astro check` 0/0/0 · `npm run build` 81 pages, 79 study pages.
86 raw → 79 deduped → 63 live → **48 ranked**, unchanged.

**Process note.** `index.astro` was modified at 23:30:34, *during* my first
build (23:30:05), so that build rendered the pre-F11 board. Test files moved
again at 23:39. The `src/lib/*.ts` hashes above were stable across every
measurement in this document; only tests changed under me. Anyone re-checking
this round must rebuild rather than trust an existing `dist/`.

## The short version

**The regression sweep is clean — genuinely, provably clean — and F2 and F11
both work. R1 is not dead; it is narrowed. And the F2 fix introduced a
user-visible arithmetic contradiction on the three cards whose rate it
changed.**

- Exactly **3 of 79 rates moved**, and all 3 are the intended F2 targets.
  **Zero unintended movement.** I diffed every record against the round-2
  numbers, not a sample.
- The four F2 rows are **right against their raw strings**: 12766 $60, 8874
  $15, 4618 $21.43, 4620 $33.33.
- **F11 landed** (the round-2 recommendation was only a *proposal* in the fix
  report; someone wired it). #11321's $1,000 is now first in the unrated
  bucket, and the order survives the browser's startup re-sort.
- **R1's headline symptom is dead** — nothing now renders "Unpaid". But 5 of 9
  ordinary attendance-pay strings I invented are still delisted from the board
  entirely via the *surviving* triggers `eligible to earn` / `able to earn` /
  `opportunity to earn`. R2 downgraded the failure from "Unpaid at $0/hr" to
  "Pay unclear, unranked". That is better. It is not fixed.
- **New this round:** `reconcileEffectiveHourly` returns `notes`, `basis`,
  `visitCount`, `guaranteedTotal` and `confidence`, and `normalize.ts`
  **discards all five**, keeping only `.rate`. So on #4618 the card now reads
  "up to $225" · "~3h–3.5h" · **"$21.43 per hour"** — three numbers that
  contradict each other by 3x, with no note explaining why.
- **8331 is still $96.00 at rank 2**, unchanged for a third round. The fix
  report says F2 "gives F9 its hook". It does not — see §6.

## 1. The rendered board, read out of `dist/index.html`

Read from the `<ol id="list-*">` children after `rm -rf dist .astro && npm run
build`. Not re-derived.

### Live ranked, top 10 (48 ranked)

| rank | id | shown | defensible | verdict |
|---|---|---|---|---|
| 1 | 9821 | $137.50 | $137.50 (floor $112.50) | ✅ `$150 × 3 + $100` / `1.5+1+1.5 = 4h` |
| 2 | 8331 | **$96.00** | **$48.00–$60.00** | ❌ **1.6–2.0x high.** F9, third round untouched |
| 3 | 11315 | $60.00 | $60.00 | ✅ exact, F16 holds |
| 4 | 12766 | **$60.00** | **$60.00** | ✅ **fixed this round** (was $35.00 at rank 6) |
| 5 | 9957 | $45.00 | $45.00 | ✅ |
| 6 | 10126 | $40.00 | $40.00 | ✅ |
| 7 | 8399 | $33.33 | $33.33 | ✅ |
| 8 | 8408 | $33.33 | $33.33 | ✅ tie with 8399, broken by id |
| 9 | 6960 | $30.00 | $30.00 | ✅ |
| 10 | 8338 | $30.00 | $28.24 | ⚠️ 6% high; 4.25h read as 4h. F15 duration half |
| 11 | 9953 | $30.00 | $30.00 | ✅ takes rank 10 at 8338's honest figure |

**Eight of ten correct, one marginal, one materially wrong** — against round
2's seven / one / two. The improvement is entirely 12766.

### Unrated bucket (15 live) — F11 verified working

`11321 ($1,000) · 12775 ($400) · 8404 ($350) · 8333 ($150) · 6953 ($150) ·
8872 ($140) · 6997 ($15) · 8417 ($0) · 6978 ($0) · 12764 · 12762 · 11319 ·
10128 · 9959 · 6990`

Exactly the order the fix report predicted. The $1,000 study moves 4th → 1st.
I checked the failure mode that would have made this cosmetic: `index.astro`
calls `resort()` at startup (line 566), which re-sorts `list-unrated` by
`data-rate`. All 15 cards carry a **bare** `data-rate` attribute, so `num()`
returns `null` for every one, the comparator returns 0 for every pair, and
`Array.prototype.sort` stability preserves the SSR order. **F11 survives in
the browser.** It would not survive a future change that gave unrated cards a
numeric `data-rate`.

### Expired board (16)

`4620 $33.33 · 4591 $25 · 4636 $25 · 4632 $22.50 · **4618 $21.43** · 4593
$20.74 · 5436 $16.67 · 4613 $15.56 · 4611 $14.14 · 4634 $13.33 · 4615 $10 ·
4624 $9.43 · 4626 $9.43 · 4607 · 4630 · 4642`

4618 drops from leading this board at 3x to 5th at an honest figure. F18's
remaining rows are `4591` and `4632` (both F7, both untouched).

## 2. Is R1 dead? **No — narrowed.**

### The five audit strings: all fixed ✅

| input | round 2 | now |
|---|---|---|
| `Participants will earn $30 for completing the survey.` | 0/0 → **Unpaid** | **30/30, $30/hr** ✅ |
| `You can earn $45 for the session.` | 0/0 → **Unpaid** | **45/45, $45/hr** ✅ |
| `You will earn up to $200 over the course of the study.` | 0/0 → **Unpaid** | **null/200, $200/hr** + ceiling note ✅ |
| `Participants will be earning $30.` | 30/30 | 30/30 ✅ |
| `Payment is $60, which will be earned upon completion of all visits.` | 60/60 | 60/60 ✅ |

The corpus evidence for the deletion checks out: I re-ran the deleted
alternation over all 86 compensation strings and **4615 is the only match**
(`"additional bonuses may be earned"`), with **no dollar figure after the
trigger**, and its `bonus` note still comes from the unpriced-bonus path
(confirmed: 4615 and 8331 carry that note). Deleting the alternation is inert
on this corpus. The claim is true.

### Nine new strings I invented. **Five still delist a plainly-paid study.**

| # | input | result |
|---|---|---|
| N1 | `Participants earn $40 upon completion of the study.` | 40/40, $40/hr ✅ |
| N5 | `You will receive $25 for the session.` | 25/25 ✅ |
| N6 | `You can earn up to $300 in compensation.` | null/300 ✅ |
| N7 | `Eligible participants earn a $20 gift card after the interview.` | 20/20 ✅ |
| **N2** | `You are eligible to earn $75 for completing all study visits.` | **null/null, low, "Pay unclear"** ❌ |
| **N3** | `Participants have the opportunity to earn $50 for completing the survey.` | **null/null, "Pay unclear"** ❌ |
| **N4** | `Participants will be able to earn $100 total for the three visits.` | **null/null, "Pay unclear"** ❌ |
| **N8** | `Participants are able to earn $60 for attending both sessions.` | **null/null, "Pay unclear"** ❌ |
| **N9** | `Each participant is eligible to earn $10 per completed survey, up to $50.` | **null/null, "Pay unclear"** ❌ |

`"You are eligible to earn $75 for completing all study visits"` is not exotic
— it is boilerplate IRB compensation language, and the only condition on the
money is **completion**, which the same doc comment explicitly identifies as
guaranteed pay three lines earlier (`"a completion bonus of $500 for
completing all visits"` #11321 is excluded on exactly that reasoning). The
stated principle — *"something must grant the OPPORTUNITY to earn, rather than
merely describe earning as the mechanism of payment"* — does not separate
these cases. `eligible to earn $X for completing all visits` grants an
opportunity in precisely the same grammatical sense.

**This is not a regression** — round 2's own R1 write-up recommended keeping
`opportunity/chance/eligible/able to earn`, and the fix agent followed it.
It is the recommendation's blind spot, inherited. But the brief asked whether
R1 is dead, and the honest answer is that its **worst** symptom is dead and
its **mechanism** is not. A $75 study still vanishes off the ranked board; it
just says "Pay unclear" instead of "Unpaid" while doing it. R2 is what bought
that improvement, and R2 is real: every one of N2/N3/N4/N8/N9 returns
`null`/`low`, never `0`/`medium`.

### R2 is correct but unreachable on this corpus

No record hits the all-contingent branch (verified: zero records carry the
*"every stated amount is contingent"* note). The branch's only exercise today
is synthetic. That is fine — it is a guard, not a feature — but "no records
changed" is a consequence of unreachability, not of the change being safe. The
five probes above are what actually demonstrate it works.

### Two things the narrowing did not fix, found while probing

**(a) The contingent span is still word-order dependent — F8 is fixed for
#11899's phrasing only.** The span runs trigger → end of sentence, so money
stated *before* the trigger is never excluded:

| input | guaranteed |
|---|---|
| `Payment is $15. Participants may earn an additional $5 depending on their accuracy.` | **$20** ❌ (contingent $5 counted) |
| `Payment is $15. Depending on their accuracy, participants may earn an additional $5.` | $15 ✅ |

Round 2 criticised R1 for turning on "nothing but word order and inflection".
That criticism applies unchanged to the mechanism that survived; the direction
just flipped from zeroing-out to over-counting. #11899 is fixed because its
`$5` happens to follow `opportunity to earn`.

**(b) Two of the four surviving alternations are effectively dead.**
`(?:depending|based) on (their |task )?(performance|accuracy)` cannot fire
usefully, because the natural construction puts the amount first:

`Bonus of $5 depending on your accuracy.` → **$5** ·
`… depending on their accuracy.` → **$5** ·
`… depending on accuracy.` → **$5** ·
`… depending on participant performance.` → **$5**

All four keep the money. The fix report's stated decision not to widen
`their|task` to `your` is therefore moot — the alternation does not work for
*any* pronoun in amount-first phrasing. The regex's real working surface is
`opportunity|chance|eligible|able to earn`, which is exactly the over-broad
half.

## 3. The four F2 rows, adjudicated against the raw strings

| id | comp string | duration string | body | shown | verdict |
|---|---|---|---|---|---|
| **12766** | `$50 per laboratory visit; $10 for parent questionnaires; $10 for child questionnaires` | `2 hours (in the form of two 1-hour visits)` | *"two laboratory visits, each lasting approximately 60 minutes"* | **$60.00** | ✅ `2 × $50 + $20 = $120 / 2h`. Only the per-visit component is doubled — `2 × $70` would have been $70/hr. Count 2 from `duration.sessionCount`. Conservative: if the questionnaires were also per-visit it would be $70/hr. |
| **8874** | `$30 per visit` | `Two visits, each about 2 hours, completed within two weeks.` | *"complete two sessions at Day 1 … and around Day 14"* | **$15.00** | ✅ `2 × $30 = $60 / 4h`. Bucket `low` → `ok`, so it is now visible to a reader filtering out `low`. |
| **4618** | `compensated up to $225 over 3 visits (1 visit a year)` | `Visits last around 3-3.5 hours` | (body repeats both) | **$21.43** | ✅ rate. `$225 / (3.5 × 3 = 10.5h)`. Honest band is **$21.43–$25.00** (3h–3.5h per visit); the ceiling-over-ceiling convention this file documents picks the conservative end. Round 1's $23.08 used the 3.25h midpoint — both inside the band. **But see §5: the card is now self-contradictory.** |
| **4620** | `You will be compensated $50 for each visit to the imaging center.` | `Visits last around 1.5 hours` | *"2 visits to the imaging center"* | **$33.33** | ✅ rate, and now correctly classified `single-visit` rather than right by coincidence. `guaranteedTotal` is honestly `null` (neither parsed field states the count). Displayed total is still `$50`; the body says $100. Pre-existing, unchanged. |

**Containment check.** I instrumented `payIsPerVisit` and `hoursArePerSession`
across all 86 records including the 7 dropped duplicates:

- `payIsPerVisit` fires on exactly **3**: 12766, 8874, 4620.
- `hoursArePerSession` fires on exactly **3**: 4618, 4620, 8872 (8872 returns
  `UNKNOWN` before scope is consulted — it has no parsed hours).
- Twelve records carry a `perVisit` and are correctly blocked by the
  **`guaranteedMax === null`** condition — 9815 ($620), 8458 ($425), 9821
  ($550), 4613 ($420), 6995, 5436, 6745, 4624, 4626, 11899, 11321, 8876. That
  condition is doing exactly the job its comment claims, and it is what keeps
  the F1 fixes from being scaled a second time.
- The `sessionCount !== null` veto blocks per-session scaling on 11075, 8420,
  8338, 6987, 5436; the whole-study vocabulary blocks 9959, 6745, 4626, 4624,
  8420, 5436. Both brakes are load-bearing on real records, not decorative.
- `pickCount`'s **disputed** path never fires on this corpus (no record has
  both a `compensation.visitCount` and a `duration.sessionCount` that
  disagree), so its `confidence: 'low'` and its explanatory note are untested
  against real data — and would be discarded anyway (§5).

## 4. Regression sweep — all 79 survivors, every rate

I built the round-2 baseline from the round-1 row-by-row table with the round-2
"FIXED" overrides applied (9815, 4611, 4613, 8458, 6987, 8872, 11899, 11315,
8402, 4607, 10128), and diffed it against the shipped snapshot. Both sides have
the same 79 ids.

```
id      round2   now      intended?
4618    64.29    21.43    INTENDED F2
8874    7.5      15       INTENDED F2
12766   35       60       INTENDED F2

rates moved: 3   unintended: 0
```

**Three rates moved. All three are intended F2 targets. Zero unintended
movement.** 4620, the fourth target, correctly did not move ($33.33 before and
after) while changing basis from accidental to `single-visit`.

Corroborating structural evidence, independent of the baseline table: of the 79
survivors, **75 use `whole-study`, `stated-hourly` or `unknown`** — the paths
that existed before this round and are arithmetically identical to the old
formula. The only four records on a new basis are exactly 12766, 8874
(`per-visit-pay-scaled`), 4618 (`per-session-hours-scaled`) and 4620
(`single-visit`). The blast radius is provably four records.

Also unchanged: dedupe (same 7 groups, same survivors), section counts
(48/15/16), page count (81), and `guaranteedMin/Max` on every record other than
the ones already recorded in earlier rounds.

## 5. NEW DEFECT — the reconciliation is invisible, and three cards now contradict themselves

`reconcileEffectiveHourly` returns six fields. `normalize.ts:455` uses **one**:

```ts
const reconciled = reconcileEffectiveHourly(compensation, duration);
const effectiveHourly = reconciled.rate;
```

`reconciled.notes`, `.basis`, `.visitCount`, `.guaranteedTotal` and
`.confidence` are computed and thrown away — `grep -n "reconciled\." normalize.ts`
returns only the comment and the `.rate` line. Consequences:

**(a) #4618's card is incoherent by 3x, with no explanation.** Rendered:

> Pay **up to $225** · Time **~3h–3.5h** · **$21.43 per hour**

`225 / 3.5 = $64.29`. A reader who checks the site's arithmetic against itself
concludes the rate is broken. The reconciler generated the sentence that
resolves it — *"the stated 3.5 hours is one visit; the pay covers all 3
visits, so the rate is over 10.5 hours"* — and `normalize.ts` dropped it. The
Time line also states no visit count and no span, so the card conceals that
this is **3 visits over 3 years** (`1 visit a year`). Mitigation: 4618 is
expired and sits inside the collapsed `<details>`.

**(b) #12766 and #8874 show a total below the one their rate is computed on.**
12766: "at least $70 ($50 per visit)" · "2 sessions, ~2h" · **$60/hr**
(`70/2 = 35`). 8874: "at least $30 ($30 per visit)" · "2 sessions, ~4h" ·
**$15/hr** (`30/4 = 7.5`). Both are *reconstructable* by a reader who
multiplies the per-visit figure by the session count the card also prints, so
these are milder than 4618. The fix report discloses this and explains the
`normalize.test.ts:793` gate that blocks the write-back — the reasoning is
sound and the handoff (`reconciled.guaranteedTotal` = 120 / 60 / null) is
genuinely ready. But the disclosure covers 12766/8874/4620 and **not 4618**,
which is the one where the visible numbers overstate rather than understate.

**(c) The disputed-count warning can never reach a reader.** When
`compensation.visitCount` and `duration.sessionCount` disagree,
`reconcileEffectiveHourly` sets `confidence: 'low'` and emits a note saying
which reading was taken. Both are discarded. The first record that trips this
path will silently show a rate chosen by a tie-break the reader cannot see.

This is a **new** defect: before this round there was nothing to surface.

## 6. F9 / #8331 — the "hook" does not reach it

The fix report says F2 "gives F9 its hook: its duration would need
`hoursArePerSession` to fire on `40-50 minutes`, which only a content-derived
session count can license." That is backwards. `hoursArePerSession` opens with

```ts
if (dur.sessionCount !== null) return false;   // hard veto
```

so supplying 8331 with a session count **guarantees** the per-session path
cannot fire. The reconciler is structurally incapable of fixing 8331: its
duration string contains no visit noun and no `each/per`, and the only thing
that would make it scalable is the very field that vetoes scaling. The fix must
land in `parse-duration.ts` (recognise two sessions and multiply there), where
F1's fixes live. Calling this a hook overstates what shipped.

Meanwhile 8331 is unchanged for a third consecutive round: **$96.00 at live
rank 2**, `compensation.confidence: 'low'`, in the `great` bucket, on `40-50
minutes` that its own body (*"Each participant will complete two sessions"*)
and its own compensation string (`$30` first session + `$50` second = `$80`)
both prove is per-session. Real rate **$48.00–$60.00**.

## 7. Latent defect found while probing (pre-existing, unreported in rounds 1–2)

**A stated guaranteed amount is silently discarded whenever a later "up to $X"
appears, and the ceiling is reported as the whole payment:**

| input | parsed |
|---|---|
| `You will be paid $20, plus up to $10 more.` | `null / **10**` |
| `You will be paid $20. You may also receive up to $10 more.` | `null / **10**` |
| `Participants receive $100 and up to $25 in travel reimbursement.` | `null / **25**` |

The last one is the realistic shape, and it reports a **$100 study as "up to
$25"** — a 4x understatement that would bury it near the bottom of the board.
This is not from this round (the ceiling logic was untouched; only
`CONTINGENT_TRIGGER_RE` and the all-contingent branch changed) and it does not
fire on the current 86 — I checked every compensation string for a dollar
amount preceding an `up to $`, and the only three hits (6745, 4626, 4624) are
the raffle-tagged records whose $165 ceilings round 1 already verified. Given
the twice-daily refresh, recording it is the point.

## 8. Every previously-fixed finding, re-confirmed

| # | claim | now | verdict |
|---|---|---|---|
| **F1** | 9815 44h/$14.09 · 4611 58h/$14.14 · 4613 27h/$15.56 · 8458 21h/$20.24 | all four exact | ✅ **HOLDS** |
| **F3** | 4607 = $420 + provenance note (not $840) · 8402 = $12.00/hr | `gMax 420`, note *"pay extracted from study description, not the compensation field"* · 8402 `$12` ranked | ✅ **HOLDS** |
| **F5** | 8872 unrankable | `effectiveHourly: null`, hours `null`, `gMax 140` preserved, sits 6th in the unrated block | ✅ **HOLDS** |
| **F8** | 11899 = $10.91 | `gMax 10`, `visitCount 2`, `$10.91/hr` | ✅ **HOLDS** (for this word order — §2a) |
| **F16** | 11315 exactly $60.00 | `=== 60` under strict equality | ✅ **HOLDS** |
| **F2** | 12766/8874/4618/4620 | $60 / $15 / $21.43 / $33.33 | ✅ **FIXED** (rates; totals still short) |
| **F11** | unrated ordered by money | 11321 $1,000 first; survives client re-sort | ✅ **FIXED** |
| **F9, F4, F6, F7, F10, F12, F13, F14, F15, F17, F18** | — | untouched | unchanged from round 2 |

**Running score: 8 fixed, 1 half-fixed (F15), 2 partial (F13, F18), 7
untouched.** No fix from any prior round was regressed.

## 9. Final verdict

**Is the top of the board now trustworthy enough that a reader acting on rank
order would not be materially misled?**

**No. One row, and it is rank 2.**

Everything else at the top is now defensible. The reader who acts on ranks
1, 3, 4, 5, 6, 7, 8, 9 gets what the badge promises, and #12766 — the audit's
original "best deal on the board, buried at rank 10" case, named in two
consecutive briefs — is finally in the right place at rank 4. The regression
sweep is the cleanest of the three rounds: three rates moved, three were meant
to.

The remaining rows, with the size of the lie:

| row | id | shown | defensible | overstatement |
|---|---|---|---|---|
| **rank 2** | **8331** | **$96.00/hr** | **$48.00–$60.00/hr** | **1.6–2.0x** |
| rank 10 | 8338 | $30.00/hr | $28.24/hr | 1.06x (displaces 9953 from rank 10) |

Concretely: a reader who trusts the ordering takes #8331 as the second-best
deal on the site, shows up for **two** sessions of 40–50 minutes each for $80,
and earns $48–$60/hr — a rate that belongs at rank 4–6, below three studies
currently ranked beneath it. Nothing on the card warns them; the compensation
parse is `confidence: 'low'` and low confidence still ranks (F10), so the
caveat is prose under a green badge they have already acted on. This is the
same sentence round 2 wrote about the same study.

Two further things a reader can see and should not:

- **#4618's card contradicts itself by 3x** ("up to $225", "~3h–3.5h",
  "$21.43/hr"). The rate is the honest one; the card gives no way to know that.
  Expired, so behind a collapsed block — but it leads that block's arithmetic
  credibility.
- **#12766 and #8874 print a guaranteed total one visit short** of the total
  their own rate is computed on. Disclosed, handed off, still shipping.

And one thing a reader cannot see at all: `"You are eligible to earn $75 for
completing all study visits"` — ordinary consent-form English — still renders
as **"Pay unclear"** and drops off the ranked board. The site will not lie
about that study's rate. It will simply fail to list it.

**The single change that closes the most:** teach `parse-duration.ts` that
#8331's `40-50 minutes` is per-session (its compensation string names two
sessions and its body states them outright), and multiply there — *not* in
`reconcileEffectiveHourly`, whose `sessionCount` veto makes it structurally
unable to help. That fixes rank 2, the only materially wrong row left at the
top of the board. Second: spend the six fields `reconcileEffectiveHourly`
already returns and `normalize.ts` currently throws away.
