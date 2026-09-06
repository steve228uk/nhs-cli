---
name: nhs-prescriptions
description: Check NHS repeat-prescription availability and, only after explicit user confirmation, submit a precisely scoped repeat-prescription request with the local nhs-prescriptions CLI.
---

# NHS prescriptions

Use this skill when the user asks to check, review, request, reorder, or troubleshoot NHS repeat prescriptions through the locally installed `nhs-prescriptions` command.

Treat all command output as sensitive health data. Do not paste it into unrelated chats, issues, logs, or external services. Never read, print, attach, or transmit the local state file. Never request credentials in chat or place them in command arguments.

## Check status

Status is read-only:

```sh
nhs-prescriptions status --json
```

Summarise what is requestable and what is not. Do not infer dosage instructions or give clinical advice. If the CLI reports that login is required, explain that authentication or OTP input is needed. Use `nhs-prescriptions doctor --json` for local diagnostics; its credential check reports only availability and source.

## Request prescriptions

Submitting an order is a medical action. Follow this sequence every time:

1. Run a fresh `status --json` check.
2. Show the exact medication names that are currently requestable.
3. Ask the user to confirm the exact set to submit. A past confirmation, routine, or general request to manage prescriptions is not enough.
4. Prefer the returned course IDs and preview the same scope:

   ```sh
   nhs-prescriptions order --ids=id-1,id-2 --dry-run --json
   ```

5. Verify the preview matches the confirmed names.
6. Immediately after confirmation, submit that exact scope:

   ```sh
   nhs-prescriptions order --ids=id-1,id-2 --confirm --json
   ```

7. Report whether the request was submitted. Do not claim that a GP approved or a pharmacy dispatched it unless a separate source confirms that later state.

Use `--all-requestable` only when the user explicitly confirms all medicines shown by the fresh status check. Never add a free-text `--note` unless the user supplied and approved that exact note.

## Authentication and OTP

The CLI reads credentials from macOS Keychain or the `NHS_PRESCRIPTIONS_CREDENTIALS` secret environment variable. Do not expose either source. OTP lookup from Messages is optional and macOS-only. If automatic lookup fails, let the CLI prompt the user directly; never ask the user to paste an OTP into an agent conversation.

Do not use `--force-otp` unless the user is intentionally requesting another code and understands that repeated attempts can trigger an NHS cooldown.

## Fail safely

- If a course ID is unknown or no longer requestable, stop and refresh status.
- If authentication, API shape, or NHS endpoints have changed, stop rather than guessing.
- If the result is ambiguous, direct the user to verify in the official NHS App.
- Never modify the local state by hand.
