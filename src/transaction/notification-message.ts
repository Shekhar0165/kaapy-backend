// The one place that builds the customer notification text. Used for both the
// SMS (sent by the app from the owner's SIM) and the email fallback, so both
// say exactly the same thing, with the time taken from the stored createdAt.

import type { LanguageCode } from '../common/languages.js';
import { MESSAGE_TEMPLATES } from './notification-templates.js';

const MAX_SHOP_NAME = 30;
const MAX_NOTE = 40;
const MIN_NOTE = 4;
const MIN_SHOP_NAME = 10;
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const INTL_LOCALES: Record<LanguageCode, string> = {
  en: 'en-IN',
  hi: 'hi-IN',
  mr: 'mr-IN',
  gu: 'gu-IN',
  bn: 'bn-IN',
  ta: 'ta-IN',
  te: 'te-IN',
  kn: 'kn-IN',
  ml: 'ml-IN',
  pa: 'pa-IN',
  or: 'or-IN',
  as: 'as-IN',
};

/**
 * A Unicode (UCS-2) SMS carries 70 characters, or 67 per part when split.
 * Three parts is the most we let a message cost the owner.
 */
export const MAX_UNICODE_MESSAGE_LENGTH = 3 * 67;

// GSM 03.38 basic character set. Anything else (₹, emoji, Hindi, curly quotes)
// would switch the SMS to UCS-2 and cut a segment from 160 to 70 characters.
const GSM7_BASIC =
  '@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7 = new Set(GSM7_BASIC);

export interface NotificationMessageInput {
  shopName: string;
  type: 'gave' | 'got';
  /** Integer paise. */
  amount: number;
  note: string | null;
  createdAt: Date;
  /** Integer paise, the customer's balance right after this entry. */
  balanceAfter: number;
  /** Message language; English when missing. */
  language?: LanguageCode;
  /** Put the item or note in the message (default true). */
  includeNote?: boolean;
}

/** Keeps only GSM-7 basic characters and collapses whitespace. */
export function toGsm7(text: string): string {
  const kept = Array.from(text.normalize('NFC').replace(/[\r\n\t]+/g, ' '))
    .filter((char) => GSM7.has(char))
    .join('');
  return kept.replace(/ {2,}/g, ' ').trim();
}

