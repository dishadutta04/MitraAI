"""Turns a spoken (or typed) grocery request into item / quantity / urgency.

Voice input arrives as whatever the browser's speech recogniser produced:
Hinglish in Latin script ("jaldi 2 packet oats mangao"), Hindi in Devanagari
("जल्दी दो पैकेट चीनी मंगाओ"), or English. Everything is first brought to one
lowercase Latin form, then filler words are dropped as whole words and Hindi
grocery names are mapped to the English names the health rules know.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.services import catalog

# --- Devanagari -> Latin -------------------------------------------------

_CONSONANTS = {
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n",
    "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
    "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
    "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
    "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
    "य": "y", "र": "r", "ल": "l", "व": "v",
    "श": "sh", "ष": "sh", "स": "s", "ह": "h",
}
# Consonant + nukta (U+093C), and the precomposed forms of the same letters.
_NUKTA_CONSONANTS = {"क": "q", "ख": "kh", "ग": "g", "ज": "z", "ड": "r", "ढ": "rh", "फ": "f"}
_PRECOMPOSED = {"क़": "क़", "ख़": "ख़", "ग़": "ग़", "ज़": "ज़", "ड़": "ड़", "ढ़": "ढ़", "फ़": "फ़"}
_VOWELS = {
    "अ": "a", "आ": "a", "इ": "i", "ई": "i", "उ": "u", "ऊ": "u",
    "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऋ": "ri",
}
_MATRAS = {
    "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u",
    "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ृ": "ri",
}
_VIRAMA = "्"
_NUKTA = "़"
_NASAL = {"ं": "n", "ँ": "n", "ः": "h"}
_DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")


def transliterate(text: str) -> str:
    """Rough Devanagari -> Hinglish, e.g. "चीनी" -> "chini", "मंगाओ" -> "mangao".

    Good enough to match the word lists below; not a linguistic transliterator.
    """
    for composed, decomposed in _PRECOMPOSED.items():
        text = text.replace(composed, decomposed)
    text = text.translate(_DIGITS)

    out: list[str] = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch in _CONSONANTS:
            latin = _CONSONANTS[ch]
            if i + 1 < len(text) and text[i + 1] == _NUKTA:
                latin = _NUKTA_CONSONANTS.get(ch, latin)
                i += 1
            nxt = text[i + 1] if i + 1 < len(text) else ""
            if nxt in _MATRAS:
                out.append(latin + _MATRAS[nxt])
                i += 2
                continue
            if nxt == _VIRAMA:
                out.append(latin)
                i += 2
                continue
            # Inherent "a", dropped at the end of a word (Hindi schwa deletion).
            word_ends = not (nxt in _CONSONANTS or nxt in _VOWELS or nxt in _NASAL)
            out.append(latin if word_ends else latin + "a")
        elif ch in _VOWELS:
            out.append(_VOWELS[ch])
        elif ch in _MATRAS:
            out.append(_MATRAS[ch])
        elif ch in _NASAL:
            out.append(_NASAL[ch])
        elif ch in (_VIRAMA, _NUKTA):
            pass
        elif ch in "।॥":
            out.append(" ")
        else:
            out.append(ch)
        i += 1
    return "".join(out)


def _key(word: str) -> str:
    """Spelling-insensitive form for lookups: cheeni/chini, chawal/chaval, aadha/adha."""
    word = word.lower().replace("w", "v")
    for long, short in (("aa", "a"), ("ee", "i"), ("oo", "u")):
        word = word.replace(long, short)
    return word


# --- Word lists (keys go through _key, so one spelling per word is enough) ---

_NUMBER_WORDS = {
    "ek": 1, "do": 2, "teen": 3, "char": 4, "chaar": 4, "panch": 5, "paanch": 5,
    "chhe": 6, "chhah": 6, "che": 6, "saat": 7, "aath": 8, "nau": 9, "das": 10,
    "barah": 12, "baarah": 12, "aadha": 0.5, "adhi": 0.5, "aadhi": 0.5,
    "dedh": 1.5, "derh": 1.5, "dhai": 2.5, "dhaai": 2.5,
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "twelve": 12, "half": 0.5,
}
_NUMBER_KEYS = {_key(w): v for w, v in _NUMBER_WORDS.items()}

# Canonical unit for each spoken form.
_UNITS = {
    "kg": "kg", "kgs": "kg", "kilo": "kg", "kilogram": "kg", "kilograms": "kg",
    "g": "g", "gm": "g", "gms": "g", "gram": "g", "grams": "g",
    "l": "litre", "ltr": "litre", "litre": "litre", "liter": "litre", "litres": "litre", "liters": "litre",
    "ml": "ml",
    "packet": "packet", "packets": "packet", "pack": "packet", "packs": "packet", "pkt": "packet",
    "package": "packet", "packages": "packet",
    "paiket": "packet", "paket": "packet",
    "dozen": "dozen", "darjan": "dozen", "bottle": "bottle", "bottles": "bottle", "botal": "bottle",
    "piece": "piece", "pieces": "piece", "pcs": "piece", "box": "box", "dabba": "box", "dibba": "box",
}
_UNIT_KEYS = {_key(w): u for w, u in _UNITS.items()}
_SIZE_UNITS = {"kg", "g", "litre", "ml"}  # these describe pack size, not how many packs

# Hindi / Hinglish grocery names -> the English names the health rules use.
_ITEM_SYNONYMS = {
    "cheeni": "sugar", "chini": "sugar", "shakkar": "sugar", "namak": "salt",
    "doodh": "milk", "dudh": "milk", "chawal": "rice", "dahi": "curd", "makhan": "butter",
    "anda": "eggs", "ande": "eggs", "tel": "oil", "chai": "tea", "chai patti": "tea", "patti": "tea",
    "kela": "banana", "kele": "banana", "seb": "apple", "aloo": "potato", "alu": "potato",
    "pyaz": "onion", "pyaaz": "onion", "tamatar": "tomato", "adrak": "ginger", "lehsun": "garlic",
    "ots": "oats", "biskut": "biscuits", "biskit": "biscuits", "bred": "bread", "sabun": "soap",
    "mithai": "sweets", "achar": "pickle", "achaar": "pickle", "namkin": "namkeen",
    "saunf": "fennel", "haldi": "turmeric", "mirch": "chilli", "gud": "jaggery",
    "chawal": "rice", "sabji": "sabzi",
}
_ITEM_KEYS = {_key(w): eng for w, eng in _ITEM_SYNONYMS.items()}

# Everyday grocery words in English, used to judge which speech transcript makes sense.
_GROCERY_WORDS = {
    "milk", "oats", "bread", "egg", "butter", "sugar", "salt", "rice", "dal", "atta", "flour", "maida", "suji",
    "oil", "ghee", "tea", "coffee", "apple", "banana", "orange", "mango", "grape", "papaya", "onion", "potato",
    "tomato", "ginger", "garlic", "chilli", "lemon", "spinach", "carrot", "cabbage", "vegetable", "fruit",
    "biscuit", "cookie", "paneer", "curd", "cheese", "yogurt", "honey", "jam", "juice", "water", "soap",
    "shampoo", "toothpaste", "detergent", "chips", "namkeen", "noodle", "maggi", "pasta", "soup", "cornflakes",
    "poha", "besan", "jaggery", "turmeric", "masala", "chicken", "fish", "mutton", "medicine", "diaper",
    "sweet", "chocolate", "cake", "pickle", "papad", "makhana", "chana", "rajma", "moong", "almond", "cashew",
}
_GROCERY_KEYS = {_key(w) for w in _GROCERY_WORDS} | set(_ITEM_KEYS) | {_key(v) for v in _ITEM_SYNONYMS.values()}


def _singular(key: str) -> str:
    for suffix in ("ies", "es", "s"):
        if key.endswith(suffix) and len(key) > len(suffix) + 2:
            return key[: -len(suffix)] + ("y" if suffix == "ies" else "")
    return key


def understood_ratio(text: str) -> float:
    """Share of words (0..1) Mitra recognises: numbers, units, groceries, joiners and filler.

    Used to choose between speech transcripts: a misheard one is mostly
    unknown words ("jody do packet dude"), a good one is mostly known
    ("jaldi do paiket dudh aur ek kilo chini").
    """
    norm = _MISHEARD_ORDER.sub(" mangao ", normalize(text))
    words = norm.split()
    if not words:
        return 0.0
    known = 0
    for word in words:
        key = _key(word)
        if (
            re.fullmatch(r"\d+(?:[.,]\d+)?", word)
            or key in _NUMBER_KEYS
            or key in _UNIT_KEYS
            or key in _SEPARATOR_KEYS
            or key in _FILLER_KEYS
            or key in _GROCERY_KEYS
            or _singular(key) in _GROCERY_KEYS
        ):
            known += 1
    return known / len(words)

# Request verbs said around the item: "kar do", "mangwa do", "bhej dena" ...
# Removed before numbers are read, so the "do" in "kar do" is not taken as 2.
_VERB_PHRASE = re.compile(
    r"\b(?:kar|kara|karva|karwa|mangva|mangwa|manga|bhej|la|dila|de|dilva|dilwa)\s+(?:do|dijiye|dena|de|dein|den)\b"
)

# Common speech-recogniser mishearings of "mangao" ("order it"), e.g. "मन गांव".
_MISHEARD_ORDER = re.compile(r"\bman\s*ga(?:o|on|nv|av|ao)\b")

_URGENT = {"jaldi", "jldi", "urgent", "abhi", "turant", "asap", "fatafat", "immediately", "quickly"}
_RELAXED = {"later", "baad", "aaram"}

_FILLER = {
    # urgency words (detected separately, never part of the item)
    *_URGENT, *_RELAXED, "se", "mein", "me", "main", "koi", "kuch", "nahi", "nahin", "normal",
    # asking / ordering
    "please", "plz", "pls", "kripya", "mujhe", "muje", "humein", "hume", "hamein", "mere", "mera", "meri",
    "liye", "chahiye", "chaiye", "chahie", "mangao", "mangwao", "mangvao", "mangana", "mangvana",
    "order", "karo", "kar", "karna", "karde", "kardo", "kariye", "kijiye", "dena", "dijiye",
    "bhejo", "bhejna", "bhej", "bhejdo", "lao", "lana", "laao", "dilao", "do", "de", "hai", "hain", "ho", "bhi", "zara",
    "thoda", "thodi", "wala", "wali", "vale", "ka", "ki", "ke", "ko", "aaj", "kal", "raat", "subah", "shaam",
    # English
    "i", "want", "need", "get", "buy", "bring", "send", "me", "some", "the", "a", "an", "of", "for", "to", "now",
}
_FILLER_KEYS = {_key(w) for w in _FILLER}
_URGENT_KEYS = {_key(w) for w in _URGENT}


# Words that end one item and start the next: "milk and oats", "doodh aur ande", "rice, dal".
_SEPARATORS = {"and", "aur", "or", "tatha", "evam", "plus", "also", ",", "&", "+"}
_SEPARATOR_KEYS = {_key(w) for w in _SEPARATORS}


@dataclass
class ParsedItem:
    item: str
    quantity: int
    preferences: list[str] = field(default_factory=list)
    # "said": the user gave a number; "base": no number, so 1 base pack;
    # "people": sized for "for 4 people".
    basis: str = "said"
    note: str | None = None


@dataclass
class ParsedRequest:
    items: list[ParsedItem]
    urgency: str
    normalized_text: str = ""

    # First item, for callers that handle one item at a time.
    @property
    def item(self) -> str | None:
        return self.items[0].item if self.items else None

    @property
    def quantity(self) -> int:
        return self.items[0].quantity if self.items else 1

    @property
    def preferences(self) -> list[str]:
        return self.items[0].preferences if self.items else []


def normalize(text: str) -> str:
    """Lowercase Latin text; commas become their own word, other punctuation is dropped (decimals kept)."""
    text = transliterate(text).lower()
    text = re.sub(r"(?<!\d),|,(?!\d)", " , ", text)
    text = re.sub(r"[&+]", lambda m: f" {m.group(0)} ", text)
    text = re.sub(r"(?<!\d)\.(?!\d)|[^\w\s.,&+-]", " ", text)
    text = re.sub(r"(\d)\s*(kg|g|gm|ml|l|ltr)\b", r"\1 \2", text)  # "2kg" -> "2 kg"
    return " ".join(text.split())


def _token_kind(word: str, key: str, is_last: bool) -> tuple[str, float | str | None]:
    """Classify one word: ("number", n) / ("unit", u) / ("separator", None) / ("filler", None) / ("word", None)."""
    if re.fullmatch(r"\d+(?:[.,]\d+)?", word):
        return "number", float(word.replace(",", "."))
    if key in _NUMBER_KEYS and not (key == "do" and is_last):
        # A sentence-final "do" means "give", not "two" ("oats do").
        return "number", float(_NUMBER_KEYS[key])
    if key in _UNIT_KEYS:
        return "unit", _UNIT_KEYS[key]
    if key in _SEPARATOR_KEYS:
        return "separator", None
    if key in _FILLER_KEYS:
        return "filler", None
    return "word", None


def _amount_to_line(amount: float | None, unit: str | None) -> tuple[int, list[str]]:
    """(quantity, preferences) for one item's spoken amount and unit."""
    if amount is None:
        return 1, []
    if unit == "dozen":
        return max(1, round(amount * 12)), []
    if unit in _SIZE_UNITS:
        # "2 kg rice" -> 2 packs of 1 kg; "1.5 kg sugar" / "500 g" -> 1 pack of that size.
        if amount.is_integer() and unit in {"kg", "litre"}:
            return int(amount), [f"1 {unit} pack"]
        return 1, [f"{amount:g} {unit}"]
    return max(1, round(amount)), []


