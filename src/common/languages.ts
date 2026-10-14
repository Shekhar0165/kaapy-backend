/**
 * Languages the app is translated into (Tier 1). Kept in step with
 * kaapyapp/src/i18n/languages.ts: only these codes are accepted from clients.
 */
export const ENABLED_LANGUAGES = [
  'en',
  'hi',
  'mr',
  'gu',
  'bn',
  'ta',
  'te',
  'kn',
  'ml',
  'pa',
  'or',
  'as',
] as const;
export type LanguageCode = (typeof ENABLED_LANGUAGES)[number];

/** 'en': customer messages always in English (GSM-7, cheapest). 'app': in the shop's language. */
export const MESSAGE_LANGUAGES = ['en', 'app'] as const;
export type MessageLanguage = (typeof MESSAGE_LANGUAGES)[number];

export function isEnabledLanguage(value: unknown): value is LanguageCode {
  return typeof value === 'string' && (ENABLED_LANGUAGES as readonly string[]).includes(value);
}
