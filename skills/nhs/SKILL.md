---
name: nhs
description: Use the local NHS CLI to read NHS App prescriptions, GP records, results, appointments, NHS or GP inboxes, account details, nominated pharmacy and document metadata; handle secure login recovery and explicit exports without exposing credentials or changing healthcare data.
---

# NHS CLI usage

Use `nhs --help` to check the installed commands. Use `--json --no-prompt` for agent calls. All clinical output is sensitive: show only what the user needs for this task. Never send it to unrelated tools, logs, issues or third-party services. Do not infer clinical advice from results.

## Authentication

Run `nhs auth status --json` for local saved-material status. It does not authenticate or establish server validity. Run `nhs doctor --json` for value-free storage diagnostics. A valid session is reused across invocations; commands may renew sessions or authenticate using configured credentials. Use `--no-login` when the user wants no credential sign-in.

For `auth_required`, arrange for the user to run `nhs auth login` in their terminal. Clack shows email and OTP entry and masks the password; prompts require terminal stdin and stderr. `auth_cancelled` means the user cancelled or closed input; do not retry automatically. `--save-credentials` explicitly persists verified credentials; `--reauth` deliberately signs in again. Never collect passwords, email credentials, OTPs or encryption keys in chat or arguments. Never inspect a vault, Keychain entry or secret environment variable. Do not generate a replacement key to work around a missing key.

Storage errors require unlocking/configuring the keyring or restoring the separately injected headless key. There is no plaintext fallback. `--messages-otp` is opt-in, macOS-only and limited to NHS messages after the current challenge. Do not add it without authorization. Do not bypass OTP cooldowns unless another code was intentionally requested.

## Read the requested data

Start with `nhs capabilities --json --no-prompt` when service availability is unknown. `available` reflects advertised capability, not guaranteed permission. Report `capability_unavailable`, `unsupported` or `access_denied` explicitly; never describe them as empty records.

| Need | Command |
| --- | --- |
| Current medicines | `nhs prescriptions list --json --no-prompt` |
| Request history | `nhs prescriptions history --json --no-prompt` |
| GP record sections | `nhs records --json --no-prompt` |
| Results | `nhs results list --json --no-prompt` |
| Previous results | `nhs results list --year=2025 --json --no-prompt` |
| One result | `nhs results get <returned-id> --json --no-prompt` |
| Appointments / slots | `nhs appointments list --json --no-prompt` / `nhs appointments slots --json --no-prompt` |
| NHS inbox | `nhs messages list --source=nhs --index=0 --count=20 --json --no-prompt` |
| GP inbox | `nhs messages list --source=gp --json --no-prompt` |
| Message | `nhs messages get <returned-id> --source=nhs --json --no-prompt` |
| Account / pharmacy | `nhs profile --json --no-prompt` / `nhs pharmacy --json --no-prompt` |
| Documents | `nhs documents list --json --no-prompt` |
| Document metadata | `nhs documents get <returned-id> --json --no-prompt` |

Use IDs from the requested account's current output. Never invent identifiers or switch patient context. Follow NHS inbox `canLoadMore` with bounded explicit pages only when needed. Do not paginate forever. Preserve access/error indicators in GP sections. Message reads intentionally omit read-status updates.

New reads have `{ok, resource, checkedAt, data}`; prescriptions retain `{ok, checkedAt, summary, courses}`. Parse structured error `code`, not prose. On rate limits or outages, report the problem without repeated sign-ins. On a changed API response, stop rather than guessing new endpoints.

## Exports and actions

Persist health data only when an export/download was requested. Use `--output=<new-file>`; document downloads require `nhs documents download <returned-id> --output=<new-file>`. Choose the user's destination and explain that the exported file contains sensitive information. Existing files are never overwritten.

For prescription submissions, read the sibling `nhs-prescriptions` skill. Exact user-authorized scope and a fresh preview are required. Existing explicit authorization in the current conversation counts; do not ask the same question twice. The CLI does not support new healthcare writes, proxy switching or external portal integrations.

Logout only when requested. `nhs auth logout` clears session/device material; `--forget` additionally removes CLI-managed credentials. Neither is a routine troubleshooting step because both remove useful saved state.
