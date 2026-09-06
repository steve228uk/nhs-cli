# NHS CLI

An unofficial CLI for NHS App services, with securely saved login state and commands for prescriptions, GP records, results, appointments, messages, profiles, pharmacies and documents.

This experimental client uses undocumented endpoints and is not affiliated with or endorsed by the NHS. Availability depends on your account and GP provider. Secure login, cross-process session reuse, capability discovery and current medicines have passed live checks. Other read adapters are based on the public client and synthetic tests; they still need account verification. Confirm important information in the official NHS App.

## Install

Use Node.js 22 or 24 on macOS or Linux:

```sh
npm ci
npm link
nhs doctor --json
```

macOS uses Keychain. Desktop Linux needs an unlocked Secret Service provider such as GNOME Keyring, session D-Bus, and the `@napi-rs/keyring` optional dependency. Unavailable secure storage stops the CLI; it never silently saves a plaintext session.

## Save your login

```sh
nhs auth login --save-credentials
nhs auth status --json
nhs prescriptions list
```

Login uses Clack terminal prompts: email and NHS security codes are visible; the password is masked. Progress explains each login stage. Prompts use terminal stderr, keeping JSON on stdout separate. Use `--no-prompt` for unattended calls. `--save-credentials` encrypts verified credentials for reuse. Ordinary commands reuse sessions first and can sign in again using saved credentials and remembered-device state. NHS may still require another code or a full login.

`auth login` reuses a valid session. `--reauth` deliberately signs in again; `--save-credentials` also performs fresh verification before saving. `auth status` reports locally saved material without claiming server validity.

Authentication data lives in an AES-256-GCM encrypted vault. Its random encryption key stays in the OS credential store, allowing atomic session updates without credential-store size limits. Ordinary files contain no plaintext credentials, tokens or patient identifiers. See [storage and authentication](docs/authentication.md).

```sh
nhs auth logout
nhs auth logout --forget
```

Logout clears session/device state and attempts server-session deletion. `--forget` also clears CLI-managed credentials. The OS encryption-key entry remains so the cleared vault stays readable. Injected credentials and original legacy Keychain entries remain managed by their source.

## Commands

```sh
nhs capabilities --json
nhs prescriptions list --json
nhs prescriptions history --from=2026-01-01 --json
nhs records --json
nhs results list --year=2025 --json
nhs results get result-id --json
nhs appointments list --json
nhs appointments slots --json
nhs messages list --source=nhs --index=0 --count=20 --json
nhs messages get message-id --source=gp --json
nhs profile --json
nhs pharmacy --json
nhs documents list --json
nhs documents get document-id --json
nhs documents download document-id --output=./letter.pdf
```

Messages are read without mark-as-read calls. Documents use GP Connect and an ID from the current account's available document list. Unimplemented providers return `unsupported`; disabled access returns `capability_unavailable`.

Use `--output=./new-file.json` for explicit sensitive JSON exports. Exports use mode `0600`, require an existing parent directory and never overwrite files. Health data is not cached. Terminal and JSON output remain sensitive health information.

### Prescription requests

```sh
nhs prescriptions order --ids=course-id-1,course-id-2 --dry-run --json
nhs prescriptions order --ids=course-id-1,course-id-2 --confirm --json
```

Review the preview and authorize the exact medicines before submission. Use the same IDs and user-supplied `--note` for preview and submission. `--all-requestable` cannot be combined with `--ids`. Unknown, duplicate or unavailable IDs are rejected. An uncertain response returns `order_unknown`; check the official app before trying again. Submission is not GP approval or pharmacy dispatch.

### Agents and headless Linux

Runtimes can inject `NHS_CLI_CREDENTIALS` or legacy `NHS_PRESCRIPTIONS_CREDENTIALS` as JSON containing `email` and `password`. Never put actual credentials in `.env`, shell commands, prompts, logs or issues. Injection takes precedence over stored credentials and is not persisted without `--save-credentials`.

For Linux without a keyring, explicitly set non-secret configuration `NHS_CLI_STORAGE=encrypted-file`. Have your secret manager inject `NHS_CLI_STATE_KEY`: standard base64 encoding of a random 32-byte key, stable across invocations. Keep it separate from the vault. Missing or incorrect keys stop the CLI; no fallback key is generated.

```sh
nhs prescriptions list --no-prompt --json
nhs prescriptions list --no-login --no-prompt --json
```

`--no-login` prevents credential login but permits session validation, GP uplift and bearer renewal. `--no-prompt` prevents CLI terminal prompts; the OS keyring must still be unlocked. `auth_required` means a human must run login in a terminal.

`--messages-otp` opts into macOS Messages lookup, limited to NHS messages received after the current challenge. It needs Messages access and `sqlite3`. Lookup can fall back to terminal entry unless `--no-prompt` is set. `--force-otp` overrides only the local ten-minute SMS cooldown, not NHS limits.

Copy the [general NHS skill](skills/nhs/SKILL.md) and [prescription skill](skills/nhs-prescriptions/SKILL.md) into your agent's skill directory. Neither includes account data or credentials.

## Migration

`nhs-prescriptions status|list|order|login|doctor` remain available. Prescription status/submission JSON retains prior shapes; previews add the note. See [CLI contracts](docs/cli.md) for clarified diagnostics and errors.

The first authenticated command imports `~/.local/share/nhs-prescriptions/state.json`, verifies secure storage and then deletes the plaintext file. Unsafe permissions or failed verification preserve the original and stop. No plaintext backup is created. Original macOS credential entries can be explicitly copied with:

```sh
nhs auth login --migrate-credentials
```

## Development

To map remaining API variants using the official app, see the [Android runtime network-inspection workflow](docs/android-network-inspection.md) and [API observation template](docs/api-observation-template.md).

```sh
npm run check
npm test
npm pack --dry-run
NHS_CLI_TEST_KEYRING=1 npm run test:keyring
```

Tests use synthetic data, never NHS services. The opt-in native test creates and deletes a unique test entry. See [architecture](docs/architecture.md), [API research](docs/api-research.md), [validation and remaining checks](docs/validation.md), [contributing](CONTRIBUTING.md), [security](SECURITY.md), and [AGENTS.md](AGENTS.md). Publication remains disabled.