def parse_request(text: str) -> ParsedRequest:
    """Reads the request word by word and groups it into items.

    "two packet of milk and oats" -> two(number) packet(unit) of(filler)
    milk(word) and(separator) oats(word) -> [milk x2 packet, oats x1].
    A number before an item belongs to it ("2 packet milk"); a number right
    after an item belongs to it when a unit, separator or the end follows
    ("milk 2 packet, oats"); otherwise it starts the next item.
    """
    norm = normalize(text)
    words = _MISHEARD_ORDER.sub(" ", _VERB_PHRASE.sub(" ", norm)).split()
    keys = [_key(w) for w in words]

    if re.search(r"\b(?:koi jaldi nahi|jaldi nahi|no hurry)\b", norm) or any(k in {"later", "baad", "aram"} for k in keys):
        urgency = "low"
    elif any(k in _URGENT_KEYS for k in keys):
        urgency = "high"
    else:
        urgency = "medium"

    tokens = [_token_kind(w, k, i == len(words) - 1) for i, (w, k) in enumerate(zip(words, keys))]

    # "dal chawal for 4", "4 logon ke liye", "for 4 people": a head count, not a quantity.
    people: int | None = None
    people_at = -1
    for i, (kind, value) in enumerate(tokens):
        if kind != "number" or people is not None:
            continue
        before = keys[i - 1] if i > 0 else ""
        after = keys[i + 1] if i + 1 < len(keys) else ""
        next_kind = tokens[i + 1][0] if i + 1 < len(tokens) else None
        if after in _PEOPLE_KEYS or (before == "for" and next_kind not in ("unit", "word")):
            people = max(1, round(float(value)))
            people_at = i
            tokens[i] = ("filler", None)
            if after in _PEOPLE_KEYS:
                tokens[i + 1] = ("filler", None)

    def next_meaningful(i: int) -> str | None:
        for kind, _ in tokens[i + 1 :]:
            if kind != "filler":
                return kind
        return None

    items: list[ParsedItem] = []
    amount: float | None = None
    unit: str | None = None
    item_words: list[str] = []
    # "dal chawal for 4 aur doodh": "for 4" sizes only the group it follows (dal, chawal);
    # "4 logon ke liye dal chawal aur doodh" said first sizes everything after it.
    group_people: int | None = None
    all_people: int | None = None

    def flush() -> None:
        nonlocal amount, unit, item_words, group_people
        names = _map_item_list(item_words)
        if not names:
            return
        # "dal chawal", "bread butter": two catalogue items said together are two items.
        if len(names) > 1 and all(catalog.lookup(n) for n in names):
            groups = names
        else:
            groups = [" ".join(names)]
        for n, name in enumerate(groups):
            said = amount if n == 0 else None  # a spoken number belongs to the first of the pair
            items.append(_line(name, said, unit if n == 0 else None, group_people or all_people))
        amount, unit, item_words, group_people = None, None, [], None

    for i, (word, (kind, value)) in enumerate(zip(words, tokens)):
        if i == people_at:
            if item_words:
                group_people = people
            else:
                all_people = people
            continue
        if kind == "number":
            if item_words:
                if amount is None and next_meaningful(i) in (None, "unit", "separator"):
                    amount = float(value)  # "milk 2 packet": belongs to the item before it
                    continue
                flush()  # "milk 2 oats": starts the next item
            if amount is None:
                amount = float(value)
        elif kind == "unit":
            if unit is None:
                unit = str(value)
        elif kind == "separator":
            flush()
        elif kind == "word":
            item_words.append(word)
    flush()

    return ParsedRequest(items=_merge_repeats(items), urgency=urgency, normalized_text=norm)


