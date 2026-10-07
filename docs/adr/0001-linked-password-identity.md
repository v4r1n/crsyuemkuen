# Link password credentials to the existing User

The user authorized Email + Password without registration or duplicate identities, superseding the migration's Google-only restriction for the new runtime. Keep the current User and opaque application session as the shared identity boundary, with a separate private versioned credential rather than a second provider-owned user directory that remaps imported IDs or auto-creates users. An additive private schema preserves Google proof checks and borrowing transactions; password replacement revokes prior sessions and records non-secret security History atomically.

## Consequences

SMTP acceptance cannot be atomic with database commit. Temporary-secret messages are sent at most once per command and never persisted for retransmission; uncertain/crashed issuance needs an explicitly confirmed new command, while ordinary security notifications retain non-secret delivery metadata. This favors secret minimization/replay safety over transparent secret resend; see [activation and uncertainty handling](../IDENTITY_EXPERIENCE.md).
