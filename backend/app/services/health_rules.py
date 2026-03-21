from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable


@dataclass
class RuleMatch:
    severity: str
    warning: str
    why: str
    alternatives: list[str]


CONDITION_RULES = {
    "diabetes": [
        {
            "keywords": ["sugar", "jalebi", "rasgulla", "gulab jamun", "sweet syrup", "cola", "soft drink"],
            "severity": "high",
            "warning": "High sugar item detected for diabetic profile",
            "why": "This can rapidly increase blood glucose and cause unsafe spikes.",
            "alternatives": ["sugar-free sweetener", "roasted chana", "unsweetened biscuits"],
        }
    ],
    "hypertension": [
        {
            "keywords": ["salt", "chips", "pickle", "namkeen", "instant noodles", "papad"],
            "severity": "high",
            "warning": "High sodium item detected for hypertensive profile",
            "why": "High sodium can elevate blood pressure and increase cardiac risk.",
            "alternatives": ["low-sodium salt", "baked snacks", "roasted makhana"],
        }
    ],
    "ckd": [
        {
            "keywords": ["salt substitute", "potassium salt", "processed cheese", "cola"],
            "severity": "high",
            "warning": "Kidney-sensitive item detected for CKD profile",
            "why": "These items may increase potassium/phosphorus load and strain kidney function.",
            "alternatives": ["renal-safe snacks", "fresh fruit portions", "dietitian-approved low-sodium options"],
        }
    ],
}

MEDICATION_RULES = {
    "warfarin": [
        {
            "keywords": ["spinach", "kale", "methi", "broccoli"],
            "severity": "medium",
            "warning": "Potential food interaction with warfarin",
            "why": "Large vitamin-K changes can affect anticoagulant balance.",
            "alternatives": ["keep portion consistent", "consult clinician if diet changes suddenly"],
        }
    ],
    "metformin": [
        {
            "keywords": ["sugar", "sweet syrup", "dessert mix"],
            "severity": "medium",
            "warning": "High sugar order may counter diabetic medication goals",
            "why": "Frequent high-sugar intake may reduce glycemic control.",
            "alternatives": ["whole-grain snacks", "unsweetened options"],
        }
    ],
    "amlodipine": [
        {
            "keywords": ["grapefruit", "grapefruit juice"],
            "severity": "medium",
            "warning": "Potential interaction with BP medication",
            "why": "Grapefruit can alter metabolism of some blood pressure medicines.",
            "alternatives": ["orange", "apple", "mosambi"],
        }
    ],
}


def _match_rules(item_text: str, rules: list[dict]) -> list[RuleMatch]:
    matches: list[RuleMatch] = []
    for rule in rules:
        if any(keyword in item_text for keyword in rule["keywords"]):
            matches.append(
                RuleMatch(
                    severity=rule["severity"],
                    warning=rule["warning"],
                    why=rule["why"],
                    alternatives=list(rule["alternatives"]),
                )
            )
    return matches


def evaluate_health_risks(item_text: str, conditions: Iterable[str], medications: Iterable[str]) -> list[RuleMatch]:
    item = item_text.lower().strip()
    results: list[RuleMatch] = []

    for condition in conditions:
        key = str(condition).lower()
        if key in CONDITION_RULES:
            results.extend(_match_rules(item, CONDITION_RULES[key]))

    for medicine in medications:
        key = str(medicine).lower()
        if key in MEDICATION_RULES:
            results.extend(_match_rules(item, MEDICATION_RULES[key]))

    return results
