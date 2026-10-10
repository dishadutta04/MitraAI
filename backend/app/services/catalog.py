"""Demo grocery catalogue (simulated Zepto / Amazon listings).

For each everyday item:
  - base:    the smallest standard pack, used when the user names the item
             without a number ("doodh aur bread" -> 1 base pack of each)
  - per_person: roughly how much one person needs for a meal, in the base
             pack's unit, used for "dal chawal for 4"
  - options: the listings the buyer chooses from (brand, size, price, ETA)

Items not listed here still work: they get generic options built from the
spoken name, like the old simulated search.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class Listing:
    vendor: str  # "zepto" | "amazon"
    name: str
    pack: str
    price: int  # rupees
    eta: int  # minutes


@dataclass(frozen=True)
class CatalogItem:
    label: str
    base: str
    base_amount: float  # base pack size, in the unit per_person uses
    per_person: float
    options: tuple[Listing, ...]
    countable: bool = False  # sold by the piece (eggs, bananas): "6 ande" means 6 eggs, not 6 packs


def _item(label, base, base_amount, per_person, *options, countable=False) -> CatalogItem:
    return CatalogItem(label, base, base_amount, per_person, tuple(Listing(*o) for o in options), countable)


CATALOG: dict[str, CatalogItem] = {
    "milk": _item(
        "Milk", "500 ml", 500, 200,
        ("zepto", "Amul Taaza Toned Milk", "500 ml", 28, 10),
        ("zepto", "Mother Dairy Full Cream Milk", "500 ml", 34, 12),
        ("amazon", "Amul Gold Full Cream Milk", "1 L", 68, 35),
        ("amazon", "Nandini Toned Milk", "500 ml", 26, 90),
    ),
    "bread": _item(
        "Bread", "1 loaf (400 g)", 400, 100,
        ("zepto", "Harvest Gold White Bread", "400 g", 40, 10),
        ("zepto", "Britannia 100% Whole Wheat Bread", "450 g", 55, 12),
        ("amazon", "English Oven Multigrain Bread", "400 g", 60, 40),
    ),
    "eggs": _item(
        "Eggs", "6 eggs", 6, 2,
        ("zepto", "Farm Fresh White Eggs", "6 pcs", 48, 10),
        ("zepto", "Eggoz Brown Eggs", "6 pcs", 75, 14),
        ("amazon", "Licious Classic Eggs", "12 pcs", 99, 45),
        countable=True,
    ),
    "rice": _item(
        "Rice", "1 kg", 1000, 75,
        ("zepto", "India Gate Basmati Rice", "1 kg", 135, 12),
        ("zepto", "Daawat Rozana Basmati", "1 kg", 99, 12),
        ("amazon", "Fortune Sona Masoori Rice", "5 kg", 360, 60),
        ("amazon", "Kohinoor Super Value Basmati", "1 kg", 115, 90),
    ),
    "dal": _item(
        "Dal", "500 g", 500, 50,
        ("zepto", "Tata Sampann Toor Dal", "500 g", 89, 12),
        ("zepto", "Tata Sampann Moong Dal", "500 g", 82, 12),
        ("amazon", "Fortune Masoor Dal", "1 kg", 145, 60),
        ("amazon", "24 Mantra Organic Chana Dal", "500 g", 99, 90),
    ),
    "atta": _item(
        "Atta", "1 kg", 1000, 120,
        ("zepto", "Aashirvaad Whole Wheat Atta", "1 kg", 62, 12),
        ("zepto", "Pillsbury Chakki Fresh Atta", "1 kg", 58, 12),
        ("amazon", "Aashirvaad Atta", "5 kg", 285, 60),
    ),
    "sugar": _item(
        "Sugar", "1 kg", 1000, 20,
        ("zepto", "Madhur Pure Sugar", "1 kg", 52, 10),
        ("zepto", "Uttam Sugar", "1 kg", 48, 12),
        ("amazon", "Dhampure Sulphurless Sugar", "1 kg", 65, 60),
    ),
    "salt": _item(
        "Salt", "1 kg", 1000, 5,
        ("zepto", "Tata Salt", "1 kg", 28, 10),
        ("zepto", "Tata Salt Lite (low sodium)", "1 kg", 45, 12),
        ("amazon", "Aashirvaad Iodised Salt", "1 kg", 25, 60),
    ),
    "oats": _item(
        "Oats", "500 g", 500, 40,
        ("zepto", "Quaker Oats", "500 g", 99, 10),
        ("zepto", "Saffola Masala Oats", "500 g", 145, 12),
        ("amazon", "True Elements Rolled Oats", "1 kg", 199, 60),
    ),
    "oil": _item(
        "Oil", "1 L", 1000, 15,
        ("zepto", "Fortune Sunflower Oil", "1 L", 155, 12),
        ("zepto", "Saffola Gold Oil", "1 L", 199, 12),
        ("amazon", "Fortune Kachi Ghani Mustard Oil", "1 L", 175, 60),
    ),
    "tea": _item(
        "Tea", "250 g", 250, 5,
        ("zepto", "Tata Tea Premium", "250 g", 140, 10),
        ("zepto", "Red Label Tea", "250 g", 135, 12),
        ("amazon", "Wagh Bakri Tea", "500 g", 255, 60),
    ),
    "curd": _item(
        "Curd", "400 g", 400, 100,
        ("zepto", "Amul Masti Dahi", "400 g", 35, 10),
        ("zepto", "Mother Dairy Classic Curd", "400 g", 40, 12),
        ("amazon", "Milky Mist Set Curd", "500 g", 55, 60),
    ),
    "paneer": _item(
        "Paneer", "200 g", 200, 75,
        ("zepto", "Amul Fresh Paneer", "200 g", 90, 10),
        ("zepto", "Milky Mist Paneer", "200 g", 95, 12),
        ("amazon", "Gowardhan Paneer", "500 g", 210, 60),
    ),
    "butter": _item(
        "Butter", "100 g", 100, 10,
        ("zepto", "Amul Butter", "100 g", 58, 10),
        ("zepto", "Mother Dairy Butter", "100 g", 55, 12),
        ("amazon", "Amul Butter", "500 g", 275, 60),
    ),
    "biscuits": _item(
        "Biscuits", "1 pack", 1, 1,
        ("zepto", "Parle-G Gold", "1 pack", 20, 10),
        ("zepto", "Britannia Marie Gold", "1 pack", 30, 10),
        ("amazon", "Britannia NutriChoice Sugar Free", "1 pack", 45, 60),
    ),
    "banana": _item(
        "Banana", "6 pcs", 6, 1,
        ("zepto", "Robusta Banana", "6 pcs", 45, 10),
        ("zepto", "Yelakki Banana", "6 pcs", 60, 12),
        ("amazon", "Fresh Banana (Robusta)", "1 dozen", 85, 90),
        countable=True,
    ),
    "apple": _item(
        "Apple", "4 pcs", 4, 1,
        ("zepto", "Shimla Apple", "4 pcs", 120, 10),
        ("zepto", "Royal Gala Apple", "4 pcs", 160, 12),
        ("amazon", "Kinnaur Apple", "1 kg", 220, 90),
        countable=True,
    ),
    "potato": _item(
        "Potato", "1 kg", 1000, 150,
        ("zepto", "Fresh Potato", "1 kg", 35, 10),
        ("amazon", "Potato (Aloo)", "2 kg", 65, 90),
    ),
    "onion": _item(
        "Onion", "1 kg", 1000, 75,
        ("zepto", "Fresh Onion", "1 kg", 40, 10),
        ("amazon", "Onion (Pyaz)", "2 kg", 75, 90),
    ),
    "tomato": _item(
        "Tomato", "500 g", 500, 75,
        ("zepto", "Hybrid Tomato", "500 g", 25, 10),
        ("amazon", "Tomato (Tamatar)", "1 kg", 45, 90),
    ),
    "namkeen": _item(
        "Namkeen", "1 pack", 1, 1,
        ("zepto", "Haldiram's Aloo Bhujia", "200 g", 55, 10),
        ("zepto", "Bikaji Moong Dal", "200 g", 50, 12),
        ("amazon", "Haldiram's Roasted Makhana (low salt)", "100 g", 99, 60),
    ),
    "sabzi": _item(
        "Vegetables", "1 kg mixed", 1000, 150,
        ("zepto", "Daily Mixed Vegetables", "1 kg", 70, 10),
        ("amazon", "Fresh Seasonal Veg Basket", "2 kg", 140, 90),
    ),
    "roti": _item(
        "Roti", "1 pack (10 pcs)", 10, 3,
        ("zepto", "iD Fresh Malabar Parotta", "5 pcs", 60, 12),
        ("zepto", "Fresh Chapati", "10 pcs", 50, 12),
        ("amazon", "Aashirvaad Atta (for roti)", "1 kg", 62, 60),
        countable=True,
    ),
    "jam": _item(
        "Jam", "200 g", 200, 20,
        ("zepto", "Kissan Mixed Fruit Jam", "200 g", 75, 10),
        ("amazon", "Mapro Strawberry Jam", "450 g", 140, 60),
    ),
}

# Spoken / Hindi names -> catalogue key.
ALIASES = {
    "doodh": "milk", "dudh": "milk", "chawal": "rice", "chaval": "rice", "dahi": "curd", "makhan": "butter",
    "anda": "eggs", "ande": "eggs", "egg": "eggs", "kela": "banana", "kele": "banana", "bananas": "banana",
    "seb": "apple", "apples": "apple", "aloo": "potato", "alu": "potato", "pyaz": "onion", "pyaaz": "onion",
    "tamatar": "tomato", "cheeni": "sugar", "chini": "sugar", "namak": "salt", "tel": "oil", "chai": "tea",
    "biscuit": "biscuits", "biskut": "biscuits", "aata": "atta", "flour": "atta", "dahl": "dal", "daal": "dal",
    "vegetables": "sabzi", "vegetable": "sabzi", "chapati": "roti", "rotis": "roti", "ots": "oats",
}


def lookup(item: str) -> tuple[str, CatalogItem] | None:
    """Catalogue entry for a spoken item name ("doodh", "Milk", "bananas")."""
    key = item.lower().strip()
    key = ALIASES.get(key, key)
    if key in CATALOG:
        return key, CATALOG[key]
    return None


def packs_for_pieces(entry: CatalogItem, pieces: float) -> int:
    """Base packs needed for a piece count ("12 kele" with 6-piece packs -> 2)."""
    return max(1, math.ceil(pieces / entry.base_amount))


def packs_for_people(entry: CatalogItem, people: int) -> int:
    """How many base packs cover one meal for `people` ("dal chawal for 4")."""
    return max(1, math.ceil(entry.per_person * people / entry.base_amount))


def listings(item: str) -> list[Listing]:
    """The options to show the buyer for one item; generic ones for items not in the catalogue."""
    found = lookup(item)
    if found:
        return list(found[1].options)
    title = item.title()
    return [
        Listing("zepto", f"{title} - Fresh Pack", "1 pack", 75, 12),
        Listing("zepto", f"{title} - Value Pack", "1 pack", 68, 18),
        Listing("amazon", f"{title} - Amazon Pantry", "1 pack", 65, 90),
    ]
