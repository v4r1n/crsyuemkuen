# Opt-in external delivery follows authoritative notices

The operator chooses real Push/Email delivery on 2026-10-16. This supersedes
ADR-034's unimplemented-channel restriction only after separate activation.
It does not replace in-app display, mandatory security email or workflow History.

## Delivery seam

Each event has one nullable external channel, PUSH or EMAIL, independently of
in-app delivery. Null means no opt-in; migration never enrols existing users or
backfills old notices. Only insertion of a new authoritative recipient/History
notice can enqueue a target-scoped attempt in the same locked transaction.
Deterministic attempt IDs and durable SENDING reservations prevent workflow
retry and concurrent workers from submitting the same attempt again.

The worker rechecks current ACTIVE owner, allowed email/domain, role/Borrow
access, exact preference version/channel and explicit canonical origin before
reserving at most four jobs. Provider I/O is outside the workflow lock. A change
after reservation cannot recall an in-flight provider request. Messages contain
only generic new-activity copy and a canonical sign-in link, not equipment,
borrower, loan, session or security proof details. Push uses an opaque notice ID
only as a stable display tag. Provider acceptance is not device/inbox receipt.

Web Push device capabilities remain private, origin- and current-session-bound,
with a maximum five active registrations per owner/origin. Registration is an
explicit permission gesture, never an automatic bootstrap prompt. The worker
checks the referenced unexpired session and current password generation before
Push. Logout/revocation disables later reservations; already accepted generic
notifications may remain visible. A new sign-in requires clicking Push to
register again, even if the saved channel is already Push. Foreign bindings are
not reassigned; a conflicting browser subscription must be unsubscribed and
explicitly registered again. Known push-provider HTTPS hosts and validated EC
keys constrain outbound destinations; no arbitrary URL or redirect is followed.

## Failure and free-first operation

Accepted, failed, cancelled and uncertain attempts are terminal. SMTP errors or
transport ambiguity become UNCERTAIN, never automatic resends. Only explicit
temporary Web Push rejection responses can retry, after five minutes, at most
three attempts and within 24 hours. Provider 404/410 removes the stale device;
an abandoned SENDING reservation becomes UNCERTAIN after two minutes. This is
not an exactly-once delivery claim or a general SMTP reconciliation system.

Successful existing bootstrap/inbox/workflow RPCs use Next `after` to drain a
bounded batch without delaying borrowing. An authenticated daily worker is a
free-tier-compatible safety opportunity, not a minute-level retry guarantee.
Backlog beyond the bounded batches, cold/idle periods and provider outages can
delay or expire delivery. There is no paid queue or new reminder scheduler.
WRITE_FREEZE and disabled delivery stop both queue creation and dispatch.

## Backup and activation

Preferences remain durable format-4 data. Device capabilities and operational
delivery attempts are transient and excluded like sessions; restore clears
them when the new tables exist. Restored notices never re-enqueue. Attempts are
not business History or a retained provider-delivery audit. No automatic
retention/deletion policy is added for these operational tables.

Activate only after a separately authorized verified-backup/additive-migration
preflight, private-table advisors and separate target configuration. Keep
delivery disabled until the operator supplies target-specific VAPID keys,
sender subject, SMTP readiness and a worker secret, then explicitly accepts
real provider/device behavior. Preserve Production/Preview origins, callbacks,
protection and writer modes. Source tests do not apply cloud DDL, send real
messages or authorize deployment. Memory owns the actual acceptance state.

References: [Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API),
[web-push](https://github.com/web-push-libs/web-push),
[Next after](https://nextjs.org/docs/app/api-reference/functions/after),
[Vercel Cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).
