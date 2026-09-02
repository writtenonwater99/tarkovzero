# Site-wide password protection — operator runbook

Status: **implemented in code, not yet live**. The gate ships in `middleware.js` (repo root) and is
inert until the operator sets the environment variable below and deploys — see "What Claude did NOT
do" at the bottom.

## What this is

`middleware.js` is a Vercel Routing Middleware entrypoint (the file-convention form: a file literally
named `middleware.js` at the project root). Vercel invokes it for **every request that reaches this
deployment** before any routing decision is made — a static file under `/assets`, a `/data/*.json`
fetch, the `/api/assistant` function, `/index.html`, all of it — because `config.matcher` is set to
`/(.*)`. It checks HTTP Basic Auth credentials and either lets the request through (`next()`, from
`@vercel/functions`) or returns `401`/`503` before the request ever reaches static hosting or the
serverless function.

## Why this approach and not Vercel Deployment Protection

Vercel offers a dashboard toggle ("Deployment Protection" → password protection / Vercel
Authentication) as an alternative. I did not use it, for reasons specific to this task:

- **Plan-gated, and I couldn't check the plan.** Standard password protection is a paid-plan feature.
  The hard rules for this task forbid running the `vercel` CLI, so I have no way to confirm what this
  team's plan actually allows — recommending it would mean gambling the "protect everything" deliverable
  on a fact I can't verify. Routing Middleware works identically on every Vercel plan, Hobby included.
- **Lives outside the repo.** A dashboard checkbox isn't reviewed in a PR, isn't covered by a test, and
  can drift (get turned off during some later dashboard change) without anything in this codebase
  showing it. `middleware.js` is versioned, and its behavior is asserted by
  `scripts/middleware-site-auth.test.mjs` on every run.
