# Next.js / Supabase migration

Status: private PostgreSQL schema and Storage are provisioned; the supplied snapshot and all seven original images have been imported and verified under write freeze. Protected Vercel Preview is READY with Singapore functions and passed cloud smoke checks. Live Google/account/workflow/load/restore acceptance and explicit cutover remain outstanding; no working Production deployment or promotion is authorized. User confirmed Q1–Q10, including free-first, fresh pre-production target, write freeze and new QR. Preserve the old GAS/Sheets/Drive system as read-only rollback evidence. Do not delete it or make any source/bucket public.

## Architecture and preserved contracts

The current UI is served by Next.js route handlers; it is **not a React component rewrite**. `tools/build-web.mjs` makes narrow transport/canonical/image-delivery changes to the preserved SPA. The Node backend executes trusted source-controlled domain services in per-request `vm` contexts; `vm` is an isolation mechanism, not a sandbox for untrusted code. PostgreSQL repositories replace Sheet reads/writes. No running GAS, Sheet or Drive dependency remains.

Each original managed table maps to a private `crs` table with lossless JSONB records and generated typed keys, constraints and relational foreign keys. This transitional representation deliberately preserves exact enum/ID/Operation JSON behavior. Domain code retains physical quantity=1, one active workflow per asset, pending hold, role/status checks, last active admin protection, row versions, immutable checkout checklist, soft deletion and Bangkok business dates. SQL rejects hard deletes, History edits and duplicate email/serial/active borrowing. Historical History references are evidence, not live foreign keys.

Every domain request acquires a PostgreSQL transaction-scoped advisory lock **before** authoritative reads, using READ COMMITTED. Projection, counters, History and Operation commit/rollback together. Free-tier connections are capped at one per warm instance; no named prepared statements/session-level locks. This deliberately favors legacy correctness over throughput. Load/performance acceptance is still required.

Auth remains the current Google popup + six-digit confirmation UX, not Supabase Auth. Backend verifies Google RS256 signature, issuer, audience/azp, expiry, nonce, verified authoritative email and exact allowed domain/Workspace hd. Browser poll/session proofs, OTP HMAC, five failures, one-time activation, absolute TTL and current Users checks remain. No auto-provision. Existing sessionStorage/optional remember-localStorage behavior is retained; server session records are hashed, and Google tokens are never persisted or exposed. New domain forces fresh sign-in. Configure Google's Web OAuth client, **not** a public Supabase Auth provider.

All QR/share URLs derive from explicit `WEB_APP_URL`; old Google `/u/0/`, `/u/1/`, `/u/2/` browser routes cannot become a new link base. New stickers must be generated after the chosen Vercel domain is stable. No redirect bridge is required because the user confirmed no production QR exists.

## Source inventory and limits

The supplied 2026-10-05 workbook and image ZIP were read without modifying them. Preview produced:

| Table | Operational rows |
| --- | ---: |
| Equipment | 3 |
| Users | 7 |
| Borrow | 0 |
| Categories | 13 |
| IncludedItems | 8 |
| BorrowItems | 0 |
| History | 37 |
| Operations | 27 |
| Settings | 4 |
| Sequences | 7 |
| SchemaMigrations | 3 |

109 operational rows; 120 original rows archived. One malformed Users row is quarantined (never authorization); five legacy tables with ten rows are archive-only. Admin can read the archive, including original cell values, without editing Sheet data manually. Duplicate keys, live FK failures, unsafe counters, bad operation hashes or missing current image bytes block the importer.

All 27 Operations are COMPLETED and retain their exact original payload/result JSON strings and SHA-256 hashes; each has exactly one corresponding History row. Ten additional historical rows remain. Sequence gaps/high-water values are retained. Current images: three original PNGs, 6,423,259 combined bytes, each 1254 × 1254 px. The old 1024 × 1024 message is advisory; originals are not resized. Four historical upload binaries were absent from the supplied ZIP, but authorized read-only Drive retrieval obtained them into a separate ignored `.migration/historical-drive.zip`. Full preview now verifies **seven original PNGs, 11,582,875 bytes**, matching all seven journal digests/MIME/lengths; no historical upload bytes are missing from this snapshot. Source Drive files/sharing and the original ZIP were not changed. This verifies the import plan, not a completed cloud migration.

