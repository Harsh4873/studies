/**
 * Composes the "am I a fit, and are you still recruiting?" email a visitor
 * sends to a study coordinator, plus the anti-harvesting helpers that keep
 * those coordinators' addresses out of the built HTML.
 *
 * ============================================================================
 * TWO NON-NEGOTIABLES
 * ============================================================================
 *
 * 1. THE BODY NEVER HIDES A DECLARED CONDITION.
 *    If the profile says "I am pregnant" and the listing screens out
 *    pregnancy, the generated email says so, in plain words, near the top.
 *    It would be trivial to raise the acceptance rate by omitting that - and
 *    it would be writing a lie on a stranger's behalf, to a research team
 *    whose exclusion criteria usually exist for participant safety. The
 *    disclosure block is built from the same parsed criteria the eligibility
 *    checker uses, so there is no code path in which a conflict is silently
 *    dropped from the message.
 *
 * 2. THE ADDRESS NEVER APPEARS AS PLAINTEXT IN THE BUILD OUTPUT.
 *    These are the personal @tamu.edu addresses of graduate students and
 *    coordinators who published them on a university recruitment page, not on
 *    a spam-harvestable mirror. `encodeEmailToken` / `decodeEmailToken` keep
 *    them out of the static HTML; the address is reassembled in the browser
 *    only after a deliberate click. See `src/components/ContactButton.astro`.
 *
 * Nothing here transmits anything. `buildInquiryEmail` returns a string; the
 * user's own mail client is what sends it, after they have read and edited it.
 */

import type { ParsedEligibility, Staleness, UserProfile } from '@/types.ts';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * The slice of a `StudyRecord` the composer needs.
 *
 * Declared structurally rather than as `StudyRecord` so the same function can
 * run on a full record at build time and on a small JSON blob embedded in a
 * `data-` attribute at runtime, without shipping the whole record to the
 * browser. `StudyRecord` satisfies this interface as-is.
 */
export interface InquiryStudy {
  title: string;
  irbNumber: string | null;
  url: string;
  contactName: string | null;
  contactEmail: string | null;
  expirationDate: string | null;
  isExpired: boolean;
  staleness: Staleness;
  eligibility: ParsedEligibility;
}

export interface InquiryEmail {
  subject: string;
  /** Plain text, `\n`-separated. The href carries the CRLF-encoded form. */
  body: string;
  /** Ready-to-use `mailto:` URL, fully percent-encoded. */
  href: string;
  /** Recipient, or null when the listing has no contact address. */
  to: string | null;
  /**
   * Conflicts the body discloses. Surfaced in the UI so the user sees what
   * they are about to send before they send it, rather than discovering it in
   * their outbox.
   */
  disclosures: string[];
  /**
   * True when the href is long enough that some mail clients may truncate it.
   * The UI promotes the "copy the message" fallback when this is set, rather
   * than letting a half-sent email look like a whole one.
   */
  isLong: boolean;
}

/** Longest title kept in the subject line before it gets an ellipsis. */
const SUBJECT_TITLE_MAX = 64;

/**
 * Length past which a mailto URL is no longer reliably safe. Outlook and
 * several OS handlers historically truncated around 2048 characters, and
 * percent-encoding roughly doubles a plain-text body (every space becomes
 * `%20`), so a ~1000-character message is already close to the edge.
 *
 * The prose below is written tight for this reason. When a message still goes
 * over - long titles and long URLs both push it there - `isLong` is set and
 * the UI steers the user to "copy the message text" instead of silently
 * handing them a draft that ends mid-sentence.
 */
const MAILTO_SAFE_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Percent-encoding
// ---------------------------------------------------------------------------

/**
 * Encode one mailto header value.
 *
 * `encodeURIComponent` leaves `! ' ( ) *` unescaped. They are legal in a
 * query, but Outlook and a couple of Android handlers treat `(` and `'` as
 * terminators in `?body=`, which silently truncates the message. Escaping
 * them costs nothing and removes the failure mode.
 *
 * Newlines are normalised to CRLF first, so every line break in the href
 * comes out as `%0D%0A` - the form RFC 6068 specifies and the only one every
 * client agrees on. A bare `%0A` renders as one run-on paragraph in several
 * desktop clients.
 */