_PEOPLE_KEYS = {_key(w) for w in ("people", "persons", "person", "log", "logon", "logo", "logo", "members", "jan", "admi", "aadmi")}


def _line(name: str, amount: float | None, unit: str | None, people: int | None) -> ParsedItem:
    """One order line, following the voice-input rules:
    a number said for the item wins; else "for N people" sizes it; else 1 base pack."""
    found = catalog.lookup(name)
    # Eggs, bananas, apples: "6 ande" / "ek dozen kele" count pieces, which round up to packs.
    if amount is not None and found and found[1].countable and unit in (None, "dozen", "piece"):
        pieces = amount * (12 if unit == "dozen" else 1)
        return ParsedItem(
            item=name,
            quantity=catalog.packs_for_pieces(found[1], pieces),
            preferences=[f"{pieces:g} pcs"],
            basis="said",
            note=f"{found[1].base} per pack",
        )
    if amount is not None:
        quantity, preferences = _amount_to_line(amount, unit)
        return ParsedItem(item=name, quantity=quantity, preferences=preferences, basis="said")
    if found and people:
        _, entry = found
        return ParsedItem(
            item=name,
            quantity=catalog.packs_for_people(entry, people),
            preferences=[entry.base],
            basis="people",
            note=f"for {people} people",
        )
    preferences = [found[1].base] if found else []
    return ParsedItem(item=name, quantity=1, preferences=preferences, basis="base", note="no number said · base pack")