Preview writes ignored private `.migration/<source-hash>/` copies plus a manifest, including independently hashed supplemental ZIPs. Every included binary must match exactly one journal operation; duplicate resource entries fail. Actual workbook, images, emails and resource IDs never belong in Git. Keep these private source copies together; the supplemental binaries are not in the repository. If the source changes after preview, export fresh XLSX/ZIP and preview again before cutover; this export is a point-in-time snapshot, not synchronization.

## Image lifecycle

Private `image_resources` maps the existing `image_file_id` to immutable Storage keys and ownership/digest/MIME/byte evidence. Import preserves IDs. New upload generates an opaque ID. Legacy `image_url`/`qr_url` values remain archival data; API never trusts them for availability or link generation.

1. Authorize current Admin/version/operation under lock; commit STARTED plus STAGED resource reservation before uploading.
2. Issue an immutable signed upload (upsert=false); browser sends raw bytes directly to private Storage. This avoids Vercel's 4.5 MB function payload limit. A retry uses the same operation/key and cannot create another file.
3. Backend downloads and checks signature, full digest, MIME and length; rechecks actor, operation evidence, version and reference under the commit transaction.
4. Commit Equipment ID, one History, COMPLETED and READY atomically. Only then queue the old resource for cleanup.
5. A session-gated capability API rechecks current Users/asset visibility/version/reference and bytes, issues a 60-second private signed URL, and the browser renders a Blob. Missing/trashed/inaccessible/mismatched files yield a standard placeholder; `img.onerror` is extra protection. Signed URLs are bearer capabilities: possession permits reading until expiry, not permanent public sharing.
6. Admin Preview/Repair handles unavailable references, STARTED operations and managed orphan resources. Only verified absence/trashed evidence can abort an untouched STARTED projection. Access/network/digest uncertainty fails closed. Suspect resources need explicit reviewed cancellation; referenced/pinned resources cannot be deleted.
7. Cleanup is queued and operator-triggered, with a 2h5m margin for existing signed upload expiry. It rechecks references/STARTED pins before removal and retries errors. Supabase deletion is **not Drive Trash**; UI asks for confirmation. No scheduled cleanup service is silently provisioned.

All application uploads are reserved in PostgreSQL before external creation, so managed orphans stay discoverable. Files inserted directly through the Supabase dashboard without metadata are outside this application-managed audit; restrict bucket access to the operator/backend. Keep source ZIP/Drive and verified backups for recovery.

## Account configuration — secrets stay local

The operator chose to configure `.env.local` and log in manually; no interactive wizard is required. Local tools are installed privately under ignored `.migration/cli/` (Supabase 2.119.0 and Vercel 62.2.0). Vercel login and the CRS Hobby team were verified; the linked Next.js project uses Node 24.x, `npm ci` and `npm run build`. Its project identity remains in ignored `.vercel/`, not this runbook. The server secret verified private Storage with a 10 MiB hard limit and JPEG/PNG/WebP/GIF allowlist. Verified TLS now connects to the actual Transaction pooler. PostgreSQL schema installation and the frozen import succeeded: all 109 operational and 120 archive rows match the source plan, and all seven READY original binaries match MIME/length/digest. Replaying the identical import creates no duplicates or overwrites. RLS is enabled, anon/authenticated cannot use the private schema, and public REST/Storage reads were denied. A two-connection read-only transaction probe confirmed real advisory-lock ordering; it does not replace workflow/load acceptance. A verified private database+seven-binary backup exists locally; the separate empty-cloud restore drill remains outstanding. Live Google sign-in is still unverified; Supabase CLI login is optional for the env-based commands.

Use the existing ignored `.env.local` in a private editor; if it does not exist, copy `.env.example`. Never paste its contents into chat, print it in logs or commit it. Rotate any database password previously disclosed in chat **before** entering the new value. No browser `NEXT_PUBLIC_*` key is needed. `DATABASE_URL` must use **Connect → Transaction pooler** (`postgresql://` and the copied host/username/port), not the HTTPS `SUPABASE_URL`. Local origin/callback intentionally remain localhost. Preview server variables are configured separately with an exact HTTPS origin/callback and `WRITE_FREEZE=true`; Production credentials were not installed. Add the Preview callback to the existing Google Web OAuth client, retaining rollback redirects, before live sign-in.

