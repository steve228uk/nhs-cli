/**
 * @typedef {{email: string, password: string}} Credentials
 * @typedef {{csrfToken?: string, patientId?: string, sessionId?: string,
 * sessionExpiry?: string, accessToken?: string, rememberMyDevice?: string,
 * rmdToken?: string, lastOtpTriggerAt?: string, updatedAt?: string,
 * hasGpSession?: boolean, sessionTimeout?: number, checkedAt?: number,
 * cookies?: import('tough-cookie').SerializedCookieJar}} Session
 * @typedef {{version: 1, session: Session, credentials?: Credentials, credentialAccount?: string, legacyMigrated?: boolean, legacyMigrationDigest?: string}} Vault
 * @typedef {{load(): Promise<Vault>, save(value: Vault): Promise<void>,
 * probe(): Promise<void>, backend: string}} SecureStore
 */
export {};