def _merge_repeats(items: list[ParsedItem]) -> list[ParsedItem]:
    """"2 doodh aur ek doodh" -> milk 3: the same item said twice adds up."""
    merged: dict[str, ParsedItem] = {}
    for line in items:
        key = (catalog.lookup(line.item) or (line.item.lower(), None))[0]
        if key not in merged:
            merged[key] = line
            continue
        first = merged[key]
        first.quantity += line.quantity
        first.preferences = list(dict.fromkeys([*first.preferences, *line.preferences]))
        first.basis, first.note = "said", None
    return list(merged.values())


def _map_item(words: list[str]) -> str | None:
    """Join the leftover words into an item name, translating Hindi grocery names."""
    return " ".join(_map_item_list(words)) or None


def _map_item_list(words: list[str]) -> list[str]:
    """The item words with Hindi grocery names translated ("chai patti" -> "tea")."""
    out: list[str] = []
    i = 0
    while i < len(words):
        pair = _key(f"{words[i]} {words[i + 1]}") if i + 1 < len(words) else None
        if pair and pair in _ITEM_KEYS:
            out.append(_ITEM_KEYS[pair])
            i += 2
            continue
        key = _key(words[i])
        out.append(_ITEM_KEYS.get(key, words[i]))
        i += 1
    return out


