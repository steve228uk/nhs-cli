---
name: nhs-prescriptions
description: Check repeat-prescription availability and request history with NHS CLI, preview exact currently requestable medicines and notes, and submit only the scope explicitly authorized by the user while handling uncertain outcomes without duplicate requests.
---

# NHS prescriptions

Use `nhs prescriptions` or the compatible `nhs-prescriptions` command. Treat all output as sensitive health data. Never inspect stored secrets, collect credentials in chat or place them in arguments. Use `--json --no-prompt` for agents.

## Check and preview

Read current availability:

```sh
nhs-prescriptions status --json --no-prompt
```

Summarize requestability without prescribing or changing dosage. Read request history with `nhs prescriptions history --json --no-prompt` when the user needs it. Unavailable capabilities, errors and malformed responses are not empty medication lists.

Select the exact IDs corresponding to the user's requested medicines and create a fresh preview:

```sh
nhs-prescriptions order --ids=id-1,id-2 --dry-run --json --no-prompt
```

Include the user's exact `--note` in both preview and submission if one was requested. Show the full selected names and note. Do not add an inferred note or broaden the scope. `--all-requestable` is appropriate only when the user explicitly authorizes all medicines shown in the fresh preview.

## Submit an authorized scope

Submitting a prescription request changes healthcare data. Obtain explicit approval for the exact medicines and note before submitting. Approval already given for this scope in the current conversation remains valid; do not ask again merely because a skill is being used. A general request to manage prescriptions does not authorize an unspecified order.

Once the fresh preview matches the authorized scope:

```sh
nhs-prescriptions order --ids=id-1,id-2 --confirm --json --no-prompt
```

The command fetches current requestability again. Unknown, duplicate or no-longer-requestable IDs stop submission. If scope changed, refresh and resolve it with the user. Report submission acknowledgement accurately; it does not mean the GP approved or the pharmacy dispatched the medicines.

On `order_unknown`, do not repeat the command. Ask the user to check the official NHS App for the outcome before authorizing any new submission. The CLI never automatically replays an ambiguous POST.

## Authentication recovery

Saved sessions and configured credentials are reused securely. `auth_required` means the user must run `nhs auth login` directly in their terminal; `--save-credentials` explicitly saves verified credentials for future logins. `nhs auth status --json` and `nhs doctor --json` are local, value-free diagnostics. Storage failures require restoring/unlocking secure storage, never a plaintext workaround.

`--no-login` prevents credential sign-in, including during order commands. `--no-prompt` prevents CLI prompts. Messages OTP lookup requires explicit `--messages-otp` opt-in and is limited to the current challenge. Do not use `--force-otp` unless another code was deliberately requested. Never ask for an OTP in chat, print secret injection variables, or alter state files by hand.
