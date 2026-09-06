# Architecture

The modern entrypoint and legacy wrapper share one implementation.

| Module | Responsibility |
| --- | --- |
| `cli` | Parsing, validation, lock ownership, composition and exports |
| `domains` | Capabilities, read adapters, prescription scope and response checks |
| `auth` | Sessions, OAuth validation, login, GP uplift and bearer renewal |
| `transport` | HTTPS policy, scoped cookies, redirects, deadlines and body limits |
| `storage` | OS key provider, authenticated encryption, permissions, locking and migration |
| `credentials`, `otp` | Secret input and challenge-scoped Messages lookup |
| `output`, `errors` | Output filtering and safe errors |
| `ui` | Clack terminal prompts, validation, cancellation and fixed progress labels on stderr |
| `types`, `config` | Checked JSDoc, compatibility metadata and non-secret settings |

An authenticated command locks storage, loads/migrates the vault, ensures an app session, discovers capabilities, obtains GP/bearer context as needed and executes the requested operation. Rotated cookies and tokens are saved. Clinical data leaves the process only as requested output or exports; it is not cached in the vault.

This is a single-account tool. Login binds saved state to a credential-email digest. Changing known injected credentials requires logout with `--forget`. Document paths use the authenticated account identifier; arbitrary NHS numbers and proxy switching are not exposed.

New methods must use existing session/capability abstractions. A generated client method is evidence of a route, not an access guarantee. Preserve provider boundaries and return `unsupported` for unmapped implementations. Never normalize missing data into an empty successful result.

The presentation layer receives fixed authentication phase names, never credentials or response bodies. It is disabled for noninteractive/JSON output.

Dependencies are small: `@clack/prompts` provides the terminal UI; `tough-cookie` handles cookie scope; optional `@napi-rs/keyring` handles native storage; Node crypto/filesystem APIs implement the encrypted vault. TypeScript checks JavaScript without a build step. Tests inject external dependencies.

The package allowlist includes runtime code, one NHS skill, installation instructions, docs and development/security guidance. Tests and build scripts remain repository files. `npm run build` checks JavaScript and verifies the file list before retaining a tarball in ignored `dist/`. The executable `bin/` files remain tracked source. Tagged releases run the complete validation matrix before publishing via GitHub Actions OIDC; see [releasing](releasing.md).