# --- Hinglish / English -> Devanagari, for showing each spoken word in both scripts ---

# Common order words, spelled the way Hindi readers expect (rules alone would get these slightly wrong).
_DEVANAGARI_WORDS = {
    # numbers
    "ek": "एक", "do": "दो", "teen": "तीन", "char": "चार", "chaar": "चार", "panch": "पांच", "paanch": "पांच",
    "chhe": "छह", "saat": "सात", "aath": "आठ", "nau": "नौ", "das": "दस", "barah": "बारह",
    "aadha": "आधा", "adha": "आधा", "aadhi": "आधी", "dedh": "डेढ़", "derh": "डेढ़", "dhai": "ढाई",
    "one": "वन", "two": "टू", "three": "थ्री", "four": "फ़ोर", "five": "फ़ाइव", "ten": "टेन", "half": "हाफ़",
    # units
    "kilo": "किलो", "kg": "किलो", "gram": "ग्राम", "g": "ग्राम", "litre": "लीटर", "liter": "लीटर", "ml": "एमएल",
    "packet": "पैकेट", "packets": "पैकेट", "paiket": "पैकेट", "pack": "पैक", "dozen": "दर्जन", "darjan": "दर्जन",
    "bottle": "बोतल", "botal": "बोतल", "piece": "पीस", "box": "डिब्बा", "dabba": "डिब्बा",
    # Hindi grocery names
    "doodh": "दूध", "dudh": "दूध", "cheeni": "चीनी", "chini": "चीनी", "shakkar": "शक्कर", "namak": "नमक",
    "chawal": "चावल", "chaval": "चावल", "dal": "दाल", "atta": "आटा", "aata": "आटा", "dahi": "दही",
    "makhan": "मक्खन", "ghee": "घी", "paneer": "पनीर", "anda": "अंडा", "ande": "अंडे", "tel": "तेल",
    "chai": "चाय", "patti": "पत्ती", "kela": "केला", "kele": "केले", "seb": "सेब", "aloo": "आलू", "alu": "आलू",
    "pyaz": "प्याज़", "pyaaz": "प्याज़", "tamatar": "टमाटर", "adrak": "अदरक", "lehsun": "लहसुन",
    "sabzi": "सब्ज़ी", "achar": "अचार", "namkeen": "नमकीन", "mithai": "मिठाई", "haldi": "हल्दी", "mirch": "मिर्च",
    "gud": "गुड़", "sabun": "साबुन", "biskut": "बिस्कुट", "makhana": "मखाना", "ladoo": "लड्डू",
    # English grocery names said in Hinglish
    "milk": "मिल्क", "oats": "ओट्स", "ots": "ओट्स", "bread": "ब्रेड", "egg": "एग", "eggs": "एग्स",
    "sugar": "शुगर", "salt": "सॉल्ट", "rice": "राइस", "banana": "बनाना", "bananas": "बनाना", "apple": "एप्पल",
    "apples": "एप्पल", "biscuit": "बिस्कुट", "biscuits": "बिस्कुट", "butter": "बटर", "tea": "टी", "coffee": "कॉफ़ी",
    "oil": "ऑयल", "soap": "सोप", "juice": "जूस", "water": "वॉटर", "soup": "सूप", "chips": "चिप्स",
    "onion": "अनियन", "potato": "पोटैटो", "tomato": "टोमैटो", "cheese": "चीज़", "honey": "हनी", "jam": "जैम",
    # joining / request words
    "aur": "और", "and": "एंड", "ya": "या", "or": "ऑर", "jaldi": "जल्दी", "abhi": "अभी", "turant": "तुरंत",
    "mangao": "मंगाओ", "mangwao": "मंगवाओ", "mangwa": "मंगवा", "chahiye": "चाहिए", "chahie": "चाहिए",
    "mujhe": "मुझे", "humein": "हमें", "please": "प्लीज़", "kripya": "कृपया", "order": "ऑर्डर",
    "kar": "कर", "karo": "करो", "kardo": "कर दो", "de": "दे", "dena": "देना", "dijiye": "दीजिए",
    "bhej": "भेज", "bhejo": "भेजो", "lao": "लाओ", "se": "से", "ke": "के", "ki": "की", "ka": "का",
    "ko": "को", "liye": "लिए", "hai": "है", "hain": "हैं", "nahi": "नहीं", "koi": "कोई", "kuch": "कुछ",
    "aaj": "आज", "kal": "कल", "raat": "रात", "subah": "सुबह", "shaam": "शाम", "bhi": "भी", "zara": "ज़रा",
    "send": "सेंड", "me": "मी", "get": "गेट", "want": "वॉन्ट", "need": "नीड", "of": "ऑफ़", "the": "द",
    "i": "आई", "some": "सम", "for": "फ़ॉर", "low": "लो", "free": "फ़्री",
}

