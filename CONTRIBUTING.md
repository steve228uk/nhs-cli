# Contributing

Use Node 22 or 24; run `npm ci`, `npm run check`, and `npm test`. Update affected docs and skills. Follow `AGENTS.md`.

Use synthetic credentials, patients, medicines and responses in tests. Never attach a live response, decrypted session, Keychain entry, medical screenshot, APK or decompiled source to an issue or PR. Reports should include CLI version, OS, error code and public-client evidence without account information.

Document new methods in `docs/api-research.md`: origin, parameters, capability restrictions, responses and side effects. Test behavioural contracts, including recovery and prevention of duplicate writes. Never add live NHS calls to CI.

Native integration tests are opt-in: `NHS_CLI_TEST_KEYRING=1 npm run test:keyring`. They use a unique service and synthetic state. Linux tests must demonstrate Secret Service persistence and failure when unavailable. Dependency upgrades must recheck fallback behaviour before changing the pin.

Before release work, run `npm run build` and `npm run test:package`, review staged files/history for accidental secrets and run the CI matrix. `bin/` is executable source; generated packages belong in ignored `dist/`. Releases require an explicit request and follow [the release runbook](docs/releasing.md), using GitHub Actions OIDC after the one-time bootstrap. Never add an npm publish token to CI.
