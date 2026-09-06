export class NhsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'NhsError';
    this.code = code;
    this.details = details;
  }
}

export function redact(value) {
  return String(value ?? '')
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/g, '[redacted-jwt]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[redacted-token]')
    .replace(/\b\d{6}\b/g, '[redacted-code]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/((?:NHSO-Session-[\w-]+|authorization|cookie|csrfToken|email|id_token|password|patientId|patientSessionId|phone_number|phoneNumber|sessionId|sessionExpiry|token|rmdToken|rememberMyDevice|code|state|nonce)["']?\s*[:=]\s*)[^\s&,;}]+/gi, '$1[redacted]');
}

// Upstream bodies and native exception messages can contain arbitrary secrets.
// Only our own constant messages and explicitly selected metadata reach output.
export function errorPayload(error) {
  if (!(error instanceof NhsError)) return { ok: false, code: 'unexpected_error', message: 'Unexpected failure. Run nhs doctor to check local prerequisites.' };
  const details = {};
  if (Number.isInteger(error.details?.status)) details.status = error.details.status;
  if (typeof error.details?.capability === 'string') details.capability = error.details.capability;
  return { ok: false, code: error.code, message: redact(error.message), ...details };
}

export function shape(condition, message = 'NHS returned an unsupported response structure.') {
  if (!condition) throw new NhsError('invalid_response', message);
}