# Longest spellings first so "chh" wins over "ch", "aa" over "a".
_ROMAN_CONSONANTS = [
    ("chh", "छ"), ("ch", "च"), ("kh", "ख"), ("gh", "घ"), ("jh", "झ"), ("th", "थ"), ("dh", "ध"),
    ("ph", "फ"), ("bh", "भ"), ("sh", "श"), ("k", "क"), ("g", "ग"), ("j", "ज"), ("t", "ट"), ("d", "ड"),
    ("n", "न"), ("p", "प"), ("f", "फ़"), ("b", "ब"), ("m", "म"), ("y", "य"), ("r", "र"), ("l", "ल"),
    ("v", "व"), ("w", "व"), ("s", "स"), ("h", "ह"), ("z", "ज़"), ("q", "क़"), ("x", "क्स"), ("c", "क"),
]
_ROMAN_VOWELS = [  # (spelling, independent letter, vowel sign after a consonant)
    ("aa", "आ", "ा"), ("ai", "ऐ", "ै"), ("au", "औ", "ौ"), ("ee", "ई", "ी"), ("ii", "ई", "ी"),
    ("oo", "ऊ", "ू"), ("a", "अ", ""), ("i", "इ", "ि"), ("u", "उ", "ु"), ("e", "ए", "े"), ("o", "ओ", "ो"),
]


