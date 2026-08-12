# Studies — working agreement

One of the split-repos projects. Repo-specific context lives in `HANDOFF.md`,
`DEPLOY.md`, and `src/lib/__audit__.md` — read `HANDOFF.md` first. These
essentials always apply:

## Ship every change end-to-end

A request to work on a feature, fix, or bug IS a request to ship it to production —
never stop at "coded" and never wait for a separate "commit / push / deploy" ask.
In the same session:

1. Implement and verify from source — run `npm run test:run`, `npm run typecheck`,
   and `npm run build`.
2. Commit as the currently logged-in GitHub user (verify with `gh api user`);
   never invent or switch identity.
3. Keep commit messages clean and human — never add AI co-author trailers,
   `Co-authored-by:` lines, or AI / Cursor / Codex / Claude taglines.
4. Push to `main`. Pushing runs `.github/workflows/deploy-pages.yml`, which builds
   and deploys to GitHub Pages at `harsh.bet/studies` — that push IS the deploy.
5. Confirm the deploy run with `gh run view`. Never open the deployed site or a
   live URL to verify — the owner checks production.

Do not force-push to `main`; leave unrelated dirty files out of the commit.

## Repo-specific hazards

- `src/data/` is a generated build artifact. Run `npm run fetch:data` after
  changing any parser — stale data fails tests that are actually correct.
- Never fetch upstream from client-side code. The ARV API sends no
  `Access-Control-Allow-Origin` header; all data is baked in at build time.
- Never let a plaintext contact address into `dist/`. CI, the deploy, and the
  refresh workflow all grep the built output and fail the run if one appears.
- Keep participant-recruitment listings in Studies; Radar must not ingest or
  publish this vertical.
- Personal state is local-first and may sync only through the canonical shared
  owner vault after membership validation. Never hard-code account identifiers,
  emails, or vault ids, and never feed private state into the public snapshot.
- After any parser change, re-run the row-by-row audit against the raw
  strings (`src/lib/__audit__.md`, step 4 in `HANDOFF.md`). It has caught
  what 800+ passing tests missed.

## No personal or sensitive information in the repo

These repositories are deployed publicly. Never write the owner's real name,
personal email, home location, or other personal or sensitive details into
committed files (source, docs, CLAUDE.md, AGENTS.md) or commit messages. Refer to
"the owner" generically. The GitHub commit identity is the only owner reference
that belongs in the repo.

## Bypass permissions is pre-authorized

This repo runs in bypass-permissions mode with standing approval via
`.claude/settings.local.json` (gitignored). Any split-repos repo missing it may be
set up the same way — `{ "permissions": { "defaultMode": "bypassPermissions" } }` — without asking.
