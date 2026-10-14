import type { LanguageCode } from '../common/languages.js';

/**
 * Customer message templates, one full sentence set per language (never glued
 * from fragments). Placeholders: {shop} {amount} {note} {when} {balance}.
 *
 * English stays GSM-7 ("Rs.", plain ASCII). Other languages are Unicode anyway,
 * so they use the ₹ sign; digits are always Latin (0-9).
 *
 * Status: ai-draft. A native speaker must review these before release
 * (see kaapyapp/LANGUAGES.md).
 */
export interface MessageTemplates {
  /** The shop gave goods on credit, with the item or note. */
  gaveNote: string;
  gave: string;
  /** The shop received money. */
  got: string;
  due: string;
  advance: string;
  settled: string;
  /** Email subject for the fallback email. */
  emailSubject: string;
}

export const MESSAGE_TEMPLATES: Record<LanguageCode, MessageTemplates> = {
  en: {
    gaveNote: '{shop}: {amount} added to your khata ({note}) on {when}.',
    gave: '{shop}: {amount} added to your khata on {when}.',
    got: '{shop}: {amount} received on {when}.',
    due: 'Total due: {balance}.',
    advance: 'Advance: {balance}.',
    settled: 'No dues.',
    emailSubject: '{shop}: khata update',
  },
  hi: {
    gaveNote: '{shop}: आपके खाते में {amount} उधार लिखा ({note}), {when}।',
    gave: '{shop}: आपके खाते में {amount} उधार लिखा, {when}।',
    got: '{shop}: आपसे {amount} मिले, {when}।',
    due: 'कुल बाकी: {balance}।',
    advance: 'एडवांस: {balance}।',
    settled: 'कोई बाकी नहीं।',
    emailSubject: '{shop}: खाते का हिसाब',
  },
  mr: {
    gaveNote: '{shop}: तुमच्या खात्यात {amount} उधार लिहिले ({note}), {when}.',
    gave: '{shop}: तुमच्या खात्यात {amount} उधार लिहिले, {when}.',
    got: '{shop}: तुमच्याकडून {amount} मिळाले, {when}.',
    due: 'एकूण बाकी: {balance}.',
    advance: 'ॲडव्हान्स: {balance}.',
    settled: 'काहीही बाकी नाही.',
    emailSubject: '{shop}: खात्याचा हिशोब',
  },
  gu: {
    gaveNote: '{shop}: તમારા ખાતામાં {amount} ઉધાર લખ્યા ({note}), {when}.',
    gave: '{shop}: તમારા ખાતામાં {amount} ઉધાર લખ્યા, {when}.',
    got: '{shop}: તમારી પાસેથી {amount} મળ્યા, {when}.',
    due: 'કુલ બાકી: {balance}.',
    advance: 'એડવાન્સ: {balance}.',
    settled: 'કંઈ બાકી નથી.',
    emailSubject: '{shop}: ખાતાનો હિસાબ',
  },
  bn: {
    gaveNote: '{shop}: আপনার খাতায় {amount} বাকি লেখা হল ({note}), {when}।',
    gave: '{shop}: আপনার খাতায় {amount} বাকি লেখা হল, {when}।',
    got: '{shop}: আপনার থেকে {amount} পাওয়া গেল, {when}।',
    due: 'মোট বাকি: {balance}।',
    advance: 'অ্যাডভান্স: {balance}।',
    settled: 'কোনো বাকি নেই।',
    emailSubject: '{shop}: খাতার হিসাব',
  },
  ta: {
    gaveNote: '{shop}: உங்கள் கணக்கில் {amount} கடன் எழுதப்பட்டது ({note}), {when}.',
    gave: '{shop}: உங்கள் கணக்கில் {amount} கடன் எழுதப்பட்டது, {when}.',
    got: '{shop}: உங்களிடமிருந்து {amount} வந்தது, {when}.',
    due: 'மொத்த பாக்கி: {balance}.',
    advance: 'அட்வான்ஸ்: {balance}.',
    settled: 'பாக்கி எதுவும் இல்லை.',
    emailSubject: '{shop}: கணக்கு விவரம்',
  },
  te: {
    gaveNote: '{shop}: మీ ఖాతాలో {amount} అప్పు రాశాం ({note}), {when}.',
    gave: '{shop}: మీ ఖాతాలో {amount} అప్పు రాశాం, {when}.',
    got: '{shop}: మీ నుండి {amount} అందింది, {when}.',
    due: 'మొత్తం బాకీ: {balance}.',
    advance: 'అడ్వాన్స్: {balance}.',
    settled: 'బాకీ ఏమీ లేదు.',
    emailSubject: '{shop}: ఖాతా వివరాలు',
  },
  kn: {
    gaveNote: '{shop}: ನಿಮ್ಮ ಖಾತೆಗೆ {amount} ಸಾಲ ಬರೆಯಲಾಗಿದೆ ({note}), {when}.',
    gave: '{shop}: ನಿಮ್ಮ ಖಾತೆಗೆ {amount} ಸಾಲ ಬರೆಯಲಾಗಿದೆ, {when}.',
    got: '{shop}: ನಿಮ್ಮಿಂದ {amount} ಬಂದಿದೆ, {when}.',
    due: 'ಒಟ್ಟು ಬಾಕಿ: {balance}.',
    advance: 'ಅಡ್ವಾನ್ಸ್: {balance}.',
    settled: 'ಯಾವುದೇ ಬಾಕಿ ಇಲ್ಲ.',
    emailSubject: '{shop}: ಖಾತೆ ವಿವರ',
  },
  ml: {
    gaveNote: '{shop}: നിങ്ങളുടെ കണക്കിൽ {amount} കടം എഴുതി ({note}), {when}.',
    gave: '{shop}: നിങ്ങളുടെ കണക്കിൽ {amount} കടം എഴുതി, {when}.',
    got: '{shop}: നിങ്ങളിൽ നിന്ന് {amount} കിട്ടി, {when}.',
    due: 'ആകെ ബാക്കി: {balance}.',
    advance: 'അഡ്വാൻസ്: {balance}.',
    settled: 'ബാക്കി ഒന്നുമില്ല.',
    emailSubject: '{shop}: കണക്ക് വിവരം',
  },
  pa: {
    gaveNote: '{shop}: ਤੁਹਾਡੇ ਖਾਤੇ ਵਿੱਚ {amount} ਉਧਾਰ ਲਿਖਿਆ ({note}), {when}।',
    gave: '{shop}: ਤੁਹਾਡੇ ਖਾਤੇ ਵਿੱਚ {amount} ਉਧਾਰ ਲਿਖਿਆ, {when}।',
    got: '{shop}: ਤੁਹਾਡੇ ਤੋਂ {amount} ਮਿਲੇ, {when}।',
    due: 'ਕੁੱਲ ਬਾਕੀ: {balance}।',
    advance: 'ਐਡਵਾਂਸ: {balance}।',
    settled: 'ਕੋਈ ਬਾਕੀ ਨਹੀਂ।',
    emailSubject: '{shop}: ਖਾਤੇ ਦਾ ਹਿਸਾਬ',
  },
  or: {
    gaveNote: '{shop}: ଆପଣଙ୍କ ଖାତାରେ {amount} ଉଧାର ଲେଖାଗଲା ({note}), {when}।',
    gave: '{shop}: ଆପଣଙ୍କ ଖାତାରେ {amount} ଉଧାର ଲେଖାଗଲା, {when}।',
    got: '{shop}: ଆପଣଙ୍କଠାରୁ {amount} ମିଳିଲା, {when}।',
    due: 'ମୋଟ ବାକି: {balance}।',
    advance: 'ଆଡଭାନ୍ସ: {balance}।',
    settled: 'କିଛି ବାକି ନାହିଁ।',
    emailSubject: '{shop}: ଖାତା ହିସାବ',
  },
  as: {
    gaveNote: "{shop}: আপোনাৰ খাতাত {amount} বাকী লিখা হ'ল ({note}), {when}।",
    gave: "{shop}: আপোনাৰ খাতাত {amount} বাকী লিখা হ'ল, {when}।",
    got: "{shop}: আপোনাৰ পৰা {amount} পোৱা গ'ল, {when}।",
    due: 'মুঠ বাকী: {balance}।',
    advance: 'এডভান্স: {balance}।',
    settled: 'একো বাকী নাই।',
    emailSubject: '{shop}: খাতাৰ হিচাপ',
  },
};