def _match(word: str, i: int, table: list) -> tuple | None:
    for entry in table:
        if word.startswith(entry[0], i):
            return entry
    return None


def roman_to_devanagari(word: str) -> str:
    """Rough Hinglish -> Devanagari for one word ("jaldi" -> "जल्दी"); digits stay as they are."""
    w = word.lower()
    if w in _DEVANAGARI_WORDS:
        return _DEVANAGARI_WORDS[w]
    if "-" in w:
        return "-".join(roman_to_devanagari(part) for part in w.split("-"))
    if not re.fullmatch(r"[a-z]+", w):
        return word
    out = ""
    i = 0
    after_consonant = False
    while i < len(w):
        vowel = _match(w, i, _ROMAN_VOWELS)
        if vowel:
            spelling, letter, sign = vowel
            at_end = i + len(spelling) == len(w)
            if after_consonant:
                # Word-final "i" and "a" are usually long in Hindi (jaldi -> जल्दी, kela -> केला).
                if at_end and spelling == "i":
                    out += "ी"
                elif at_end and spelling == "a":
                    out += "ा"
                else:
                    out += sign
            else:
                out += letter
            after_consonant = False
            i += len(spelling)
            continue
        consonant = _match(w, i, _ROMAN_CONSONANTS)
        if consonant is None:
            i += 1
            continue
        spelling, letter = consonant
        nxt = i + len(spelling)
        if after_consonant:
            out += "्"  # two consonants in a row join
        # "n" right before another consonant is said as a nasal: mangao -> मंगाओ
        if spelling == "n" and nxt < len(w) and _match(w, nxt, _ROMAN_VOWELS) is None and not after_consonant:
            if out:
                out += "ं"
                after_consonant = False
                i = nxt
                continue
        out += letter
        after_consonant = True
        i = nxt
    return out


_REQUEST_VERB_KEYS = {_key(w) for w in ("kar", "kara", "karva", "karwa", "mangva", "mangwa", "manga", "bhej", "la", "dila", "de")}


def explain_words(text: str) -> list[dict]:
    """Every word of the request in Hindi and Hinglish, with what Mitra understood it as.

    kind: number / unit / item / separator / urgency / filler / unknown.
    meaning: the value Mitra will use ("2", "kg", "sugar"), when there is one.
    index: which whitespace-separated word of `text` it came from.
    """
    out: list[dict] = []
    words = text.split()
    prev_key = ""
    for position, original in enumerate(words):
        hindi_original = bool(re.search(r"[ऀ-ॿ]", original))
        romans = normalize(original).split()
        for roman in romans:
            if roman in {",", "&", "+"}:
                continue
            key = _key(roman)
            is_last = position == len(words) - 1 and roman == romans[-1]
            kind, value = _token_kind(roman, key, is_last)
            # The "do" in "kar do" / "bhej do" means "give", not "two".
            if kind == "number" and key == "do" and prev_key in _REQUEST_VERB_KEYS:
                kind, value = "filler", None
            prev_key = key
            meaning: str | None = None
            if kind == "number":
                meaning = f"{float(value):g}"
            elif kind == "unit":
                meaning = str(value)
            elif kind == "filler" and key in _URGENT_KEYS:
                kind, meaning = "urgency", "jaldi"
            elif kind == "word":
                if key in _ITEM_KEYS:
                    kind, meaning = "item", _ITEM_KEYS[key]
                elif any(k in _GROCERY_KEYS or _singular(k) in _GROCERY_KEYS for k in [key, *key.split("-")]):
                    kind, meaning = "item", roman
                else:
                    kind = "unknown"
            out.append(
                {
                    "hindi": original if hindi_original and len(romans) == 1 else roman_to_devanagari(roman),
                    "roman": roman,
                    "kind": kind,
                    "meaning": meaning,
                    "index": position,
                }
            )
    return out
