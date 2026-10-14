import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;

/** `salt:hash`, both hex, using scrypt. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, KEY_LENGTH).toString('hex')}`;
}

/**
 * False for Google-created shops, whose stored value is random hex with no
 * salt and can never match a password.
 */
export function hasUsablePassword(storedHash: string | undefined): boolean {
  const [salt, hash] = storedHash?.split(':') ?? [];
  return Boolean(salt && hash && hash.length === KEY_LENGTH * 2);
}

export function verifyPassword(password: string, storedHash: string): boolean {
  if (!hasUsablePassword(storedHash)) return false;
  const [salt, hash] = storedHash.split(':');
  const derivedHash = scryptSync(password, salt, KEY_LENGTH);
  return timingSafeEqual(derivedHash, Buffer.from(hash, 'hex'));
}