export function encodeMailtoComponent(value: string): string {
  return encodeURIComponent(value.replace(/\r\n|\r|\n/g, '\r\n')).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// ---------------------------------------------------------------------------
// Address obfuscation
// ---------------------------------------------------------------------------

/**
 * Rotating XOR key. This is OBFUSCATION, NOT ENCRYPTION - anyone who reads
 * the bundled JS can reverse it in a minute, and that is fine. The threat
 * model is the bulk harvester that regexes `[\w.]+@[\w.]+` out of static HTML
 * at scale, not a targeted attacker. Against that, any transform that leaves
 * no `@` and no domain in the markup wins; against a targeted attacker,
 * nothing short of not publishing the address would work.
 */
const OBFUSCATION_KEY = [0x5b, 0x2d, 0x71, 0x13, 0x4a, 0xa7] as const;

/**
 * Turn an address into an opaque hex token safe to embed in a `data-`
 * attribute. Four hex digits per character so any BMP codepoint survives the
 * XOR without overflow.
 */
export function encodeEmailToken(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const key = OBFUSCATION_KEY[i % OBFUSCATION_KEY.length] ?? 0;
    out += ((value.charCodeAt(i) ^ key) & 0xffff).toString(16).padStart(4, '0');
  }
  return out;
}

/** Inverse of `encodeEmailToken`. Returns '' on malformed input. */
export function decodeEmailToken(token: string): string {
  if (typeof token !== 'string' || token.length === 0 || token.length % 4 !== 0) return '';
  let out = '';
  for (let i = 0; i < token.length; i += 4) {
    const code = Number.parseInt(token.slice(i, i + 4), 16);
    if (!Number.isFinite(code)) return '';
    const key = OBFUSCATION_KEY[(i / 4) % OBFUSCATION_KEY.length] ?? 0;
    out += String.fromCharCode(code ^ key);
  }
  return out;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Strip addresses out of free text before rendering it.
 *
 * Needed because upstream leaks addresses into fields that are not the email
 * field: study 8458 has `contact_name: "mpkj.engelen@ctral.org"`. Obfuscating
 * `contactEmail` alone would still have published that one in plaintext.
 */
export function scrubEmails(text: string | null | undefined, replacement = '[email hidden]'): string {
  if (!text) return '';
  return text.replace(EMAIL_RE, replacement);
}

/** True when the string looks like a bare email address rather than a name. */
export function looksLikeEmail(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value.trim());
}

// ---------------------------------------------------------------------------
// Body construction
// ---------------------------------------------------------------------------

function shortTitle(title: string, max = SUBJECT_TITLE_MAX): string {
  const clean = title.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:.\-\s]+$/, '')}...`;
}

function greeting(contactName: string | null): string {
  const name = (contactName ?? '').trim();
  // An address in the name field (study 8458) must not be echoed back as a
  // salutation - and would defeat the whole point of not printing it.
  if (!name || looksLikeEmail(name)) return 'Dear study team,';
  return `Dear ${name.replace(/\s+/g, ' ')},`;
}

function ageRange(e: ParsedEligibility): string {
  return e.maxAge === null ? `${e.minAge} and over` : `${e.minAge}-${e.maxAge}`;
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function hasFlag(e: ParsedEligibility, re: RegExp): boolean {
  return e.flags.some((f) => re.test(f));
}

/**
 * Things the profile positively confirms against a criterion the listing
 * actually states. Deliberately narrow: volunteering "I am not pregnant" to a
 * study that never mentioned pregnancy is oversharing health data with a
 * stranger, so a confirmation is only included when the listing screens for it.
 */
function buildConfirmations(e: ParsedEligibility, p: UserProfile): string[] {
  const out: string[] = [];

  if (p.age !== null) {
    const inRange = p.age >= e.minAge && (e.maxAge === null || p.age <= e.maxAge);
    if (inRange) out.push(`I am ${p.age}, within the ${ageRange(e)} age range in the listing.`);
  }
  if (e.requiresRightHanded && p.rightHanded === true) out.push('I am right-handed.');
  if (e.requiresMriSafe && p.mriSafe === true) {
    out.push('I know of nothing that would make me unsafe for MRI, subject to your own screening.');
  }
  if (e.requiresFasting && p.willingToFast === true) {
    out.push('I am willing to fast beforehand as the study requires.');
  }
  if (e.sexRestriction !== null && p.sex === e.sexRestriction) {
    out.push(`I am ${e.sexRestriction}, which matches the listing's stated criteria.`);
  }
  if (e.excludesCardiovascular && p.hasCardiovascularCondition === false) {
    out.push('I do not have a cardiovascular condition.');
  }
  if (e.excludesPregnancy && p.isPregnant === false) out.push('I am not pregnant.');
  if (e.excludesSeizure && p.hasSeizureHistory === false) {
    out.push('I have no history of seizures or epilepsy.');
  }
  if (hasFlag(e, /SONA \/ subject-pool/i) && p.isTamuStudent === true) {
    out.push('I am a Texas A&M student.');
  }
  if (hasFlag(e, /non-students only/i) && p.isTamuStudent === false) {
    out.push('I am not a Texas A&M student.');
  }
  return out;
}

