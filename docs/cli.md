# CLI contracts

See `nhs --help`. Options accept `--name=value` or `--name value`; boolean flags cannot take values. Unknown/duplicate options fail. No secret has an argument flag.

New reads return `{ok:true, resource, checkedAt, data}`. Data preserves documented upstream structure; the CLI does not interpret clinical results. Authentication fields are recursively removed. Empty lists require a valid response structure.

Prescription status retains `{ok, checkedAt, summary, courses}`. Courses include `id`, `name`, `details`, `requestable`. Orders add `order`; previews contain IDs, names and the exact note. Only the observed HTTP 201 acknowledgement reports successful submission; unrecognized acknowledgements are uncertain.

NHS inbox defaults to `index=0`, `count=20`, bounded to index 100000 and count 100. `messages` and `canLoadMore` support explicit subsequent pages. GP pagination is not invented. History defaults to six months. Results accept an ID or historical year. Document `get` returns metadata; `download --output` fetches content.

Capabilities return `{status,evidence}` per domain. Status is `available`, `unavailable`, or `unsupported`; this is advertised configuration, not guaranteed endpoint permission. Prescriptions and GP appointments support IM1; GP Connect prescription ordering is not implemented. Results support the classic record path; the version-3 results provider is unsupported. Documents use GP Connect.

Errors return `{ok:false,code,message}` with selected metadata such as HTTP status/capability. JSON is selected with `--json` or non-TTY stdout; human errors use stderr. Failures, including failed doctor checks, exit 1. Success exits 0. Agents should parse JSON only.

| Code | Action |
| --- | --- |
| `auth_required`, `session_expired` | Arrange terminal login; never collect credentials/OTP in chat |
| `secure_storage_unavailable` | Unlock/configure the OS keyring; no plaintext workaround |
| `storage_key_required`, `storage_key_missing`, `storage_corrupt` | Restore/configure the key; do not overwrite the vault |
| `storage_busy` | Wait; inspect before repairing a stale lock |
| `account_changed` | Stop; changing accounts requires explicit logout with `--forget` |
| `capability_unavailable`, `unsupported`, `access_denied` | Report the limitation, not an empty clinical result |
| `auth_flow_changed`, `oauth_validation_failed`, `invalid_response` | Stop and report the code without live response attachments |
| `rate_limited`, `upstream_unavailable`, `network_error` | Report the failure; do not loop or trigger repeated SMS |
| `order_requires_scope`, `order_requires_confirmation`, `order_invalid_scope` | Obtain fresh scope and explicit user authorization |
| `order_unknown` | Check the official app before any new submission |
| `export_failed` | Choose a new file; existing files are never replaced |

Interactive login uses Clack with visible email and OTP fields and a masked password. Prompts require terminal stdin and stderr. Ctrl-C or closed input returns `auth_cancelled`. Progress uses stderr and is suppressed for JSON, redirected stdout, and `--no-prompt`; JSON contracts remain unchanged. Use `--json --no-prompt` for agent calls.

`--no-login` prevents password sign-in but permits session validation, bearer refresh and GP uplift. `--no-prompt` disables CLI prompts. `--messages-otp` opts into Messages lookup; `--force-otp` bypasses only the local cooldown.

Legacy `nhs-prescriptions otp` now requires `--messages-otp` and reports presence only. Doctor no longer requires optional Messages/sqlite on Linux. Diagnostic details and authentication errors are clarified; prescription data output remains compatible.
