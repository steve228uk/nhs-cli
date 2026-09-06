# Releasing NHS CLI

Releases require an explicit maintainer request. Routine checks do not authorize publishing, pushing, changing repository visibility, or account changes. Never use live NHS data to validate a release.

## Local preparation

Use Node 22 or 24:

```sh
npm ci
npm run build
npm test
npm run test:package
NHS_CLI_TEST_KEYRING=1 npm run test:keyring
```

The native test creates and removes a unique synthetic keyring entry. The package test installs into a temporary prefix and uses synthetic encrypted-file storage, never the user's vault. `build` emits a tarball under ignored `dist/` and rejects unexpected package paths; inspect its actual contents as well. Keep the tracked `bin/` entrypoints. Validate the NHS skill and review command/installer docs whenever behavior changes.

Before making the repository public or publishing, inspect the working tree, all reachable history, and package contents for secrets, patient information, captured responses, and research binaries. Do not print suspect values in review logs. Preserve the keyring pin and Linux Secret Service checks.

## One-time npm bootstrap

Use npm 11.19.1 for bootstrap and trusted-publisher setup. If necessary, run that version with `npx --yes npm@11.19.1 <command>` without changing the user's global npm installation. Authenticate with npm's interactive browser login and complete required 2FA privately. Never put authentication tokens in the repository or GitHub Actions secrets.

Prepare `@steve228uk/nhs-cli@0.0.1` in an isolated temporary directory with only `package.json`, `LICENSE`, and a README identifying it as a non-functional bootstrap for the upcoming `0.1.0` release. Include the correct public repository URL and MIT license; no scripts, dependencies, executable, or health data. Inspect its `npm pack --dry-run` output before publishing from that directory:

```sh
npm publish --access public --tag bootstrap
```

The main source tree stays at `0.1.0`. Verify the `0.0.1` registry record before continuing. Do not unpublish/reuse versions or silently substitute another package name on failure.

Push the reviewed code and workflow to `main`, then make `steve228uk/nhs-cli` public as authorized. This enables unauthenticated skill downloads and public provenance.

Configure the package's trusted publisher (npm 11.15+ supports this command):

```sh
npm trust github @steve228uk/nhs-cli --repo steve228uk/nhs-cli --file publish.yml --allow-publish
npm trust list @steve228uk/nhs-cli
```

This requires package ownership and account-level 2FA. Equivalent npm website settings are owner `steve228uk`, repository `nhs-cli`, workflow filename `publish.yml`, no environment, with direct `npm publish` enabled. The filename must match exactly; do not enter the `.github/workflows/` prefix. See [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/) and [trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Tagged releases

Keep `package.json` and the lockfile version aligned. Commit and push the reviewed release to `main`; wait for CI before creating the annotated version tag:

```sh
git tag -a v0.1.0 -m 'Release nhs-cli 0.1.0'
git push origin v0.1.0
```

The publish workflow verifies a stable `vX.Y.Z` tag matching the package/lockfile and a commit reachable from `main`. It runs the reusable macOS/Linux × Node 22/24 suite, including native storage checks. Only after all jobs succeed does a GitHub-hosted Ubuntu job build and test the tarball, then publish it as `latest` with OIDC and provenance. Only that job has `id-token: write`; no long-lived npm token is used. Release builds use Node 24 and npm 11.19.1 without dependency caching.

On a workflow failure, inspect the safe build/test output. Before repeating a publish attempt, check the registry: a network failure can occur after npm accepted a version. If the version exists, verify it instead of attempting to overwrite it or moving its tag to different code. Fix a published defect in a new patch release.

## Verify the release

```sh
npm view @steve228uk/nhs-cli@0.1.0 version dist.integrity dist.attestations --json
npm view @steve228uk/nhs-cli dist-tags --json
npm run test:package -- @steve228uk/nhs-cli@0.1.0
```

Verify `latest` points to `0.1.0`, provenance links to the intended GitHub workflow, and public README/installer/tagged skill URLs load. The bootstrap tag may remain as historical setup metadata. Test skill installation in an isolated location and report any Grokbot runtime validation that could not be performed. Record actual checks in `docs/validation.md`; distinguish local results from hosted matrix and live account verification. No login, clinical reads, or prescription submissions belong in these release checks.
