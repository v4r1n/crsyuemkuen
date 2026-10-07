# Linked identity and equipment experience

Source preparation: 2026-10-07. Not deployed or applied to cloud. Production/Preview freezes and prior acceptance gates remain unchanged. Supplement to [the migration runbook](MIGRATION_NEXT_SUPABASE.md), not cutover authority.

## Contracts

- Google state/nonce/PKCE, verified code exchange, handoff and opaque sessions remain intact. Local sign-in resolves the SAME existing ACTIVE User, current allowed domain/email/role; never auto-provisions or trusts a browser role. Six-hour session ceiling and existing remember behavior remain.
- Unique salted scrypt hashes use fixed N=131072/r=8/p=1 and bounded decoding. Policy: 15–128 Unicode code points after NFC, no control characters, four distinct characters, and rejection of a small built-in common-password list or own email. Matching confirmation and policy are enforced server-side and mirrored in UI. The blocklist is not exhaustive breached-password screening.
- Persistent throttles: sign-in IP 20/10 minutes, normalized email 10/15 minutes before expensive work; five failures lock for 15 minutes. Unknown identities do the same hash work. Recheck User, credential/email/generation after hashing and on protected calls. Expired temporary credentials cannot log in.
- CHANGE OTP binds the original session; signed-out RESET only permits an existing authorized User. Six crypto-random digits, separate HMAC key, five-minute expiry, five guesses, 60-second cooldown, IP/email quotas. Verified proof has a five-minute, generation-bound one-use change window. Change atomically consumes proofs, increments generation, revokes Google/password sessions and appends non-secret security History.
- ADMIN-only temporary issuance is command-deduplicated, Admin/target throttled and current-state/domain guarded. It expires in 24 hours and requires password replacement. A new Google session to the same required-change User is restricted too. No credential grants a role.
- SMTP uses verified TLS (465 or required STARTTLS on 587), bounded timeouts and disabled transcript/payload logging. No OTP/password/secret email body is returned by RPC, stored in History/mail metadata, sent in URLs or logged. Temporary plaintext exists only during process delivery and in the recipient/provider mailbox; CRS retains only its hash.
- Borrow notifications are projected from NEW authoritative History in the same locked transaction. Borrower receives request/approve/reject/checkout/return-request/return; active Admins also receive request/return-request. Unique recipient + History keys prevent retry duplicates. Inbox/read operations are owner-scoped. Badge reads at bootstrap, after relevant mutations, when foregrounded/opened and each 60 seconds in active authenticated tabs; no browser-authored workflow events.
- Guest visibility defaults PRIVATE for all existing/new assets. Explicit Admin publication exposes name/category/brand/model/borrowable boolean only: no serial, cost, location/department, borrower, History or private image. Deleted/retired/lost assets and inactive categories disappear. Field approval remains an operator acceptance item; no asset is published by this source change.
- Guest confirmation saves only a ten-minute asset intent. Either login resumes the unchanged borrow form, not an automatic request. Required-change retains intent until sign-in after replacement. Actual borrowing/return/internal/image RPCs require current server authorization and unchanged state/version checks.
- New tables are private RLS-enabled, without client policies, in unexposed `crs`. Existing business rows/schema are not rewritten. Legacy GAS remains Google-only; Next's build adapter composes the new password UI.

