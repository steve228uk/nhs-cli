# Working on NHS CLI

This unofficial client handles authentication secrets and health information. Read `docs/architecture.md` before changing subsystem boundaries and `docs/api-research.md` before changing endpoints.

## Development

- Use Node 22 or 24, JavaScript ESM and checked JSDoc. Run `npm ci`, `npm run check`, and `npm test`.
- Native storage tests are opt-in: `NHS_CLI_TEST_KEYRING=1 npm run test:keyring` creates and removes an isolated synthetic OS keyring entry. Linux requires persistent Secret Service.
- Keep credentials, cookies, patient identifiers, APKs, decompiled code, HARs and live responses out of the repository. Fixtures must be synthetic. Never inspect a user's vault or retrieve their credentials to debug code.
- Unit tests inject transports, clocks and stores. They must never contact NHS. Live smoke tests require an explicit request naming the operation; do not include clinical writes.

## Invariants

- Commands call domain adapters and `AuthClient`; only storage accesses vault files or keyring backends. Secrets enter via injection, terminal prompts (visible email/OTP, masked password), or explicit legacy migration. Interactive prompts require terminal input and stderr; progress contains only fixed labels and is disabled for JSON/noninteractive output.
- All persistent authentication data is encrypted. Default keys remain in the OS keyring; headless keys must be injected separately. Never add plaintext fallback or save injected credentials without `--save-credentials`.
- `@napi-rs/keyring` is pinned because its Linux fallback is security-relevant. Preserve the Secret Service verification before passing secrets to a new Entry. An environment-variable check is insufficient.
- `withLock` protects the whole authenticated command. Do not nest locks or steal unidentified locks. Preserve atomic writes and migration verification.
- Cookies stay scoped, redirects bounded, and destinations HTTPS-allowlisted. OAuth state must match. HTTP 403/429/5xx are not proof that credentials need to be resubmitted.
- New endpoints need client evidence, capability gates, response checks and synthetic tests. Do not infer routes from their names or send NHS credentials to third-party portals.
- Runtime APK research follows `docs/android-network-inspection.md`. Record native/web/CLI provenance separately, keep captures outside Git, and distinguish trust-store failure from active pinning. The official app may mark messages read when opening details.
- Reads must not send messages, mark them read, switch patients, book/cancel appointments, or submit prescriptions. Document actual semantics of upstream POSTs used for authentication or reads.
- Prescription submission requires explicit user authorization for the exact scope. Respect existing session authorization instead of asking repeatedly. Still require `--confirm`, validate current requestability and never retry ambiguous submissions.
- Output is health data. Diagnostics must not include raw native/upstream errors or bodies, even under `--debug`.

Keep `private: true`. Inspect package contents before publication work. Do not publish, push, or alter account credentials during routine validation. Update command docs and repository skills with behaviour changes.
