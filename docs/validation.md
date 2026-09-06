# Validation record

Implementation checks on macOS, 2026-09-06:

- `npm run check`: checked JavaScript/JSDoc passes.
- `npm test`: 72 synthetic tests pass on Node 22 and Node 24; no NHS connections.
- `NHS_CLI_TEST_KEYRING=1 npm run test:keyring`: macOS persistence across separate processes, deletion, missing-key and oversized-key rejection pass on Node 22 and 24. The unique synthetic entry is removed. Linux-only integration checks are skipped on macOS.
- Both repository skills pass the skill-creator validator.
- Package dry-run contains only the allowlisted runtime, skills, license and documentation; `private: true` remains enabled. No package was published.
- All eight file blobs in the single-commit repository history and the working files were inspected for private-key markers, provider-token formats, JWTs, email literals and machine-specific home paths. Email candidates are examples on `example.com`; no real secrets were found. This is a targeted review, not proof that arbitrary secrets can never exist.
- Android base and all 19 splits passed signer/content verification as described in [API research](api-research.md).

The CI workflow defines macOS/Linux × Node 22/24, including a disposable unlocked GNOME Secret Service for Linux. Hosted matrix results are pending execution of that workflow; local macOS results are not evidence that Linux has passed. Locked-service and permission failures use injected native-adapter failures in the ordinary suite, without locking the user's real Keychain.

Authentication tests cover reuse/rotation, fresh GP uplift, remembered-device renewal, SMS and unsupported MFA, expiry, one-attempt recovery, bearer renewal and failure, callback/cookie isolation and bounded retries. Storage tests cover authenticated encryption, wrong keys/tampering, private files, interrupted replacement, process concurrency and migration failure/recovery. Domain tests cover capability gates, malformed containers, message read-state preservation, bounded inbox pages, document scope, exact prescription previews and ambiguous submissions without retries.

Explicitly requested live checks on 2026-09-06 used CLI 0.1.0 with web compatibility version 4.76.3 on Node 24.15.0/macOS. The user completed `auth login --save-credentials` in their terminal. Local status confirmed saved session, credentials and remembered-device material without exposing values. Two separate installed-package `capabilities --json --no-login --no-prompt` invocations succeeded, followed by `prescriptions list --json --no-login --no-prompt`. Clinical output remained in process memory; only success/error metadata was recorded. Public OAuth bootstrap validation also passed.

These checks verify current login, secure persistence, session reuse, capability discovery and the current-medicines read for this account. They do not independently verify expired-session recovery, every MFA branch, GP uplift during this particular run, other read adapters, or native-app traffic. No prescription submission or other clinical write was performed. Future live checks remain explicitly scoped; patient output must never become fixtures.

Clack prompt tests exercise the real renderer with synthetic terminal streams: visible email/OTP, password masking, correction of invalid codes, cancellation and closed input. Redirected streams and no-prompt mode fail without requesting input; agent progress stays silent.

Follow-up preflight on 2026-09-06 confirmed the ARM64 XAPK remains available, but Android Studio/SDK/AVD directories and emulator/ADB/mitmproxy executables were not found in the checked locations. The [runtime inspection runbook](android-network-inspection.md) and evidence template are documented; their device/proxy commands have not been exercised on this machine. No runtime capture is claimed.
