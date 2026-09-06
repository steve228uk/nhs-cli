---
name: nhs
description: Use NHS CLI for NHS App records, medicines, results, appointments, messages and documents; recover secure login, export requested data, and submit only explicitly authorized repeat-prescription requests.
---

# NHS CLI usage

Use `nhs --help` to check the installed commands. Use `--json --no-prompt` for agent calls. All clinical output is sensitive: show only what the user needs for this task. Never send it to unrelated tools, logs, issues or third-party services. Do not infer clinical advice from results.

Run the CLI on the user's configured computer, where their secure login is stored. In Grokbot, use `ExternalShell` on the user's Mac, never Grokbot's own hosted computer. If local execution is unavailable, direct the user to [Local execution](grokbot://app/v1/settings?id=local-execution). For missing CLI/skill setup, follow [the installer](https://github.com/steve228uk/nhs-cli/blob/main/INSTALL.md). Do not create a teammate or schedule health-data reads during setup.

## Authentication

Run `nhs auth status --json` for local saved-material status. It does not authenticate or establish server validity. Run `nhs doctor --json` for value-free storage diagnostics. A valid session is reused across invocations; commands may renew sessions or authenticate using configured credentials. Use `--no-login` when the user wants no credential sign-in.

For `auth_required`, arrange for the user to run `nhs auth login` in their terminal. Clack shows email and OTP entry and masks the password; prompts require terminal stdin and stderr. `auth_cancelled` means the user cancelled or closed input; do not retry automatically. `--save-credentials` explicitly persists verified credentials; `--reauth` deliberately signs in again. Never collect passwords, email credentials, OTPs or encryption keys in chat or arguments. Never inspect a vault, Keychain entry or secret environment variable. Do not generate a replacement key to work around a missing key.

Storage errors require unlocking/configuring the keyring or restoring the separately injected headless key. There is no plaintext fallback. `--messages-otp` is opt-in, macOS-only and limited to NHS messages after the current challenge. Do not add it without authorization. Do not bypass OTP cooldowns unless another code was intentionally requested.

For NHS login, use the CLI's terminal entry or its explicitly authorized `--messages-otp` flow even when another iMessage skill is installed. Do not use a general OTP skill's paste-in-chat fallback or message-deletion routine. If terminal interaction is unavailable, have the user open their own terminal; do not attempt to collect or forward login secrets through agent tools.

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

Logout only when requested. `nhs auth logout` clears session/device material; `--forget` additionally removes CLI-managed credentials. Neither is a routine troubleshooting step because both remove useful saved state.

## Repeat-prescription requests

Read current medicines with `nhs prescriptions list --json --no-prompt`. Select the exact returned IDs matching the user's requested medicines, then create a fresh preview:

```sh
nhs prescriptions order --ids=id-1,id-2 --dry-run --json --no-prompt
```

Show the full selected names and the user's exact note. Include the same `--note` in both preview and submission when supplied; never infer a note, change dosage, or broaden the selection. Use `--all-requestable` only when the user explicitly authorizes all medicines shown in the fresh preview.

Submitting a request changes healthcare data. Require explicit authorization for the exact medicines and note. Existing authorization for that scope in the current conversation remains valid; do not ask again merely because this skill is active. A general request to manage prescriptions does not authorize an unspecified order.

Once the preview matches the authorized scope:

```sh
nhs prescriptions order --ids=id-1,id-2 --confirm --json --no-prompt
```

The command checks current requestability again. Unknown, duplicate, or unavailable IDs stop submission. If scope changes, refresh the preview and resolve the changed scope with the user. Report acknowledgement as a submitted request, not GP approval or pharmacy dispatch.

On `order_unknown`, do not retry. Have the user check the official NHS App before authorizing a new submission. The CLI never automatically repeats an ambiguous submission. The compatible `nhs-prescriptions` entrypoint remains available, but no separate skill is needed.

Other healthcare writes, patient switching and third-party portal integrations are unsupported. Message reads omit read-status updates; do not add them through another tool.