/**
 * Things the profile declares that the listing screens for, excludes, or
 * treats as a safety contraindication.
 *
 * THIS FUNCTION IS THE HONESTY GUARANTEE. Every branch here produces a line
 * that goes into the email verbatim. Adding a condition to the profile means
 * adding it here too, or the composer will start writing quietly incomplete
 * messages.
 *
 * It fires on two kinds of signal:
 *   - a hard parsed criterion (`excludesPregnancy`, `requiresMriSafe`, ...)
 *   - an ambiguous mention the parser flagged but could not resolve, e.g.
 *     "pregnancy is mentioned but not clearly a criterion". If the listing
 *     mentions it at all and the user has declared it, the coordinator should
 *     hear it from the user rather than at screening.
 */
function buildDisclosures(e: ParsedEligibility, p: UserProfile): string[] {
  const out: string[] = [];

  // -- Age ------------------------------------------------------------------
  if (p.age !== null) {
    if (p.age < e.minAge) {
      out.push(
        `I am ${p.age}, which is below the minimum age of ${e.minAge} stated in the listing.`,
      );
    } else if (e.maxAge !== null && p.age > e.maxAge) {
      out.push(
        `I am ${p.age}, which is above the maximum age of ${e.maxAge} stated in the listing.`,
      );
    }
  }

  // -- Pregnancy ------------------------------------------------------------
  if (p.isPregnant === true && (e.excludesPregnancy || hasFlag(e, /pregnan|lactat/i))) {
    out.push('I am currently pregnant, which I understand the listing screens for.');
  }

  // -- Cardiovascular -------------------------------------------------------
  if (
    p.hasCardiovascularCondition === true &&
    (e.excludesCardiovascular || hasFlag(e, /cardiovascular|cardiac|heart/i))
  ) {
    out.push(
      'I have a cardiovascular condition (for example heart disease or high blood pressure), which the listing screens for.',
    );
  }

  // -- Seizure history ------------------------------------------------------
  if (
    p.hasSeizureHistory === true &&
    (e.excludesSeizure ||
      hasFlag(e, /seizure|epilep/i) ||
      // TMS/tDCS listings often do not name seizures, but seizure history is
      // a standard contraindication for non-invasive brain stimulation.
      hasFlag(e, /brain stimulation/i))
  ) {
    out.push('I have a history of seizures, which I understand the listing screens for.');
  }

  // -- MRI / implanted metal ------------------------------------------------
  if (
    p.mriSafe === false &&
    (e.requiresMriSafe || hasFlag(e, /MRI|magnet|implanted medical device/i))
  ) {
    out.push(
      'I cannot undergo MRI safely (metal in my body or an implanted device), which I understand may rule me out of any scanning.',
    );
  }

  // -- Handedness -----------------------------------------------------------
  if (p.rightHanded === false && e.requiresRightHanded) {
    out.push('I am not right-handed, and I see the listing asks for right-handed participants.');
  }

  // -- Fasting --------------------------------------------------------------
  if (p.willingToFast === false && e.requiresFasting) {
    out.push('I would prefer not to fast, and I see the study involves a fasting requirement.');
  }

  // -- Sex ------------------------------------------------------------------
  if (e.sexRestriction !== null && p.sex !== null && p.sex !== e.sexRestriction) {
    out.push(
      p.sex === 'other'
        ? `The listing states it enrols ${e.sexRestriction} participants only; I would rather let you decide whether I fit that criterion.`
        : `The listing states it enrols ${e.sexRestriction} participants only, and I am ${p.sex}.`,
    );
  }

  // -- Student status -------------------------------------------------------
  if (p.isTamuStudent === true && hasFlag(e, /non-students only/i)) {
    out.push('I am a Texas A&M student, and I see the listing asks for non-students.');
  }

  return out;
}

