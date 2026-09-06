# API research and evidence

Inspected on 2026-09-06. This document is an original description of observed interfaces, not redistributed NHS source. Downloaded packages, public JavaScript and disassembly remain outside the repository. No patient account was queried during this work.

## Evidence levels

- **Client-observed**: a shipped client method and/or its call site establishes the contract. This does not establish entitlement, current server behaviour, or success for an account.
- **Account-verified**: explicitly authorized live authentication/read with a recorded date, client version and redacted outcome. Capability discovery and current medicines have this designation for the CLI checks recorded below; other new read adapters remain client-observed.
- **Unverified**: inference, library-only evidence, or an incomplete contract. Do not turn it into a working command by guessing.

Synthetic tests check our implementation against these contracts, not the NHS server. Capability configuration can differ by practice, supplier, account and rollout.

## Android provenance and integrity

The package was fetched from [APKPure's NHS App listing](https://apkpure.com/nhs-app/com.nhs.online.nhsonline) using its latest XAPK download endpoint. That URL is mutable; use the hashes below to identify this inspection. This is a third-party distribution, not a direct Google Play acquisition.

| Property | Observation |
| --- | --- |
| Package | `com.nhs.online.nhsonline` |
| Manifest version | `6.4.2`, code `44150` |
| SDK | minimum 26, target 36 |
| Container | 13,175,738 bytes; base APK and 19 split APKs |
| XAPK SHA-256 | `b298d993a6a185e4ae29e525edf95c86515ca73f861687bd72ace18c3db2f2cb` |
| Base APK SHA-256 | `a942d06796ce0a95dc1c0de94c3bf292582b12fbf67daa353cbdb7c9ec5a7688` |
| Signer certificate SHA-256 | `154851accf1efe0919abb77db883b0bd7f6938f97a7fd2859c8bc8c47bac9559` |
| Signer certificate SHA-1 | `37a79c75227ef5c2344d7de54dc8858a0b60cc35` |

Using Androguard 4.1.3 to parse signing blocks and Python cryptography to verify signatures, all 20 APKs passed APK Signature Scheme v2 signature and content-digest verification. The signer used algorithm `0x0104` (RSA PKCS#1 v1.5 with SHA-512). Verification checked the signed-data signature, equality of the signer key and certificate key, and recomputed the specified 1 MiB chunk digests over the pre-signing-block bytes, central directory and EOCD with its central-directory offset adjusted to the signing-block start. The signed aggregate digest matched for every APK.

The certificate SHA-1 also matches an APKPure release listing. These checks establish integrity under that signing key, not independent proof of NHS/Google Play provenance. No modified APK was installed, no signing identity was forged, and no runtime bypass was attempted. See the [Android v2 signature specification](https://source.android.com/docs/security/features/apksigning/v2).

### Authentication and transport references

Names below are obfuscated symbols in the inspected base DEX, under `com/nhs/online/nhsonline`; they are version-specific references.

| Mechanism | Application evidence and limits |
| --- | --- |
| OAuth/PKCE | Web authorization requests use authorization code, S256 challenge, nonce, state, `nhs-online`, the app callback and GP registration scopes. The app session creation exchanges code, verifier and nonce server-side. The CLI follows this web flow; it does not pretend to possess a native private key. |
| Remembered device | The public login client sends `remember_my_device` cookie material in the sign-in body's `rmd_token`; responses may independently return a token or `INVALID`. SMS verification is followed by an explicit remember-device operation. This is distinct from app-session persistence. |
| FIDO/biometrics | `zk` constructs `/authRequest`; `zk.a(String,String,BiometricPrompt.CryptoObject,Context)` requests a challenge and uses a biometric-provided Signature and stored key pair for a UAF response. `rl.e(...)` constructs and submits a signed registration response, checking `SUCCESS`. Production configuration in `zx2.<clinit>` names `uaf.login.nhs.uk`; test/stub variants also exist. This is application flow evidence, not merely FIDO library presence. |
| Keystore | `k01` configures `AndroidKeyStore`, `secp256r1`, `SHA256withECDSA`; `k01.e(String,boolean)` creates a signing key with SHA-256/384/512 digests and forwards its boolean to `setUserAuthenticationRequired`. `cm.a(...)` calls key generation; `cm.g(...)` retrieves a private key and initializes the signer. Alias prefix: `com.nhs.online.nhsonline.fidouafclient.keystore.key`. Do not claim every generated key unconditionally requires biometrics. |
| Key attestation | On API 28+, `k01.e` sets a 16-byte zero attestation challenge and biometric-enrollment invalidation. That setter alone does not prove server-enforced attestation or Play Integrity checks. Enforcement was not established. |
| Cleartext/TLS | `res/xml/network_security_config.xml` declares `cleartextTrafficPermitted="false"` and no pin set. TLS verification stays enabled in the CLI. |
| Certificate pinning | The relocated OkHttp pinner `yu` contains ordinary pin checking; `yu.<clinit>` builds an empty default through `yu$a`. Inspection of references to that builder found no application call adding pins. Library presence is not evidence of active application pinning. Runtime/native/other-SDK pins have not been exhaustively ruled out. |

Official background: [OIDC flow](https://nhsconnect.github.io/nhslogin/oidc-login-flow/), [session management](https://nhsconnect.github.io/nhslogin/session-management/), [FIDO](https://nhsconnect.github.io/nhslogin/fido/), and [managing remembered devices](https://help.login.nhs.uk/manage/devices). These partner interfaces do not make NHS App private routes a supported third-party API.

## Public web-client evidence

The [public configuration](https://www.nhsapp.service.nhs.uk/v4-76-3/config.json) reported `v4.76.3`, commit `bfaf34f72f`, with minimum Android/iOS version `6.3.0`. The inspected app bundle was `app.0b0976c0.js`. Generated methods establish paths and parameters; Vuex actions/consumers establish response fields and capability choices. `src/config.mjs` centralizes compatibility headers; update it with fresh evidence rather than copying an old native-version string. The CLI uses web metadata, not the previous `ios 6.2.0` value.

The [public login client](https://access.login.nhs.uk/) served `main-CZQNUBVB.js` and `chunk-QBZCHNOG.js`. The latter's `userSignIn`, `otp`, `rmd`, `triggerOtp` and session-service methods establish current request bodies. The main bundle's `userSignInSuccess$` handles `VERIFIED` as the MFA state, with mobile, landline and TOTP choices. `AUTHENTICATED` follows the returned redirect. TOTP/landline/registration steps are not implemented in the CLI and return `auth_required`; unknown states fail with `auth_flow_changed`.

The current OTP request includes `otp_type: "mobile"`. Remember-device selection happens in the subsequent POST with `remember_my_device: "true"`. The response body token and cookie are kept separately; the cookie is preferred for later sign-in, matching `getRememberMyDevice()` in the client. See the NHS's [2026 release notes](https://digital.nhs.uk/services/nhs-login/nhs-login-for-partners-and-developers/service-updates-and-releases/releases-2026) for the moved remember-device step. The user completed CLI sign-in on 2026-09-06; remembered-device material was saved. The complete raw authentication exchange was not captured, so individual MFA/renewal branches remain supported by client evidence and synthetic tests.

## Origins and session mechanisms

| Name | Origin/base | Purpose |
| --- | --- | --- |
| App | `https://www.nhsapp.service.nhs.uk` | Web app and exact OAuth callbacks |
| App API | `https://api.nhsapp.service.nhs.uk` | App cookies, CSRF and patient context |
| Login API | `https://api.login.nhs.uk` | Credential and SMS steps |
| Authorization | `https://auth.login.nhs.uk` | OIDC authorize, authcode |
| Login UI | `https://access.login.nhs.uk` | Authorization-cookie and browser login |
| GP Connect | `https://gpconnectapi.nhsapp.service.nhs.uk/api` | Own-account document references/content |

App authentication uses URL-scoped `NHSO-Session-Id`/`NHSO-Session-Expiry` cookies, `X-CSRF-TOKEN`, and `NHSO-Patient-Id` (patient-session context, not an arbitrary NHS number). The session response supplies `token`, `patientSessionId`, `hasGpSession`, `sessionTimeout`, sometimes `accessToken` and own-account `nhsNumber`. The last value stays in memory for document routing. GP uplift obtains an asserted identity, follows a separate OAuth callback and updates the app session. It is needed before GP operations, including after a fresh login.

App session extension prolongs an active session. Access-token renewal obtains a bearer token inside a valid session; it is not an OAuth refresh-token grant. Neither is assumed capable of resurrecting an expired app session. The server's 401 is distinct from permission, throttle, provider and service failures. Remember-device state can reduce interaction during another credential sign-in but cannot guarantee it.

## Authentication inventory

All routes in this table are **client-observed**, with synthetic validation only.

| Origin | Method/path | Parameters and response | Semantics |
| --- | --- | --- | --- |
| Authorization | GET `/authorize` | code, client, redirect, scope, vtr, nonce, state, S256 challenge; redirects and authorization cookie | Begins login; bounded and destination/state checked |
| Login API | POST `/login/user-sign-in` | email, password, rmd_token; authentication_state, methods, redirect_uri, rmd_token | Credential authentication |
| Login API | POST `/login/trigger-otp` | is_login, otp_type | Sends an SMS: only interactive or explicit Messages flow |
| Login API | POST `/login/otp` | client_id, session_id, otp_code, otp_type; id_token | Verifies challenge |
| Login API | POST `/login/remember-my-device` | remember_my_device; optional token and Set-Cookie | Registers/renews remembered device |
| Authorization | POST `/authcode` | OIDC cookie parameters; ID-token Authorization; Location | Code exchange; exact callback checked |
| App API | POST `/v1/session` | authCode, codeVerifier, redirectUrl, nonce, referrers; session fields/cookies | Creates app session |
| App API | GET `/v1/session` | app context; session fields/cookies | Validates/rotates existing session |
| App API | POST `/v1/session/extend` | app context | Extends only active session |
| App API | DELETE `/v1/session` | app context | Ends server session, best effort at logout |
| App API | POST `/v1/patient/asserted-login-identity` | IntendedRelyingPartyUrl; token | Creates assertion for GP uplift |
| App API | PUT `/v1/session/gp-session-on-demand` | authCode, redirectUrl, referrers; session fields | Establishes GP session after asserted-identity OAuth |
| App API | POST `/v1/patient/authorization/access-token/refresh` | app context; `{token}` | Renews service bearer token |

## Read and prescription inventory

Unless specified, origin is App API and authentication is app cookie + CSRF + patient context. **GP** adds GP uplift; **bearer** adds access-token Authorization. The CLI discovers `GET /v1/patient/journey-configuration`, consuming `{journeys}` before gated services. Routes are **client-observed** unless account verification is explicitly recorded. CLI 0.1.0 (web compatibility 4.76.3) passed live capability discovery and current-medicines reads on 2026-09-06, with separate processes reusing authentication. These two reads are **account-verified**; capability advertisement does not verify the other endpoints. Unknown provider versions are explicitly unsupported.

| Command/contract | Method/path and parameters | Gate/auth | Observed response and effects |
| --- | --- | --- | --- |
| Capabilities | GET `/v1/patient/journey-configuration` | app | `{journeys}`; read; account-verified 2026-09-06 |
| Medicines | GET `/v1/patient/courses` | prescriptions.provider=im1; GP | courses with id/name/details/requestable, specialRequestNecessity; read; account-verified 2026-09-06 |
| Prescription history | GET `/v1/patient/prescriptions?fromDate=<ISO>` | same; GP | prescriptions[], courses[]; read, default six months |
| Existing ordering | POST `/v1/patient/prescriptions` with CourseIds, SpecialRequest | same; GP; exact scoped user approval | 201 acknowledgement; clinical write, never automatically retried |
| Records | GET `/v1/patient/my-record` | medicalRecord.version=1/2; GP | response with access flags and sections; read |
| Results list | Same record endpoint, testResults section | classic IM1 results; GP | testResults; read; version 3 is unsupported |
| Result detail | GET `/v1/patient/test-result?testResultId=<id>` | same; GP | `{response}`; read |
| Historic results | GET `/v1/patient/historic-test-results/:year` | same; GP | `{response}`; read |
| Appointments | GET `/v1/patient/appointments` | appointments.provider=im1; GP | upcomingAppointments[], pastAppointments[], availability flags; read |
| Available slots | GET `/v1/patient/appointment-slots` | same; GP | slots[], booking guidance, reason necessity, contact fields; read only |
| GP inbox | GET `/v1/patient/messages` | im1Messaging.isEnabled; GP | messageSummaries[]; read |
| GP message | GET `/v1/patient/messages/:id` | same; GP | messageDetails; no separate updateReadStatus PUT |
| NHS inbox | GET `/v2/api/users/me/messages?index=0&count=20` | messaging; bearer | messages[], canLoadMore; bounded explicit pages |
| NHS message | GET `/v1/api/users/me/messages/:id` | same; bearer | message object; no read-status PATCH |
| Profile | GET `/v1/patient/demographics` | app; server enforces access | response with demographic/GP fields; read |
| Pharmacy | GET `/v1/patient/nominated-pharmacy` | nominatedPharmacy | pharmacyDetails and metadata; read |
| Document metadata | GP Connect GET `/v1/AccessDocuments/Patient/:nhsNumber/DocumentReference` | documents; GP; own account only | patientDocuments[] with id, description, size, etc.; read |
| Document download | GP Connect GET `/v1/AccessDocuments/Download/:id`, `Prefer: statuscode=200` | same; ID must be in current list | content (base64), contentType; read, written only with explicit output |

An empty list is accepted only with the expected response container. Per-section access/error flags remain in output; they are not interpreted as reassuring clinical absence. Response bodies have an 8 MiB bound, including base64 document content. The CLI does not invent pagination for routes without observed pagination parameters.

### Observed but not implemented

The generated IM1 document methods include POST `/v1/documents/:documentIdentifier` with `type` and `name` to obtain content, and a `/download` variant returning bytes. These POSTs retrieve documents; HTTP method alone does not make them clinical writes. They remain unimplemented because provider-specific identifiers and contracts need fuller mapping. GP Connect prescriptions, version-3 results, linked/proxy accounts, third-party portals, and new appointment/message/pharmacy write workflows are excluded. The public bundle also contains service origins beyond this CLI's allowlist; their presence is not permission to use them.

## Updating evidence and live checks

For runtime mapping, follow [Android network inspection](android-network-inspection.md) and record original notes using the [observation template](api-observation-template.md). Track both the source client and static/runtime observation method. Native-app success does not, by itself, verify the CLI contract.

Re-record date, hashes, signer verification and source symbols when upgrading. Keep public-client artifacts outside Git, inspect call sites rather than just string matches, and add synthetic tests before wiring a route. Review service-journey defaults and alternative providers; `null` IM1 results version selects the classic path, while version `3` selects a separate path this CLI does not implement.

Live smoke checks are manual, explicitly requested and limited to named authentication/read commands. Use `nhs auth status`, then the requested login/read operation with `--no-prompt` where appropriate. Record only version, command category, date and success/error code. Do not save patient responses, tokens, screenshots, HARs or credentials as test evidence. Never include a prescription submission in a smoke test.
