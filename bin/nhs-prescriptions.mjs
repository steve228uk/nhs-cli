#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { main } from '../src/cli.mjs';

// Preserve legacy commands and helper imports while sharing the secure client.
export { buildStatusPayload, parsePositiveInteger } from '../src/domains.mjs';
export { parseCredentialsPayload } from '../src/credentials.mjs';
export { redact } from '../src/errors.mjs';
export { extractOtpCode, isLikelyNhsOtpText } from '../src/otp.mjs';
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main(process.argv.slice(2), true);