/** The "is this posting even live?" paragraph, tailored to what we know. */
function recruitmentQuestion(study: InquiryStudy): string {
  const expiry = formatDate(study.expirationDate);
  if (study.isExpired && expiry) {
    return `First: is this study still recruiting? The listing shows a recruitment end date of ${expiry}, which has passed, though the posting is still up, so I could not tell whether it has closed.`;
  }
  if (study.staleness === 'stale') {
    return 'First: is this study still recruiting? The listing has not been updated in a while and does not say whether enrolment is still open.';
  }
  return 'First: is this study still recruiting? The listing does not show current enrolment status, so I wanted to check before going further.';
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compose the inquiry email for one study and one profile.
 *
 * Pure and side-effect free - it returns strings. Nothing is sent, stored, or
 * logged. Safe to call during SSR (it is, on the study detail page, to render
 * the preview) and in the browser.
 *
 * Unanswered profile fields simply produce no line: the email neither claims
 * nor denies anything the user did not tell us.
 */
export function buildInquiryEmail(study: InquiryStudy, profile: UserProfile): InquiryEmail {
  const e = study.eligibility;
  const title = study.title.replace(/\s+/g, ' ').trim();
  const irb = study.irbNumber?.trim() || null;

  const subject = irb
    ? `Participant interest - ${shortTitle(title)} (${irb})`
    : `Participant interest - ${shortTitle(title)}`;

  const confirmations = buildConfirmations(e, profile);
  const disclosures = buildDisclosures(e, profile);

  const lines: string[] = [];

  lines.push(greeting(study.contactName));
  lines.push('');
  lines.push(
    `I am a graduate student at Texas A&M University interested in volunteering for your study, "${title}"${
      irb ? ` (${irb})` : ''
    }, which I found on the Aggie Research Volunteers listings.`,
  );
  lines.push('');
  lines.push(recruitmentQuestion(study));

  if (confirmations.length > 0) {
    lines.push('');
    lines.push('From the criteria in the listing, I can confirm the following about myself:');
    for (const c of confirmations) lines.push(`- ${c}`);
  }

  // Disclosures come before the ask, never buried after it.
  if (disclosures.length > 0) {
    lines.push('');
    lines.push('I want to raise these up front rather than have them surface at screening:');
    for (const d of disclosures) lines.push(`- ${d}`);
    lines.push('');
    lines.push('If any of that rules me out, no problem - better to know now than waste your time.');
  }

  if (e.requiresSpecificCondition) {
    lines.push('');
    lines.push(
      `The listing says the study enrols people with ${e.requiresSpecificCondition}. How do you confirm that, and would I need documentation?`,
    );
  }

  lines.push('');
  lines.push(
    'If you are still enrolling, what would the next step be? I am happy to complete a screening questionnaire or phone screen.',
  );
  lines.push('');
  lines.push(`Listing: ${study.url}`);
  lines.push('');
  lines.push('Thank you for your time,');
  lines.push('');
  lines.push('[your name]');
  lines.push('[your email or phone]');

  const body = lines.join('\n');
  const to = study.contactEmail?.trim() || null;

  // The address is placed raw rather than percent-encoded: `@` and `.` are
  // legal in a mailto path, and encoding `@` as %40 breaks a handful of older
  // handlers. Only the query values are encoded.
  const query = `subject=${encodeMailtoComponent(subject)}&body=${encodeMailtoComponent(body)}`;
  const href = `mailto:${to ?? ''}?${query}`;

  // Never truncate. A clipped email is worse than a long one, and the UI has
  // a copy-the-text fallback for exactly this case.
  const isLong = href.length > MAILTO_SAFE_LENGTH;

  return { subject, body, href, to, disclosures, isLong };
}