The corrected pooler URI initially failed with `SELF_SIGNED_CERT_IN_CHAIN`. A minimal `SELECT 1` reproduced it; using the Windows system trust store did not resolve it. The [official dashboard's certificate configuration](https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json) supplies the [public Supabase production CA](https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt). Its CA flag/expiry were checked and the PEM was added only to local/Preview `DATABASE_CA`. The same probe then passed with `rejectUnauthorized: true` and hostname verification unchanged. Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0` or relax PostgreSQL TLS verification.

Local CLI installation can be reproduced without a global install:

```powershell
npm install --prefix .migration/cli --save-exact --no-fund supabase@2.119.0 vercel@62.2.0
# Only when the corresponding account is not already logged in:
& .\.migration\cli\node_modules\.bin\supabase.cmd login
& .\.migration\cli\node_modules\.bin\vercel.cmd login
```

Supabase CLI login is optional for the existing database/Storage provisioning command, which uses local server credentials. Never place access tokens in command-line arguments. The isolated CLI dependency audit reports advisories; the application dependency audit is clean. These are tooling advisories, not demonstrated application exploits. An older Vercel CLI had more advisories, so it was not retained; do not apply blind major-version overrides or `audit fix --force`. Review the tooling before deployment, and use a confirmed provider integration/dashboard if needed. `.vercelignore` excludes local credentials, exports, backups, CLI dependencies and Supabase caches from CLI source uploads.

| Variable | Where to obtain / set |
| --- | --- |
| DATABASE_URL | Supabase **Connect → Transaction pooler**; exact Singapore-project host/user/password. URI-encode special password characters. Server-only. |
| DATABASE_CA | Optional PEM certificate from Database Settings → SSL configuration. TLS/hostname verification stays enabled; never solve connection errors by disabling it. |
| SUPABASE_URL | Singapore project URL from Connect/project dashboard; use the actual value, not a guessed screenshot ID. |
| SUPABASE_SECRET_KEY | Project Settings → API Keys → Secret key (`sb_secret_...`); backend/CLI only, never publishable/anon key. `SUPABASE_SERVICE_ROLE_KEY` is supported only as a legacy service-role JWT fallback. |
| IMAGE_BUCKET | `crs-images` private bucket; setup command creates it with 10 MiB hard limit and image MIME allowlist. |
| WEB_APP_URL | The selected stable Vercel HTTPS origin, without path/query/hash. Local development may use `http://localhost:3000`. |
| GOOGLE_OAUTH_CLIENT_ID / SECRET | Google Cloud Console → APIs & Services → Credentials → Web application OAuth client. Preserve old rollback redirects. |
| GOOGLE_OAUTH_REDIRECT_URI | Exact `${WEB_APP_URL}/auth/callback`, also in Google's Authorized redirect URIs. |
| ALLOWED_DOMAINS | Explicit exact comma-separated approved domains, e.g. `yru.ac.th,gmail.com`; imported Users still must exist and be ACTIVE. |
| WRITE_FREEZE | `true` for import/backup/cutover; `false` only after acceptance. This freezes **new** runtime mutations, not old GAS automatically. |
| AUTH_DIAGNOSTICS | Temporary callback-stage diagnostics, default `false`. Enable only for the approved Preview investigation; Vercel Production ignores it. Never log OAuth query strings, credentials, tokens, OTPs or identities. Disable after diagnosis. |

Keep TTL/image defaults unless consciously changing configuration. To freeze the old system, stop users writing and restrict access during the agreed window; setting the new environment variable does not freeze GAS. Do not manually delete/edit canonical rows or Operations to unblock migration.

## Provision and preview

Use Node.js 22+, `npm ci`, `npx playwright install chromium`, `npm test`. No secret is needed for source acceptance. New tests use embedded PostgreSQL (PGlite), deterministic Storage doubles and real Next/browser fixtures; they do not prove live Google/Supabase/Vercel acceptance.

After checking the correct Singapore project and local env, with writes frozen:

```powershell
npm run db:migrate
npm run migrate:preview -- "C:\path\source.xlsx" "C:\path\images.zip" ".migration\historical-drive.zip"
node tools/import-legacy.mjs "C:\path\source.xlsx" "C:\path\images.zip" ".migration\historical-drive.zip" --apply
```

`db:migrate` installs the SQL transactionally and verifies/creates the private bucket; it does not overwrite an existing schema. Partial/drifted schemas need review, not reset. Import first reserves resources durably, uploads/verifies original bytes, then commits all operational/archive/journal rows together into an **empty** destination. Rerunning the exact same workbook/ZIPs verifies images but never overwrites operational changes; a changed manifest or provenance is rejected before external writes. Optional supplemental ZIPs follow the primary ZIP in CLI arguments; include the historical archive above for this snapshot. Interrupted runs resume the same immutable paths. Never apply while either system is accepting writes.

In Vercel CRS, import this feature branch first (root `./`, Next.js preset; build from package scripts). Populate server environment variables in the intended Preview environment. Set `WEB_APP_URL` and Google redirect to the exact preview URL being tested and redeploy. Do not copy preview auth/session state or signed links into Production. `vercel.json` pins functions to `sin1`. Inspect deployment output/file tracing includes `src/*.gs` and generated SPA; no source data/env file is packaged.

Deployment preflight must include a fresh `npm ci`, not just tests against existing `node_modules`. A direct JSZip pin drifted from the already-resolved patch in the lock file, causing the first Vercel build to fail before app execution. Package and npm-generated lock now agree on the audited patch version. Upload ignores also exclude compressed archives (including the unrelated tracked `.7z`), credentials, backups and local CLIs.

Do not assume a CLI flag proves the environment. Vercel CLI converts `--target preview` to an omitted REST target; a fresh project's first submission was nevertheless assigned Production. That build failed at install and never served the application; no Production server credentials, promotion or cutover occurred. For first-deployment safety, use the REST API's explicit **built-in** `staging` target (not `customEnvironmentSlugOrId` or a paid custom environment) and inspect the returned metadata. `null` means Preview; `staging` is the built-in preview alias target; `production` is forbidden before acceptance and must be canceled. See [deployment creation target semantics](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment). Verify environment, canonical alias, protection and function region after the build; never promote merely to bypass Preview protection.

The current protected Preview is READY with `staging` metadata and `sin1` functions; its canonical alias matches the Preview-only server configuration. Operator `vercel curl` smoke checks passed for the rendered shell/static transport, server-key absence in tested client responses, missing-state callback (400), cross-origin mutation (403), sessionless read (UNAUTHENTICATED), frozen mutation (WRITE_FROZEN), and one real PostgreSQL-backed OAuth start with the exact configured callback/state/nonce/PKCE. This created only an expiring PENDING flow, not a session or business record. All 109 operational rows remain unchanged. Anonymous HTTP redirects to Vercel; protection was not disabled. The operator must add the exact Preview callback to Google and sign in through the normal Google/OTP flow; successful OAuth start does not prove token exchange or account authorization.

Avoid selecting `main` for migration deployment while it still contains the old GAS-only project. Branch source passing tests is not authorization to merge or replace a working deployment. Promote only after the checks below and explicit cutover.

### Preview Google callback investigation

The operator saved the exact Preview callback in the Google Web OAuth client. The supplied private log export captures four distinct code+state callbacks returning HTTP 400 before OTP, with no provider error parameter. This demonstrates redirect delivery, not successful token exchange or identity authorization. Existing callback error handling concealed the failing stage; subsequent poll errors are only the resulting UNAUTHENTICATED symptom. Do not replay the export's one-time Google codes or weaken checks to make a test pass.

User-approved temporary diagnostics use `[DEBUG-crs-oauth-v1]` and a fresh independent request UUID. Only controlled stage/outcome, allowlisted error codes, and bounded failed-provider HTTP status/error enums are emitted. No callback URL/query, state/flow hash, Google/CRS tokens, OTP/copy proofs, email/subject, payload, free-form exception text/stack, or database URI is logged. Duplicate error reporting is suppressed; a log sink failure cannot affect denial/commit behavior. The generic callback page, current Users checks, one-time state/PKCE/nonce, and write freeze remain unchanged.

Enable `AUTH_DIAGNOSTICS=true` only in Preview and redeploy with the explicit built-in staging target. Confirm a missing-state request produces a safe CALLBACK_INPUT event, then request **one fresh normal Google sign-in from the main app**, not a refresh of a consumed callback. Inspect only tagged events, filtering raw platform log exports locally because the platform's request metadata can independently contain callback query strings. Capture stage/code, not secrets. A READY diagnostic deployment or passing local callback fixtures does not prove live login is fixed. Disable the flag and remove temporary diagnostics once the actual cause has been repaired and live acceptance passes.

## Live acceptance / cutover gates

- Confirm private schema is not exposed by Data API; anon/authenticated cannot read it; public Storage URL is inaccessible, service key never appears in client bundles.
- Match all table counts, archive reasons, IDs, counters, Operation/History strings/hashes and all seven original image digests against the import manifest. A changed source requires a new snapshot/plan, not blind merge.
- Workspace and Gmail in separate browser profiles: callback/OTP, wrong code limit, expiry, replay rejection, original-browser proof binding, logout/remember, no user auto-provision, current role/inactive revocation. Unknown account and wrong domain must fail.
- Exercise complete request→approve→checkout→return including missing required checklist/disposition checks, owner-only reads/return, same-command replay, duplicate concurrent requests and stale versions. Run real PostgreSQL concurrency/load tests; embedded/mock tests are insufficient proof of lock behavior on Supavisor.
- Create/edit/soft-delete/blocked-delete asset and category/User operations; last active admin/self-email/edit-proof protections; Admin Operations/History/archive.
- Upload/replace/retry and interrupt after direct upload; exactly one file/ref/History; old-image cleanup only after commit. Delete a **disposable test** Storage object externally and check catalog/detail placeholders. Verify GIF playback and mobile UI, QR canonical path, scanner allowlist and sidebar/theme/keyboard/language.
- Take and **restore-verify** a new database+Storage backup in a separate empty project before cutover. Backup/restore CLI was prepared locally but a cloud restore drill is still outstanding.
- Keep both systems frozen during final comparison; choose stable new domain, regenerate QR; enable writes only on the accepted new system. Keep old source read-only. Do not run dual writers.

## Backup and rollback

Free projects can pause, and database backups do not cover Storage binaries. Keep local encrypted/offline copies according to the operator's policy. Backup includes all managed tables, archive, run manifests, image resources, cleanup jobs and available STAGED/READY bytes. Missing READY/referenced binaries or uncertain access **fail** an incomplete backup. A missing untouched STAGED object retains its recoverable metadata. Auth flows/sessions/edit proofs are deliberately excluded; restoration requires a new sign-in.

```powershell
# WRITE_FREEZE=true and both operator/application writes stopped
node tools/database.mjs backup ".migration\private-backup"
# Point env at a separate EMPTY provisioned destination; never overwrite live data
node tools/database.mjs restore ".migration\private-backup" --confirm-empty
```

Restore checks manifest/object checksums, protects existing rows, rejects unrelated/changed resource reservations, reserves keys before uploads, verifies bytes and commits data atomically. The commit invalidates any prior sessions/auth flows/edit proofs so restored Users require a fresh sign-in. A failed restore retains tracked reservations for retry. Embedded PostgreSQL tests cover reservation/atomic archive/session guards, but not a cloud Storage restore drill. Protect backups: they contain user PII, full audit data and images.

Before new-system writes, rollback is returning to the unchanged old source. **After** new-system writes, first freeze the new app and back up its committed state; old Sheets are stale. Do not reopen GAS writers without an explicit reconciliation/reverse-migration plan. Never imply Vercel rollback also rolls back Supabase data.

## Platform references

- [Supabase connections/pooler](https://supabase.com/docs/guides/database/connecting-to-postgres), [verified TLS](https://supabase.com/docs/guides/platform/ssl-enforcement), [Storage access control](https://supabase.com/docs/guides/storage/security/access-control), [Storage error codes](https://supabase.com/docs/guides/storage/debugging/error-codes).
- [Vercel function limits](https://vercel.com/docs/functions/limitations), [project configuration](https://vercel.com/docs/project-configuration), [Next file tracing](https://nextjs.org/docs/app/api-reference/config/next-config-js/output).
- [Supabase backups](https://supabase.com/docs/guides/platform/backups), [free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing).
- Vercel Hobby is limited by [its terms](https://vercel.com/legal/terms) and [fair-use policy](https://vercel.com/docs/limits/fair-use-guidelines). Free development does not automatically establish eligibility for an institutional production workload. No paid plan was provisioned.