/** Any script allowed (the message is Unicode); control characters and extra spaces removed. */
function cleanUnicode(text: string): string {
  return text
    .normalize('NFC')
    // Control characters (newlines, tabs, ...) would break the SMS layout.
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Cuts at a whole letter (grapheme), so Indic vowel signs and conjuncts are never split. */
function truncate(text: string, max: number, ellipsis = '...'): string {
  if (text.length <= max) return text;
  let kept = '';
  for (const { segment } of graphemes.segment(text)) {
    if ((kept + segment).length > max - ellipsis.length) break;
    kept += segment;
  }
  return `${kept.trimEnd()}${ellipsis}`;
}

/** "1,20,000" or "120.50" from integer paise (sign dropped), Latin digits, Indian grouping. */
function groupedRupees(paise: number): string {
  const absolute = Math.abs(Math.round(paise));
  const rupees = Math.floor(absolute / 100).toString();
  const lastThree = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${lastThree}` : lastThree;
  const fraction = absolute % 100;
  return fraction === 0 ? grouped : `${grouped}.${String(fraction).padStart(2, '0')}`;
}

/** "Rs.1,20,000" (GSM-7 safe) from integer paise. */
export function formatRs(paise: number): string {
  return `Rs.${groupedRupees(paise)}`;
}

/** "₹1,20,000" from integer paise (for Unicode messages). */
export function formatRupee(paise: number): string {
  return `₹${groupedRupees(paise)}`;
}

/** "14 Oct 2026, 11:43 AM" in Asia/Kolkata (fixed +5:30, no DST). GSM-7 safe. */
export function formatIst(date: Date): string {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const hours = ist.getUTCHours();
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  const minutes = String(ist.getUTCMinutes()).padStart(2, '0');
  return `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]} ${ist.getUTCFullYear()}, ${hour12}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`;
}

/**
 * The one date/time formatter for customer messages. English keeps the GSM-7
 * format above; other languages use ICU month names with Latin digits
 * ("-u-nu-latn") in Asia/Kolkata, without the year to keep the SMS short.
 */
export function formatMessageWhen(date: Date, language: LanguageCode): string {
  if (language === 'en') return formatIst(date);
  return new Intl.DateTimeFormat(`${INTL_LOCALES[language]}-u-nu-latn`, {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(date);
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => values[key] ?? '');
}

/** Number of SMS parts the phone will use for this text. */
export function smsSegments(text: string): number {
  const isGsm = Array.from(text).every((char) => GSM7.has(char));
  if (isGsm) return text.length <= 160 ? 1 : Math.ceil(text.length / 153);
  return text.length <= 70 ? 1 : Math.ceil(text.length / 67);
}

/**
 * gave (en): "Sharma Store: Rs.500 added to your khata (Tea, biscuits) on 14 Oct 2026, 11:43 AM. Total due: Rs.5,150."
 * got  (en): "Sharma Store: Rs.500 received on 14 Oct 2026, 11:43 AM. Total due: Rs.4,650."
 * Other languages use their own full-sentence template, ₹ and Latin digits, and
 * are kept within 3 SMS parts: the note is shortened (or dropped) first, then the shop name.
 */
export function buildNotificationMessage(input: NotificationMessageInput): string {
  const language = input.language ?? 'en';
  const templates = MESSAGE_TEMPLATES[language] ?? MESSAGE_TEMPLATES.en;
  const isEnglish = language === 'en';
  const clean = isEnglish ? toGsm7 : cleanUnicode;
  const ellipsis = isEnglish ? '...' : '…';
  const money = isEnglish ? formatRs : formatRupee;

  const balanceLine =
    input.balanceAfter > 0
      ? fill(templates.due, { balance: money(input.balanceAfter) })
      : input.balanceAfter < 0
        ? fill(templates.advance, { balance: money(input.balanceAfter) })
        : templates.settled;

  const fullShop = clean(input.shopName) || 'Your shop';
  const fullNote = input.type === 'gave' && input.includeNote !== false && input.note ? clean(input.note) : '';

  const render = (shop: string, note: string) => {
    const template = input.type === 'got' ? templates.got : note ? templates.gaveNote : templates.gave;
    const first = fill(template, {
      amount: money(input.amount),
      note,
      shop,
      when: formatMessageWhen(input.createdAt, language),
    });
    return `${first} ${balanceLine}`;
  };

  let shop = truncate(fullShop, MAX_SHOP_NAME, ellipsis);
  let note = fullNote ? truncate(fullNote, MAX_NOTE, ellipsis) : '';
  let message = render(shop, note);
  if (isEnglish) return message;

  // Unicode: stay within 3 parts. Shorten the note first, then the shop name.
  while (message.length > MAX_UNICODE_MESSAGE_LENGTH && note) {
    const room = note.length - (message.length - MAX_UNICODE_MESSAGE_LENGTH);
    note = room >= MIN_NOTE + ellipsis.length ? truncate(fullNote, room, ellipsis) : '';
    message = render(shop, note);
  }
  while (message.length > MAX_UNICODE_MESSAGE_LENGTH && shop.length > MIN_SHOP_NAME) {
    const room = Math.max(MIN_SHOP_NAME, shop.length - (message.length - MAX_UNICODE_MESSAGE_LENGTH));
    shop = truncate(fullShop, room, ellipsis);
    message = render(shop, note);
  }
  return message;
}

/** Subject line for the fallback email, in the message language. */
export function buildEmailSubject(shopName: string, language: LanguageCode = 'en'): string {
  const templates = MESSAGE_TEMPLATES[language] ?? MESSAGE_TEMPLATES.en;
  const shop = (language === 'en' ? toGsm7(shopName) : cleanUnicode(shopName)) || 'Your shop';
  return fill(templates.emailSubject, { shop: truncate(shop, MAX_SHOP_NAME, language === 'en' ? '...' : '…') });
}

/**
 * Which language a customer message uses: English when the shop chose English
 * messages, otherwise the shop's language (English if it has no template).
 */
export function resolveMessageLanguage(
  messageLanguage: 'en' | 'app',
  shopLanguage: LanguageCode,
): LanguageCode {
  if (messageLanguage === 'en') return 'en';
  return MESSAGE_TEMPLATES[shopLanguage] ? shopLanguage : 'en';
}
