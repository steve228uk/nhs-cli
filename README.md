# NHS Prescriptions CLI

An unofficial Node.js CLI for checking repeat prescriptions exposed by the NHS App and submitting repeat-prescription requests.

> [!WARNING]
> This is an experimental, unofficial client for undocumented NHS App endpoints. It may stop working without notice. It is not affiliated with or endorsed by the NHS. Review the source before use and confirm important information in the official NHS App.

## Requirements

- Node.js 18 or newer
- An NHS login with repeat prescriptions enabled
- macOS Keychain, or a secret-injection mechanism for credentials
- Optional: macOS Messages access and `sqlite3` for automatic OTP lookup

## Install

Clone the repository and run:

```sh
npm link
nhs-prescriptions doctor --json
```

The CLI creates `~/.local/share/nhs-prescriptions/state.json` with mode `0600`. That file contains live authentication state. Never copy it into a repository, backup it to a public location, or include it in bug reports.

## Credentials

The recommended macOS setup keeps the email address and password in Keychain:

```sh
security add-generic-password -U -a "$USER" -s openclaw-nhs-email -w 'you@example.com'
security add-generic-password -U -a "$USER" -s openclaw-nhs-password -w
```

The second command prompts securely for the password. The service names retain compatibility with the original local installation.

Agent runtimes may instead inject `NHS_PRESCRIPTIONS_CREDENTIALS` as a secret containing JSON:

```json
{"email":"you@example.com","password":"your-password"}
```

Do not place real values in `.env`, shell-history commands, agent prompts, logs, issues, or commits.

## Commands

```sh
# Diagnose local prerequisites without printing secret values
nhs-prescriptions doctor --json

# Establish or refresh a session
nhs-prescriptions login --json

# Check repeat prescriptions
nhs-prescriptions status --json

# Preview an explicitly scoped request
nhs-prescriptions order --ids=course-id-1,course-id-2 --dry-run --json

# Submit the request after reviewing the preview
nhs-prescriptions order --ids=course-id-1,course-id-2 --confirm --json
```

`--confirm` is required for every non-dry-run submission. `--all-requestable` is also supported, but explicit course IDs are safer for automation. `--no-login` prevents an automatic login, and `--no-prompt` disables manual OTP input. On macOS, the CLI can look for a recent NHS OTP in Messages; this requires Full Disk Access for the invoking terminal or agent host.

## Agent skill

[`skills/nhs-prescriptions/SKILL.md`](skills/nhs-prescriptions/SKILL.md) is the sanitised skill for the Grok Bot-style agent workflow found on this machine. It contains no account, patient, medication, address, conversation, or session data. Its main safety rule is that status checks are read-only, while every prescription submission requires the user to approve the exact medicines immediately before the command runs.

## Security notes

- Credentials are read from secret injection or Keychain and are never written to this repository.
- Session, patient, CSRF, and remember-device values are stored only in the local state file.
- Error output is redacted for JWTs, long hexadecimal tokens, OTPs, and known NHS session fields.
- Detailed upstream error bodies are omitted unless `--debug` is explicitly enabled.
- JSON output contains medication names and is sensitive health data. Avoid logging or forwarding it.
- The `.gitignore` excludes common credential and session files, but it is not a substitute for reviewing `git diff --cached` before every push.

## Development

```sh
npm test
npm run check
```

Tests cover the pure parsing, redaction, OTP-detection, and status-normalisation helpers without contacting NHS services.
