/**
 * Rough Devanagari -> Roman (Hinglish) for showing voice text in Latin
 * letters, e.g. "जल्दी दो पैकेट चीनी" -> "jaldi do paiket chini". Latin text
 * passes through unchanged, so mixed Hindi/English stays readable.
 * Mirrors backend/app/services/voice_text.py's transliterate().
 */

const CONSONANTS: Record<string, string> = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n",
  "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
  "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
  "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
  "य": "y", "र": "r", "ल": "l", "व": "v",
  "श": "sh", "ष": "sh", "स": "s", "ह": "h",
};
const NUKTA_CONSONANTS: Record<string, string> = { "क": "q", "ख": "kh", "ग": "g", "ज": "z", "ड": "r", "ढ": "rh", "फ": "f" };
const VOWELS: Record<string, string> = {
  "अ": "a", "आ": "a", "इ": "i", "ई": "i", "उ": "u", "ऊ": "u",
  "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऋ": "ri",
};
const MATRAS: Record<string, string> = {
  "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u",
  "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ृ": "ri",
};
const NASAL: Record<string, string> = { "ं": "n", "ँ": "n", "ः": "h" };
const VIRAMA = "्";
const NUKTA = "़";
const DEVANAGARI_DIGITS = "०१२३४५६७८९";

export function hasDevanagari(text: string): boolean {
  return /[ऀ-ॿ]/.test(text);
}

export function toRoman(input: string): string {
  if (!hasDevanagari(input)) return input;
  // Split precomposed nukta letters (क़ ज़ ड़ ...) into letter + nukta.
  const text = input.normalize("NFD");
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1] ?? "";
    const digit = DEVANAGARI_DIGITS.indexOf(ch);
    if (digit >= 0) {
      out += String(digit);
    } else if (ch in CONSONANTS) {
      let latin = CONSONANTS[ch]!;
      let after = next;
      if (after === NUKTA) {
        latin = NUKTA_CONSONANTS[ch] ?? latin;
        i++;
        after = text[i + 1] ?? "";
      }
      if (after in MATRAS) {
        out += latin + MATRAS[after];
        i++;
      } else if (after === VIRAMA) {
        out += latin;
        i++;
      } else {
        // Inherent "a", dropped at the end of a word (Hindi schwa deletion).
        const wordEnds = !(after in CONSONANTS || after in VOWELS || after in NASAL);
        out += wordEnds ? latin : `${latin}a`;
      }
    } else if (ch in VOWELS) {
      out += VOWELS[ch];
    } else if (ch in MATRAS) {
      out += MATRAS[ch];
    } else if (ch in NASAL) {
      out += NASAL[ch];
    } else if (ch === VIRAMA || ch === NUKTA) {
      // already handled with the consonant before it
    } else if (ch === "।" || ch === "॥") {
      out += ".";
    } else {
      out += ch;
    }
  }
  return out;
}
