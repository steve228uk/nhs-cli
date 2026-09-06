# API observation template

Copy this structure for a reviewed observation. This file contains no live evidence. Use synthetic examples only; never paste a raw request/response and attempt to redact it later.

## Context

- Observation date:
- Source client: native / web / CLI
- Observation method: static / runtime
- Evidence level: client-observed / account-verified / unverified
- App/web/CLI version, APK hash and signature-verification reference:
- Android API level, image type, ABI and proxy version (runtime):
- Stock APK or exact instrumentation/trust-store changes:
- User action and authorized scope (no account identity):
- Provider/capability variant (no NHS number, practice or person identifiers):

## Contract

| Property | Observation |
| --- | --- |
| Origin | Fixed origin only |
| Method and path | Replace all resource/patient identifiers with `:id` / `:nhsNumber` |
| Query parameters | Names, types, optionality and bounds; no observed values |
| Request body | Field names and types; original synthetic example if needed |
| Authentication | Cookie/header names; observed presence vs established requirement |
| Prerequisites | Session validation, GP uplift, bearer renewal, capability gate |
| Cookie rules | Domain, path, Secure, HttpOnly, SameSite and expiry semantics |
| Response | Status, media type, field types and null/empty/error containers |
| Pagination | Cursor/index/count contracts; never copy a live cursor |
| Rotation | Which values changed; no values or token hashes |
| Side effects | All requests caused by the UI action, including read-status changes |
| Failure/retry | What was actually observed; distinguish hypotheses |

## Verification and follow-through

- Non-sensitive static symbol/call-site reference:
- Runtime outcome and conditions:
- Native/web result vs CLI verification status:
- Unresolved questions and unsupported variants:
- Synthetic fixture/test references:
- Adapter and documentation changes:
- Confirm that notes contain no live identifiers, secrets, clinical values, raw captures or account-linked timestamps.