Focused implementation checks are not a comprehensive penetration test or certification. Parameters follow [OWASP scrypt guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html); email confirmation is not phishing-resistant MFA under [NIST guidance](https://pages.nist.gov/800-63-4/sp800-63b.html). Transport follows [Nodemailer TLS](https://nodemailer.com/smtp).

## Activation order

1. Review diff/tests; take a fresh verified private DB + Storage backup with prior accepted source. Read the migration runbook before cloud migration/deploy/restore; preserve older backups.
2. Select authorized SMTP sender/provider and privately configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, and a separate randomly generated `PASSWORD_OTP_SECRET`. No `NEXT_PUBLIC_*`, chat or Git. Missing settings fail closed; temporary issuance also checks confirmation-key readiness.
3. Apply `202610070002_identity_experience.sql` using the reviewed database command BEFORE deploying new source. A private checksum ledger makes repeat apply a no-op and rejects changed source. No table reset. These tables are needed even for new-source Google bootstrap.
4. Deploy only to an explicitly approved target after diff/test/build/privacy gates pass. Preserve canonical origin/callback and existing URIs. This phase makes no Production deployment or write-opening change.
5. Verify fresh Google/password sign-in using authorized test accounts, SAME User, unknown/inactive/domain denial, generation revocation, lockout/expiry, delivered OTP/temp/security emails, spam/sender and forced-change. Tests use synthetic mail, not real SMTP acceptance.
6. Approve Guest projection before publishing; verify anonymous internal/image denial and both-method handoff. Verify two-account notification workflow/replay and 320/390/768/1440 px, TH/EN, Light/Dark, reduced motion and REAL mobile keyboards.
7. Optional approved HTTPS `PRIVACY_POLICY_URL` / `TERMS_OF_SERVICE_URL` enable real footer links. Without them show an honest unconfigured notice, not a fabricated policy. `/api/experience` returns only two validated links, never environment/config objects.

## SMTP uncertainty

`security_mail` retains only event/recipient/kind/status/timestamps. SENT means SMTP accepted, not inbox-delivery proof. Temporary flow reserves SENDING, generates/hashes once, mails, then rechecks actor/target/generation before activation. Same-command replay returns metadata and never sends another secret. Rejected activation returns DENIED; send failure records UNCERTAIN and leaves the original credential unchanged.

Crash/network loss after accepted mail but before activation can leave SENDING and an emailed password that is invalid. Admin retry first reuses its command to inspect status; a new issuance needs explicit confirmation. There is no plaintext recovery or exactly-once SMTP guarantee. Password change commits before its ordinary non-secret security email; delivery failure cannot undo it. Pending/uncertain metadata remains for operator review; automatic SMTP-queue reconciliation is not implemented. Never resolve uncertainty by direct business-table edits.

## Backup and rollback

Format-2 backups include credentials, non-secret mail metadata, visibility and inbox/read state; hashes/emails make backups sensitive. Sessions/OTP/OAuth proofs are excluded. Verified empty-target restore retains new durable records, clears transient proofs and marks unfinished mail UNCERTAIN instead of resending. Format-1 backups normalize with empty new tables, never invented credentials/public assets/notices. Schema checksum ledger belongs to destination provisioning.

Old application source may roll back to Google-only with additive tables left safely present. After new credential/events have been written, data rollback needs generation/event reconciliation; never restore over live state or resurrect sessions. Business WRITE_FREEZE does not freeze sign-in/security changes, so backup is an atomic snapshot, not an assertion that identity cannot change afterward.

## UX and residual acceptance

Logo is supplied and unmodified. Press-and-hold reveal masks again on pointer/keyboard cancellation, blur and hidden tab. Password inputs clear after submit/close and are never browser-storage state. Six-cell Google handoff supports full-code paste/beforeinput/autofill, NFKC and Thai/Arabic/Persian digits, backspace and complete-only submit. Email OTP uses a full-code field with identical normalization.

Guide/language/login/notifications follow state, including Guest/Settings. Quick theme is Light/Dark only; System remains in Appearance. Card theme placement, icon alignment, header/search radii are browser tested. New copy supports TH/EN; inherited screens retain baseline translation coverage. Code-native foil/Sierpinski/cursor are pointer-transparent, fine-pointer-only and disabled for reduced-motion/touch.

Outstanding: SMTP/provider delivery and actual policy pages; Guest-field approval; small password blocklist and memory-hard hashing/free-tier/distributed-abuse load acceptance; no automatic uncertain-mail reconciler; real screen-reader/mobile-keyboard/cloud-concurrency checks. Embedded DB/mocked browsers do not prove these or complete security coverage. Existing source-freshness, freeze/cutover, restore and workflow gates remain in MEMORY.

## Local verification

Final `npm test`: 218 top-level checks pass (17 contracts, 83 preserved backend, 51 preserved frontend, 47 migration, 4 compiled-artifact and 16 Next/browser). The OAuth callback wrapper also exercises 14 internal cases. After final mobile dark/English capture assertions, `npm run test:next` passes again. Production build, full `npm audit` (zero advisories), diff review and public-asset/function-tracing privacy checks pass. Browser fixtures and reviewed captures cover responsive 320/390/768/1440 px, Light/Dark, new TH/EN copy, keyboard focus and reduced motion. Login's fixed scroll surface allows reaching the footer and returning to the logo/theme after lower-field focus; top and bottom captures are checked separately. These checks do not replace the real-device, SMTP and cloud activation gates above.

## Phase files

- Backend: new `server/password-crypto.mjs`, `password-auth.mjs`, `mail.mjs`, `experience.mjs`, `migrations.mjs`; integration in `auth.mjs`, `rpc.mjs`, `domain.mjs`; additive SQL; `app/api/experience/route.js`.
- UI: new `web/login-controls.html`, `experience.js`, `experience.css`, unmodified `public/brand/icon-yuemkuen.png`; `web/transport.js`, `src/index.html`, `scripts-api.html`, `scripts-core.html`, `tools/build-web.mjs`.
- Operations/config: `.env.example`, package/lockfile, `tools/database.mjs`, `restore-records.mjs`.
- Tests: migration password/experience/auth/domain/restore, callback fixture, frontend OTP/theme, Next/browser and production-artifact privacy checks.
- Documentation: `CLAUDE.md`, `CONTEXT.md`, this runbook, linked ADR, `DECISIONS.md`, `MEMORY.md`, `CHANGELOG.md`. Build/captures and unrelated local edits are excluded.
