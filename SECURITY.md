# Security

This unofficial project processes authentication secrets and health information. Supported persistence is OS-keyring-backed authenticated encryption, or explicitly configured encryption with a separately injected key. Plaintext credential/session storage is not supported.

Sensitive boundaries include cookie scoping, OAuth validation, keyring fallback, migration, patient-context selection, output filtering and submission retries. OS credential storage does not protect against malicious software already running as the same user or a compromised secret manager.

Report vulnerabilities privately through the repository host's private reporting facility when available. Otherwise, open a minimal issue requesting a private contact method without exploit details, authentication material or patient information. For NHS service vulnerabilities, use the NHS's own disclosure channel.

Provide synthetic reproductions and the affected CLI version. Do not test other accounts or modify real healthcare data. Rotate/revoke exposed material through its source and the official service; deleting a file does not remove it from history or backups.
