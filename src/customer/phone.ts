// Indian mobile numbers: 10 digits starting with 6, 7, 8 or 9.
const MOBILE_PATTERN = /^[6-9]\d{9}$/;

/**
 * Normalizes an Indian mobile number to E.164 (+91XXXXXXXXXX).
 * Accepts "+91", "91", "0091" and "0" prefixes, plus spaces, dashes, dots and
 * brackets. Returns null when the result is not a valid Indian mobile number.
 */
export function normalizeIndianMobile(input: unknown): string | null {
  if (typeof input !== 'string') return null;

  const compact = input.trim().replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(compact)) return null;

  const digits = compact.replace(/^\+/, '');
  let national: string;
  if (compact.startsWith('+')) {
    if (!digits.startsWith('91')) return null;
    national = digits.slice(2);
  } else if (digits.length === 14 && digits.startsWith('0091')) {
    national = digits.slice(4);
  } else if (digits.length === 12 && digits.startsWith('91')) {
    national = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    national = digits.slice(1);
  } else {
    national = digits;
  }

  return MOBILE_PATTERN.test(national) ? `+91${national}` : null;
}
