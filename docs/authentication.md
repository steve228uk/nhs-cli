# Secure storage and authentication

## Storage

All persistent secret values are inside `vault.enc`: explicitly saved credentials, app cookies, CSRF/bearer tokens, patient-session IDs, remembered-device values and authentication timestamps. AES-256-GCM uses a fresh random 96-bit nonce, 128-bit tag and version-specific associated data for each write. Its envelope contains only version, nonce, tag and ciphertext.

The default random 256-bit vault key is stored through `@napi-rs/keyring` 2.0.0 under service `nhs-cli`, account `vault-key-v1`. macOS uses Keychain; Linux must use persistent Secret Service with its default login collection. Secrets are not passed in subprocess arguments. OS credential stores protect against other users, not malicious software already running as the same user. The pinned release maps to source revision `f3449416a1b4bf11b0570f0a49395aacc84c8608`; see its [Linux backend selection](https://github.com/Brooooooklyn/keyring-node/blob/f3449416a1b4bf11b0570f0a49395aacc84c8608/src/linux_credential_builder.rs) and the [Secret Service store's collection semantics](https://docs.rs/dbus-secret-service-keyring-store/latest/dbus_secret_service_keyring_store/).

The pinned dependency can fall back to Linux keyutils. The adapter first enumerates its service through the dependency's direct Secret Service API. Before creating a key, it writes a random **non-secret probe** into the exact Entry that will hold the key and verifies that value via Secret Service enumeration. Only that already-bound Entry receives a real key. Failed verification removes the probe and fails. Existing keys are read through direct Secret Service enumeration. Dependency updates must recheck this implementation and native Linux tests.

Headless mode requires `NHS_CLI_STORAGE=encrypted-file` and separately injected `NHS_CLI_STATE_KEY`. It uses the same encrypted format with an externally managed key. Missing or wrong keys never cause an existing vault to be overwritten. Restore the original key or explicitly start over.

Default storage is `$XDG_DATA_HOME/nhs-cli`, or `~/.local/share/nhs-cli`. `NHS_CLI_DATA_DIR` selects another absolute directory. Directories use `0700`; files use `0600`. Unsafe ownership, file permissions and symlink vaults are rejected. Writes use an exclusive private temporary file, fsync and atomic rename.

`operation.lock` serializes authenticated commands, credential changes and migration. A second process waits at most ten seconds. Locks are never stolen. After a crash, verify no NHS CLI process is running before removing the lock directory or abandoned ciphertext temporary files.

## Lifecycle

1. Validate stored app state with `GET /v1/session`, updating tokens, patient context and cookies.
2. Extend a still-valid session near its inactivity deadline during active work with `POST /v1/session/extend`.
3. For GP operations, obtain an asserted identity, validate its OAuth callback and create the GP session.
4. For NHS inbox operations, renew the bearer token with `/v1/patient/authorization/access-token/refresh` when needed.
5. On confirmed expiry, permit one credential sign-in using remembered-device state. NHS may require MFA again. There is no background keepalive.

These are separate protocols. Bearer renewal is not an NHS-login refresh-token grant and cannot establish an expired app session. The CLI does not emulate biometric keys or claim passkey support.

Authorization generates a PKCE verifier/challenge, nonce and state. Cookie parameters must match; callbacks must have the expected HTTPS origin, exact path and state. The app session endpoint receives code, verifier and nonce. Decoding a JWT expiry is only a refresh hint, never signature verification.

Cookies follow domain, path, expiry and Secure rules. Redirects are bounded to ten and supported HTTPS origins. Requests have 30-second deadlines and bounded bodies. Codes and ID tokens remain transient. Remembered-device body and cookie values are separate.

The observed `VERIFIED` mobile challenge enters the SMS flow; unsupported TOTP/landline/registration steps return `auth_required`, and unexpected states return `auth_flow_changed`. Remember-device selection is sent explicitly after SMS verification. Permission failures, outages and throttling do not trigger password resubmission. A rejected bearer token first checks the app session and attempts token renewal there; it does not automatically imply password login. Long server cooldowns surface a failure instead of blocking indefinitely.

## Credentials, migration and logout

Credentials resolve from injection, saved values, then Clack terminal prompts when allowed. Email and OTP entry are visible; passwords are masked, including on cancellation. Visible input is confined to terminal stderr, never diagnostics or JSON. Redirected stderr disables interactive input. `--no-prompt` disables prompts and progress; JSON mode suppresses progress while still allowing explicitly interactive input on terminal stderr. Injection never automatically saves passwords. `--save-credentials` verifies through fresh login; `--migrate-credentials` explicitly copies original macOS entries and leaves them intact.

Legacy migration whitelists authentication fields and verifies the encrypted replacement before deleting the source. A source digest inside the encrypted vault permits completing interrupted deletion without importing stale state over rotated sessions. A changed source raises `migration_conflict` and preserves both copies. `auth status` and `doctor` never migrate. Failure preserves the source. Deletion does not remove historical snapshots/backups.

Logout clears session/device material despite remote failures and reports whether server deletion was acknowledged. `--forget` also removes credentials and the account binding. The OS vault key remains to read the cleared vault. Externally injected credentials and NHS remembered-device registrations remain managed through their own source or official service.

## Diagnostics

`doctor` checks storage without creating keys or printing values. `auth status` reports saved-material presence without contacting NHS. OS unlock prompts are outside `--no-prompt`, which controls CLI prompts.

Native exception messages and upstream bodies never appear in output. `--debug` cannot enable raw diagnostics. Read-command output and explicit exports intentionally contain health information and must be handled accordingly.
