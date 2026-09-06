# Install NHS CLI and its agent skill

This is an installation guide for the agent receiving the user's setup request. Perform the applicable steps and report the result; do not simply repeat this document. Use npm on the user's computer.

The user can paste:

> Install NHS CLI from https://github.com/steve228uk/nhs-cli. Follow INSTALL.md to install the CLI and NHS skill for this agent, then walk me through secure terminal login.

Install one CLI package (`@steve228uk/nhs-cli@0.1.0`) and one skill (`nhs`). Do not create a teammate, schedule checks, read medical data, or submit prescriptions during installation. The `0.0.1` bootstrap package is a placeholder and does not contain the CLI.

## 1. Choose the user's computer

For a local coding agent, run commands on the user's configured macOS or Linux computer. On Linux, secure storage requires an unlocked persistent Secret Service, or explicit encrypted-file configuration with a separately injected key; see [authentication](docs/authentication.md).

For **Grokbot**, follow the same local execution model as the [Grok Bot iMessage pack](https://github.com/steve228uk/grok-bot-imessage/blob/main/INSTALL.md): use `ExternalShell` on the user's Mac. Never install or authenticate on Grokbot's own hosted Linux computer. Run `uname -s` through ExternalShell; if the result is not `Darwin`, or local execution is unavailable, direct the user to [Local execution](grokbot://app/v1/settings?id=local-execution) and wait for them to connect their Mac. Do not create a teammate.

## 2. Install and verify the CLI

Check `node --version`, `npm --version`, and `command -v nhs`. Use Node 22 or 24. If Node/npm is missing, explain that prerequisite and use the user's existing Node installation method; do not change a system-wide runtime without their instruction.

If `nhs --version` already reports `0.1.0` or newer, keep it. Otherwise install:

```sh
npm install --global @steve228uk/nhs-cli@0.1.0
nhs --version
nhs --help
nhs doctor --json
```

Do not use `sudo` to work around npm permissions; use a user-writable npm prefix or the user's Node manager. Keep optional dependencies enabled: the pinned keyring package provides secure storage. If `nhs` is not found after installation, check the npm prefix and ensure its `bin` directory is on the local execution process's PATH.

If the registry does not have `0.1.0` yet, report that release availability is pending. Do not substitute the placeholder. For an explicitly requested source install, use a reviewed checkout and its build instructions in the README.

`doctor` checks local prerequisites, not NHS connectivity. A storage failure needs the keyring unlocked/configured or the original injected key restored. Never inspect stored secrets, generate a replacement key for an existing vault, or fall back to plaintext.

## 3. Install the one NHS skill

The canonical file is `skills/nhs/SKILL.md`, also included in the npm package. Install it for the current agent, not every agent found on the machine.

### Grokbot

Fetch the canonical file from the release tag:

https://raw.githubusercontent.com/steve228uk/nhs-cli/v0.1.0/skills/nhs/SKILL.md

Save it with Grokbot's skill-write tool using ID `nhs`, the `name` and `description` from YAML frontmatter, and the Markdown body. Update an existing `nhs` skill instead of creating a duplicate. If skill-write is unavailable, report that the CLI is installed but skill installation needs a capable Grokbot session; do not invent a filesystem path on its hosted computer.

### Codex, Claude Code, Cursor, and other supported agents

Use the [skills installer](https://github.com/vercel-labs/skills) with the current agent's supported ID. For example, Codex:

```sh
npx skills add https://github.com/steve228uk/nhs-cli/tree/v0.1.0/skills/nhs --skill nhs --global --agent codex --yes
```

Use `claude-code` or `cursor` when appropriate. For an unknown agent ID, consult the installer's supported-agent list rather than guessing. For manual installation, copy the complete `nhs` folder from `$(npm root --global)/@steve228uk/nhs-cli/skills/nhs` into the current agent's documented skills directory. Update only this skill, preserving unrelated skills and user configuration.

If the obsolete `nhs-prescriptions` skill is already installed, explain that `nhs` replaces it and remove the obsolete stock skill only when it has no user customizations. Preserve customized content for the user to review. The `nhs-prescriptions` executable remains compatible.

## 4. Walk through secure login

Run `nhs auth status --json` to report local saved-material status; it does not prove server validity. If a session is already stored, preserve it and do not force reauthentication during setup.

If login is needed, have the user run this directly in their own terminal:

```sh
nhs auth login
```

Explain that email and OTP prompts are visible and the password is masked. For encrypted credential reuse on future logins, offer this explicit alternative:

```sh
nhs auth login --save-credentials
```

Never collect passwords, OTPs, or encryption keys in chat, command arguments, shell history, logs, or agent tool outputs. Do not drive secret entry through ExternalShell or a captured terminal. The user completes it privately in their terminal. Do not read the vault, Keychain, or secret environment variables to debug login.

These NHS-specific rules also apply when Grokbot's iMessage skill is active: do not ask for pasted OTPs or delete OTP messages through that skill. `--messages-otp` is an optional CLI feature requiring explicit user authorization and macOS Messages access. Otherwise the user enters the code in the CLI. On cancellation, stop; on MFA/login failure, report the CLI's safe error code without requesting raw responses.

After the user completes login, check only:

```sh
nhs auth status --json
```

## 5. Report completion

Report CLI version and computer, whether the `nhs` skill was saved for the current agent, the doctor result, and whether login material is stored. Identify any unfinished prerequisite. Explain that no health records were fetched and no prescription requests were sent; the CLI is ready for the user's next explicitly requested operation.