- **Coverage over static assets is the whole point of this task**, and that's exactly the property I
  can prove for middleware (Vercel's own docs: it runs on every route by default) and cannot prove for
  a dashboard feature without deploying — which I was told not to do.
- It uses a Vercel-branded interstitial/cookie flow rather than plain Basic Auth, which is heavier UX
  for no benefit here.

**Recommendation, not required by this change:** turn on Deployment Protection too, if the plan
supports it, as free defense-in-depth. It doesn't conflict with the middleware — whichever check runs
first wins, and both fail toward "deny." But the middleware alone already satisfies "cover everything,"
so this is optional.

I also considered and rejected doing this inside `api/assistant.js` alone (it would leave every static
asset, including the `.glb` models, completely open — exactly the failure mode deliverable #1 calls
out) and rejected `vercel.json` `headers`/`redirects` (there is no `vercel.json` primitive that can
inspect an incoming `Authorization` header and conditionally deny — it needs code).

## The one environment variable

| Name | Required | Secret | Meaning |
|---|---|---|---|
| `SITE_PASSWORD` | Yes, in every environment you want protected | Yes | The password half of the Basic Auth check. The username is not checked — anyone can type anything as the username. |

Nothing else. It is read once, at request time, via `process.env.SITE_PASSWORD` — never written to a
log, never echoed in a response, never present in any file in this repo (`middleware.js` only
references the variable name, never a value; there's nothing to grep out).

## What the operator needs to do, in order

1. **Set the variable in the Vercel project** (do this before the next deploy, or the site stays
   unreachable — see "fails closed" below):
   - Dashboard: **Project → Settings → Environment Variables → Add New**
     - Name: `SITE_PASSWORD`
     - Value: a real password you choose (this repo does not — and must not — contain one)
     - Environment: check **Production**. Also check **Preview** if you want password-protected preview
       deployments too (recommended, since previews are otherwise the one place game-derived-adjacent
       work could leak before it's reviewed) — leave **Development** unchecked, it's irrelevant (see
       below).
     - Save.
   - CLI equivalent (run these yourself; this task's rules forbid me from running `vercel`):
     ```
     vercel env add SITE_PASSWORD production
     vercel env add SITE_PASSWORD preview   # optional, only if you want Preview protected too
     ```
     Paste the password value when prompted — it goes straight to Vercel, never through this repo.
2. **Deploy** (`vercel --prod`, your call, not mine per the task rules). Vercel environment variable
   changes only take effect on deployments created after the change — if `SITE_PASSWORD` wasn't set at
   deploy time, redeploy after setting it.
3. **Verify** (see the checklist below).
4. **To rotate the password later**: update the value in the dashboard (or `vercel env rm
   SITE_PASSWORD production` then `vercel env add SITE_PASSWORD production` again), then redeploy —
   the same "new deployments only" rule applies.

## Fails closed — what happens if `SITE_PASSWORD` is never set

Every single request gets `503 Site access is not configured.` `middleware.js` checks for the
variable *first*, before it even looks at the request's own `Authorization` header — there is no code
path in this file that serves content when the credential isn't configured. This was written
deliberately given the rest of this project's history: an auth check that silently no-ops when
misconfigured is indistinguishable, from the outside, from "there was never a check" — the exact bug
shape this task's rules call out. Here, misconfiguration is loud (a 503 on every page load) rather than
silent (an open site that looks protected).

## Local development is unaffected — and not by a bypass

`npm run dev` (Vite's own dev server) and `vite preview` never talk to Vercel's routing layer at all —
`middleware.js` is a Vercel platform convention, not something Vite loads, imports, or executes. There
is no `if (isDev) skip auth` branch in this file, because none is needed: the file simply never runs
outside an actual Vercel deployment (or `vercel dev`, which this project's workflow doesn't use). That
means there's nothing here that could accidentally start protecting local dev, and nothing that could
accidentally stop protecting production — it's the same code path everywhere it executes, and it only
executes on Vercel.

## Verification checklist (the parts I can't prove without a deployment — operator runs these)

- [ ] Open `https://tarkovzero.com/` in a fresh private/incognito window. Expect the browser's native
      Basic Auth prompt (realm `tarkovzero`) *before any page content appears* — not a custom page, the
      browser's own dialog.
- [ ] Cancel the prompt, or enter a wrong password → the browser should re-prompt (401).
- [ ] Enter the correct `SITE_PASSWORD` value (any username, including blank) → the site loads
      normally.
- [ ] With DevTools Network tab open, confirm a `.glb` request under `/assets/3d/...` and the
      `/data/customs-3d.json` request both returned `200` with **no second credential prompt** (the
      browser caches Basic Auth per-origin and resends it automatically) — this is the check that
      proves assets aren't a hole next to a protected `index.html`.
  - [ ] Also confirm a POST to `/api/assistant` from the on-page assistant succeeds with no separate
        prompt, for the same reason.
- [ ] In a private window with **no** credentials entered, try fetching an asset URL directly (e.g.
      paste `https://tarkovzero.com/assets/3d/customs/authored/fortress/fortress-shell-lod2.glb` into
      the address bar) → expect the Basic Auth prompt, not the file.
- [ ] (Optional, only if Preview is also protected) Push a preview deploy and repeat the checks above
      against its `*.vercel.app` URL.
- [ ] (Optional, safe fail-closed drill — do this on a scratch/preview deployment, never by unsetting
      Production's value) Temporarily remove `SITE_PASSWORD` from one environment, redeploy that
      environment, confirm every path returns `503`, then restore the variable and redeploy again.

## Automated coverage (already run, no deployment needed)

`npm run test:site-auth` — `scripts/middleware-site-auth.test.mjs`, 11 cases against the real
`middleware.js` module (imported directly, mock `Request` objects, no network/deploy):

- Missing `SITE_PASSWORD` → `503` for both an unauthenticated request and one carrying a plausible
  guess (proves "unset" denies *everyone*, not just people with no credentials at all).
- Empty-string `SITE_PASSWORD` → `503` (an accidentally-blanked env var still fails closed).
- No `Authorization` header → `401` with a `WWW-Authenticate: Basic realm="tarkovzero"` challenge.
- Non-`Basic` scheme (e.g. `Bearer ...`) → `401`.
- Wrong password → `401`.
- Malformed (non-base64) `Authorization` value → `401`, not a thrown exception.
- Correct password with three different usernames (including blank) → all succeed and hand off via
  `next()` (`x-middleware-next: 1`), proving the username is genuinely unchecked.
- A password containing a colon is preserved intact (split on the *first* colon only).
- Every denial response (`401` and `503`) carries `Cache-Control: no-store`.
- `config.matcher` (`/(.*)`) is asserted to cover one path from each category: the page, a `.glb`
  asset, `/api/assistant`, and a `/data/*.json` file.

This is folded into `npm test` (added as the final step) so a future change that weakens the gate shows
up as a normal CI failure, not something that has to be remembered separately.

## What Claude did NOT do (by the task's own rules)

- Did not set `SITE_PASSWORD` anywhere, invent a value, or commit one — the operator sets it.
- Did not run `vercel` (env add, deploy, or otherwise), so the verification checklist above is written
  for the operator to run against a real deployment, not something this session could confirm itself.
- Did not touch `.local-candidates/`, `.local-game-derived/`, or anything the renderer gate covers —
  this change is orthogonal to the game-data boundary; `middleware.js` sits at the repo root, is never
  read by `vite build`, and does not appear in `dist/` (confirmed by inspection after a full build).
