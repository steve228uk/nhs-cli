# Inspecting the Android app's network traffic

Use runtime observation to connect a specific app action to its actual requests, capability checks and response structures. Combine it with [static API evidence](api-research.md); strings in an APK alone cannot establish which API a particular account uses.

## Current readiness

On 2026-09-06, the research Mac is ARM64 and the downloaded NHS App 6.4.2 XAPK is still available outside the repository. The archive contains a base APK, `config.arm64_v8a.apk`, language splits and `config.xxhdpi.apk`. Android Studio, the conventional Android SDK directory, an AVD directory, `adb`, `emulator` and mitmproxy were not found in the checked locations/PATH. The APK has **not been launched or captured** in this investigation. Installing the Android tooling and creating a dedicated AVD are prerequisites.

The package hashes, signer verification and limits of third-party download provenance are recorded in [API research](api-research.md). Recheck those before installation. Runtime success under an emulator, proxy or modified trust store remains unverified.

## Prepare an isolated device

Install Android Studio/SDK tooling from the [Android downloads](https://developer.android.com/studio), including Platform Tools, Emulator and Build Tools. Create a dedicated ARM64 AVD, named `nhs-research` in the examples below. Record the exact image/API level and whether it is AOSP, Google APIs or Google Play. Use an Android version supported by the app; manifest minimum API 26 does not guarantee the server will accept every older image.

Keep this AVD separate from normal personal devices and accounts. Its writable data image can contain app credentials and health-data caches even when the proxy never saves flows. Keep its directory private and on encrypted storage. Start without loading or saving snapshots:

```sh
emulator -list-avds
emulator -avd nhs-research -no-snapshot
```

Use a second terminal to select the exact test device from `adb devices -l`. Set `NHS_DEVICE_SERIAL` to the returned emulator serial; use `adb -s "$NHS_DEVICE_SERIAL"` on every subsequent command so a connected personal phone cannot be selected accidentally. See the [emulator command-line reference](https://developer.android.com/studio/run/emulator-commandline).

Extract only the reviewed APK entries into a private directory outside the repository. Set `NHS_APK_DIR` to that directory. Install the matching splits together on the fresh ARM64 AVD:

```sh
adb -s "$NHS_DEVICE_SERIAL" shell getprop ro.product.cpu.abilist
adb -s "$NHS_DEVICE_SERIAL" install-multiple \
  "$NHS_APK_DIR/com.nhs.online.nhsonline.apk" \
  "$NHS_APK_DIR/config.arm64_v8a.apk" \
  "$NHS_APK_DIR/config.en.apk" \
  "$NHS_APK_DIR/config.xxhdpi.apk"
```

The reviewed archive has only one ABI split. Do not install it on an x86 image or install only the base APK. Other language splits are optional for that language; select the appropriate density split for a different download. Launch the installed app from its launcher icon and verify its displayed version. A split/ABI installation error is separate from a server rejection. Refer to [ADB's install and device-selection documentation](https://developer.android.com/tools/adb).

## Establish a baseline, then a proxy

First launch the unmodified app without a proxy and inspect public startup/configuration behaviour. Record whether it starts, which login UI it opens, and any compatibility error category. Do not interpret a failed emulator launch as attestation enforcement without supporting evidence.

For HTTPS inspection, install [mitmproxy](https://docs.mitmproxy.org/stable/overview/installation/) and use its local interactive UI. Set `NHS_PROXY_DIR` to a new private directory outside Git and cloud sync, then run this in a local terminal that is not being recorded by an agent or session logger:

```sh
umask 077
: "${NHS_PROXY_DIR:?Set a new private path outside the repository}"
mkdir -m 700 "$NHS_PROXY_DIR" &&
mitmweb --listen-host 127.0.0.1 --listen-port 8080 \
  --set "confdir=$NHS_PROXY_DIR" \
  --set web_host=127.0.0.1 \
  --set web_port=8081 \
  --set ssl_insecure=false
```

Use a new directory to avoid inherited proxy addons or capture settings. Do not enable `save_stream_file`, `hardump`, a static viewer export, or request/response logging. Do not export flows as curl commands: those include authentication material. The UI and its startup access token are sensitive. Inspect locally in memory; this is not a guarantee against OS swap, browser caches or crash dumps. The proxy CA private key is created in its configuration directory and must also remain private. See [mitmproxy's options](https://docs.mitmproxy.org/stable/concepts/options/).

Configure the **Android system Wi-Fi proxy** inside the AVD to host `10.0.2.2`, port `8080`. That address reaches this host's loopback from the emulator. Use Android Settings, not Android Studio's download proxy or the emulator's Extended Controls proxy. Google's current guidance distinguishes the Android system proxy used for HTTPS debugging from the emulator `-http-proxy` tunnel; some applications can ignore the system proxy. See [proxy selection](https://developer.android.com/studio/run/emulator-networking-proxy) and [network addressing](https://developer.android.com/studio/run/emulator-networking-address).

Confirm routing with a non-sensitive browser request before opening NHS login. Limit interception to the NHS origins needed for the selected action using mitmproxy's `allow_hosts` option. A display filter only hides flows; it does not limit collection. Start with the app, login and authorization origins already documented, then review any newly observed destination before adding it. Unmatched traffic may pass through without decryption.

## Establish trust without misdiagnosing pinning

The inspected app targets API 36 and declares no custom trust anchors. Android's default policy for modern target SDKs does not trust user-installed CAs. Therefore installing the proxy certificate in the user store may make the browser work while the app still fails. This is a trust-policy issue, not proof of active pinning. See [Android network security configuration](https://developer.android.com/privacy-and-security/security-config).

If HTTPS bodies are needed, use a disposable image that permits installing the inspection CA into the system trust store, and follow instructions appropriate to that exact image. Google Play production images restrict `adb root`; recent Android images can also have different trust-store layouts. The [mitmproxy system-CA guide](https://docs.mitmproxy.org/stable/howto/install-system-trusted-ca-android/) describes the approach but documents several procedures against older API levels. Do not assume an old remount recipe works on API 36.

Record every trust-store/image change. Keep the APK unchanged for the baseline comparison and retain upstream TLS certificate verification. Do not change the Mac's global trust store, install a CA on a personal phone, or make the CLI disable TLS verification as part of this workflow.

If a correctly trusted proxy still fails, separate routing, hostname/chain validation, app-specific trust, possible active pinning, and server/device-integrity rejection. Collect a non-sensitive error category and compare the same action without the proxy. A CONNECT record or encrypted packet trace can show a destination, but cannot establish HTTP paths or JSON contracts. Do not report decrypted traffic unless it was actually visible. Instrumentation or a modified APK would be a separate experiment whose results must identify that change; it cannot prove stock-app behaviour.

## Observe one flow at a time

Use the account holder's own login or a permitted test account. The user enters credentials and MFA directly in the app; agents must not retrieve the CLI vault or extract tokens for replay. Agree the named account reads before navigating: existing authorization for those actions remains sufficient.

| Priority | Observation | Questions to resolve |
| --- | --- | --- |
| 1 | Login, normal app restart, later session expiry | Which device-cookie and body-token values rotate independently? Which API establishes the app session? Does restart reuse it? |
| 2 | First GP read after login | When is asserted-identity OAuth/GP uplift requested, and which values change? |
| 3 | Active session extension and NHS inbox | What triggers extension and bearer renewal? Is app-session expiry handled separately? |
| 4 | Version-3 results and historical results | Which service/provider, paths, list/detail schema and paging rules are actually selected? |
| 5 | Document metadata and explicit retrieval | Which provider/identifier is used? Does a POST retrieve content, start a job or change state? |
| 6 | Appointments, GP inbox and pharmacy | Which capability gates and unavailable/error shapes apply? |

Do not accelerate expiry by changing device time or repeatedly submit bad logins. Observe ordinary elapsed-time behaviour. Do not submit prescriptions, book appointments, change pharmacies or switch proxy patients while mapping reads.

Opening a message in the official app may automatically mark it read even though the CLI omits that operation. Inspect message lists and static call sites first; use a permitted test message or separately authorized read-status change for a detail-screen experiment. Do not label a UI action read-only just because its first request is GET, or block every POST indiscriminately: authentication and some document reads use POST.

## Convert observation into repository evidence

Write original notes while inspecting; retain no raw HARs, flow files, screenshots, logcat dumps, bearer tokens or patient responses in this project. Before committing notes, replace identifiers in paths with placeholders, omit query/header values, and use synthetic values for examples. Names of fields and object keys can themselves contain patient data, so a generic redaction pass is insufficient.

Use the [observation template](api-observation-template.md) for each action. Record method, origin, templated path, parameter names/types, required authentication material by **name**, response structure, capability gate, side effects, timing/retry behaviour and observed failure cases. Describe cookie scope/expiry and whether values rotated without copying or hashing the values.

Label source as `native`, `web` or `cli`, and observation as `static` or `runtime`. An account-verified native request does not automatically validate the CLI: compare its own request and selected read outcome separately. Unknown auth requirements remain unknown until observed; do not remove headers or replay requests against production merely to infer which ones are mandatory.

Update the inventory, add hand-authored synthetic fixtures, implement the smallest matching adapter and run the relevant mocked tests. Only promote an endpoint's evidence level for the client/account flow actually observed.

## Cleanup

Remove the Android Wi-Fi proxy setting, stop mitmweb, close its local browser UI and shut down the dedicated AVD without snapshots. Remove the inspection CA from the test image or delete that disposable AVD through Device Manager when finished. Remove the dedicated proxy directory containing its CA key and any accidental exports. Avoid deleting shared SDK images or unrelated devices. Deletion does not erase historical backups; isolation and encrypted storage are needed from the beginning.
