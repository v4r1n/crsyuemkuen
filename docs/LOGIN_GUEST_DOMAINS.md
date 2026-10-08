# Login, public presentation and canonical domains

User-authorized refinement: 2026-10-08. This supplements [identity contracts](IDENTITY_EXPERIENCE.md), not permission to open writers or release linked features to Production.

## Canonical target and transition

`server/config.mjs` owns the approved Vercel origin allowlist; `WEB_APP_URL` is still the sole link base. `VERCEL_ENV` must match its approved origin or configuration fails closed. Development retains explicit localhost configuration. Google callback validation and RPC Origin validation continue using that same configuration, not request/browser host, generated deployment URL or a Production fallback.

| Target | Canonical origin | OAuth callback |
| --- | --- | --- |
| Production | `https://crsyuemkuen.vercel.app` | Origin + `/auth/callback` |
| Preview | `https://crsyuemkuen-preview.vercel.app` | Origin + `/auth/callback` |

Cloud preflight verified the Production canonical origin/callback already match. The Vercel project is renamed `crsyuemkuen`; the provider successfully assigned the requested separate Preview alias to the existing protected Preview deployment before changing source/configuration. Production deployment and Standard Protection remain unchanged. Both server environment freeze flags remain true.

**Pending operator gate:** Google must allow the new Preview URI in the EXISTING Web application client. Preserve Production, previous Preview and rollback URIs. The app uses server-side OAuth, not Google's browser sign-in SDK; a JavaScript-origin entry does not replace a redirect URI. Follow [Google's exact redirect matching rule](https://developers.google.com/identity/protocols/oauth2/web-server). Vercel supports the requested `.vercel.app` alias through [deployment alias assignment](https://vercel.com/docs/rest-api/aliases/assign-an-alias); verified assignment, not an assumed available name, is the provider gate.

Until the operator confirms Save, actual Preview `WEB_APP_URL` and callback remain on the previous hyphenated origin. The newly reserved alias is NOT yet the active canonical app. Do not deploy new source that requires the new origin against the old Preview configuration, or switch the callback and cause a login outage. An ignored one-stage `google-canonical-wizard.sh` walks only the dashboard action; it captures no secrets, writes no env and performs no deployment. Git Bash command: `bash .migration/google-canonical-wizard.sh`. Syntax and the unchanged template library are checked; it is not run unattended.

After confirmation, recheck actual aliases/targets/freeze; update only Preview's origin/callback together, rebuild the authorized Preview source with explicit built-in staging target, assign its new alias, and verify protection, same-target OAuth callback, opposite-origin denial and `WRITE_FROZEN`. Preserve Production source/credentials/deployment. Require fresh sign-in on the new origin; transfer no browser proofs/sessions. Retain old provider redirects during the transition. Never reuse Production origin for Preview or provision a paid custom environment. Existing ignored deployment helpers with the old project-name assertion must be updated/reviewed before use, not run blindly.

## Presentation contracts

- Next composition defaults to Thai when no valid saved language exists, including unavailable storage. Saved English/auto/other selections retain existing behavior. Every language button shows only the actual effective `TH` or `EN` and announces its next action. Language translation reuses already-public display data, not a private fetch or new borrowing decision.
- All reveal controls are hold-only; pointer capture handles release outside the button. Release/cancel/lost capture, focus departure, window blur, Escape and hidden tabs restore masking. Native Edge click-toggle reveal is suppressed. Password/session storage and authentication rules are unchanged. Real-device/Edge visual acceptance remains separate from Chromium/CDP touch coverage.
- The indicated Sierpinski `login-foil` and its generators/styles are removed; the supplied raster logo is unchanged. Liquid-glass cursor, colors and other art remain. Story footer and associated desktop/mobile CSS are removed without leaving a dangling selector.
- Google uses an inline four-color brand SVG at the previous 1em size, hidden from assistive technologies alongside the unchanged accessible button label. Remember/security icon-text pairs are centered and responsive. Reset remains focusable at the form's right edge. Header actions are in DOM order immediately before quick theme; hidden signed-in login control follows existing session state.
- The footer now links to the user-selected Google Privacy/Terms pages using `noopener noreferrer` and no referrer. `/api/experience` returns only these two approved URLs, not env/config objects. Previous optional policy env variables are obsolete. These are Google's policies, not an authored CRS privacy statement.

## Public renderer seam

`web/guest-scene.js` exposes only `mount(host) -> dispose()`. It accepts no private data, fetches nothing and controls no authorization/workflow. WebGL2 is a pointer-transparent, aria-hidden decorative layer; semantic DOM headings, search, cards, pagination and borrow controls work unchanged with CSS fallback. Shader/initialization/context loss and reduced motion fail to CSS. Real context restore recreates resources. Touch is static; fine-pointer movement schedules a single repaint, not an idle animation loop. Pixel ratio is capped at 1.25, width at 1536, height at 450 physical pixels; listeners/observers/GPU resources are released on unmount/login/retranslation. Hidden tabs do not draw.

Signed-out Login automatically loads only `listPublicEquipment`, showing existing explicitly published projection fields. No default publication, private list/detail/image fetch, Supabase browser query, Storage exposure or synthetic business event is added. Search/page requests stay on that endpoint; API errors display a status and do not fall back to internal calls. Stale responses cannot recreate the view after sign-in/handoff. Guest confirm stores the existing ten-minute asset intent and opens Login; authenticated server checks and the unchanged borrow form still decide the workflow. Existing assets remain private unless an Admin explicitly publishes them.

Embedded browsing uses the existing confirm modal; its modal/backdrop must sit above the fixed startup surface. Keyboard focus returns to Login on confirmation. Public data fixtures in browser tests are intercepted by default so automatic Guest loading never uses the operator's live database.

## Phase files and remaining acceptance

Acceptance: clean isolated staged-source `npm test` passes 227 top-level checks. After expanding native Edge reveal suppression to every password field, a second fresh isolated install/build passes all 5 compiled-artifact and 23 actual Next/browser checks again. Actual WebGL2/pixel/context-restoration and native CDP touch execute locally; full dependency audit, diff and actual-value generated-secret scans pass. Chromium captures cover TH/EN, Light/Dark and 320/390/768/1440 px; they are not real-device or cloud OAuth acceptance. The renderer seam keeps these presentation changes independent from the existing borrowing workflow.

Source: `.env.example`, `server/config.mjs`, `server/experience.mjs`, `tools/build-web.mjs`, `src/index.html` (footer removal ONLY), `src/styles.html`, `web/login-controls.html`, `web/experience.js`, `web/experience.css`, new `web/google-icon.svg`, new `web/guest-scene.js`. Tests: `tests/migration/domain.test.mjs`, `experience.test.mjs`, `tests/next/app.spec.js`. Records: this document, `IDENTITY_EXPERIENCE.md`, `MEMORY.md`, `CHANGELOG.md`, `DECISIONS.md`, and its trigger in `CLAUDE.md`.

Preserve user-owned headline/description edits and the unrelated dirty file; neither belongs in this phase commit. No database schema/domain transaction, password/OTP/OAuth proof, publication, private image or existing record changes. No source rollout, main merge, tag or writer reopening is implied by the alias/project change. Outstanding: new Google callback Save, target rebuild/cloud smoke and actual sign-in, real mobile/Edge/screen-reader acceptance, prior SMTP/workflow/load/restore/cutover gates. See the latest MEMORY entry for final test/deployment evidence.
