import { ENABLED_LANGUAGES, type LanguageCode } from '../src/common/languages.js';
import {
  buildEmailSubject,
  buildNotificationMessage,
  formatMessageWhen,
  MAX_UNICODE_MESSAGE_LENGTH,
  resolveMessageLanguage,
  smsSegments,
} from '../src/transaction/notification-message.js';
import { MESSAGE_TEMPLATES } from '../src/transaction/notification-templates.js';

// 06:13 UTC = 11:43 AM in India.
const createdAt = new Date('2026-10-14T06:13:00.000Z');
const base = {
  amount: 120000_00,
  balanceAfter: 515000,
  createdAt,
  note: 'Rice 5 kg, cooking oil',
  shopName: 'Sharma General Store',
  type: 'gave' as const,
};

/** Any decimal digit that is not 0-9 (Devanagari, Bengali, Tamil, ...). */
const NON_LATIN_DIGIT = /(?![0-9])\p{Nd}/u;

describe('customer message templates', () => {
  it('has a template set for every enabled language, with the same placeholders as English', () => {
    expect(Object.keys(MESSAGE_TEMPLATES).sort()).toEqual([...ENABLED_LANGUAGES].sort());
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort().join(',');
    for (const language of ENABLED_LANGUAGES) {
      for (const [key, english] of Object.entries(MESSAGE_TEMPLATES.en)) {
        const text = MESSAGE_TEMPLATES[language][key as keyof typeof MESSAGE_TEMPLATES.en];
        expect(text.trim(), `${language}.${key}`).not.toBe('');
        expect(placeholders(text), `${language}.${key}`).toBe(placeholders(english));
      }
    }
  });

  describe.each(ENABLED_LANGUAGES.map((language) => [language]))('%s', (language: LanguageCode) => {
    const cases = [
      { ...base, language },
      { ...base, language, note: null },
      { ...base, language, type: 'got' as const, balanceAfter: 0 },
      { ...base, language, type: 'got' as const, balanceAfter: -2550 },
      { ...base, language, amount: 50, balanceAfter: 1 },
    ];

    it.each(cases.map((input, index) => [index, input]))('renders case %i cleanly', (_index, input) => {
      const text = buildNotificationMessage(input);
      expect(text).not.toMatch(/undefined|null|NaN|\{|\}/);
      expect(text).not.toMatch(NON_LATIN_DIGIT);
      expect(text).toContain(language === 'en' ? 'Rs.' : '₹');
      if (language !== 'en') {
        expect(text).not.toContain('Rs.');
        expect(smsSegments(text)).toBeLessThanOrEqual(3);
      }
    });

    it('writes the amount with Indian grouping and the time in IST', () => {
      const text = buildNotificationMessage({ ...base, language });
      expect(text).toContain(language === 'en' ? 'Rs.1,20,000' : '₹1,20,000');
      expect(text).toMatch(/11[:.]43/);
      expect(formatMessageWhen(createdAt, language)).toContain('14');
    });

    it('includes the note only when asked', () => {
      expect(buildNotificationMessage({ ...base, language })).toContain('Rice 5 kg');
      expect(buildNotificationMessage({ ...base, language, includeNote: false })).not.toContain('Rice');
    });

    it('stays within 3 SMS parts with a very long shop name and note', () => {
      const text = buildNotificationMessage({
        ...base,
        language,
        note: 'चावल '.repeat(40),
        shopName: 'श्री गणेश किराना एंड जनरल प्रोविज़न स्टोर '.repeat(3),
      });
      if (language === 'en') {
        // English drops non-GSM characters; it is always short.
        expect(smsSegments(text)).toBeLessThanOrEqual(3);
      } else {
        expect(text.length).toBeLessThanOrEqual(MAX_UNICODE_MESSAGE_LENGTH);
        expect(text).not.toMatch(/undefined|\{/);
      }
    });

    it('has a translated email subject', () => {
      const subject = buildEmailSubject('Sharma Store', language);
      expect(subject).toContain('Sharma Store');
      expect(subject).not.toMatch(/\{|undefined/);
    });
  });

  it('keeps English byte-for-byte as before (GSM-7, "Rs.", year)', () => {
    expect(buildNotificationMessage({ ...base, amount: 50000, balanceAfter: 515000, note: 'Tea, biscuits' })).toBe(
      'Sharma General Store: Rs.500 added to your khata (Tea, biscuits) on 14 Oct 2026, 11:43 AM. Total due: Rs.5,150.',
    );
    expect(smsSegments(buildNotificationMessage(base))).toBe(1);
  });

  it('shortens the note before the shop name, and the shop name only if still needed', () => {
    const longNote = 'பருப்பு அரிசி எண்ணெய் சர்க்கரை '.repeat(10);
    const text = buildNotificationMessage({ ...base, language: 'ml', note: longNote });
    expect(text).toContain('Sharma General Store');
    expect(text.length).toBeLessThanOrEqual(MAX_UNICODE_MESSAGE_LENGTH);
  });

  it('never splits an Indic letter when shortening', () => {
    const text = buildNotificationMessage({ ...base, language: 'hi', note: 'क्षत्रिय '.repeat(30) });
    // A cut letter would leave a dangling virama (्) right before the ellipsis.
    expect(text).not.toMatch(/्…/);
  });

  it('chooses the message language from the shop settings', () => {
    expect(resolveMessageLanguage('en', 'ta')).toBe('en');
    expect(resolveMessageLanguage('app', 'ta')).toBe('ta');
    expect(resolveMessageLanguage('app', 'en')).toBe('en');
    expect(buildNotificationMessage({ ...base, language: resolveMessageLanguage('app', 'en') })).toBe(
      buildNotificationMessage(base),
    );
  });
});
