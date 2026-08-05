#!/usr/bin/env python3
"""Generate BiS list presets from WickidsTBCBISTracker.

WickidsTBCBISTracker is MIT-licensed and provides structured per-class,
per-spec, per-phase BiS tables with multiple ranked options per slot.
This script fetches the raw Lua data files, parses the relevant tables,
and writes BisList JSON presets under assets/bis_lists/wickids/ plus an
assets/bis_lists/index.json manifest.

Run from the repository root:
    python3 tools/bis_list_generator/generate_wickids.py
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

BASE_URL = "https://raw.githubusercontent.com/Wicksmods/WickidsTBCBISTracker/main/Data"
REPO_ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = REPO_ROOT / "assets" / "bis_lists" / "wickids"
MANIFEST_PATH = REPO_ROOT / "assets" / "bis_lists" / "index.json"

# Spec enum values from proto/common.proto
class Spec:
    Unknown = 0
    BalanceDruid = 1
    FeralCatDruid = 2
    FeralBearDruid = 3
    RestorationDruid = 4
    Hunter = 5
    Mage = 6
    HolyPaladin = 7
    ProtectionPaladin = 8
    RetributionPaladin = 9
    Priest = 10
    Rogue = 11
    ElementalShaman = 12
    EnhancementShaman = 13
    RestorationShaman = 14
    Warlock = 15
    DpsWarrior = 16
    ProtectionWarrior = 17


# Map Wickids class/spec names to the sim's Spec enum values.
WICKIDS_SPEC_TO_SIM: dict[tuple[str, str], list[int]] = {
    ("Druid", "Balance"): [Spec.BalanceDruid],
    ("Druid", "Feral"): [Spec.FeralCatDruid, Spec.FeralBearDruid],
    ("Druid", "Restoration"): [Spec.RestorationDruid],
    ("Hunter", "Beast Mastery"): [Spec.Hunter],
    ("Hunter", "Marksmanship"): [Spec.Hunter],
    ("Hunter", "Survival"): [Spec.Hunter],
    ("Mage", "Arcane"): [Spec.Mage],
    ("Mage", "Fire"): [Spec.Mage],
    ("Mage", "Frost"): [Spec.Mage],
    ("Paladin", "Holy"): [Spec.HolyPaladin],
    ("Paladin", "Protection"): [Spec.ProtectionPaladin],
    ("Paladin", "Retribution"): [Spec.RetributionPaladin],
    ("Priest", "Holy"): [Spec.Priest],
    ("Priest", "Shadow"): [Spec.Priest],
    ("Rogue", "Assassination"): [Spec.Rogue],
    ("Rogue", "Combat"): [Spec.Rogue],
    ("Shaman", "Elemental"): [Spec.ElementalShaman],
    ("Shaman", "Enhancement"): [Spec.EnhancementShaman],
    ("Shaman", "Restoration"): [Spec.RestorationShaman],
    ("Warlock", "Affliction"): [Spec.Warlock],
    ("Warlock", "Demonology"): [Spec.Warlock],
    ("Warlock", "Destruction"): [Spec.Warlock],
    ("Warrior", "Arms"): [Spec.DpsWarrior],
    ("Warrior", "Fury"): [Spec.DpsWarrior],
    ("Warrior", "Protection"): [Spec.ProtectionWarrior],
}

SIM_SPEC_NAMES: dict[int, str] = {
    Spec.BalanceDruid: "Balance Druid",
    Spec.FeralCatDruid: "Feral Cat Druid",
    Spec.FeralBearDruid: "Feral Bear Druid",
    Spec.RestorationDruid: "Restoration Druid",
    Spec.Hunter: "Hunter",
    Spec.Mage: "Mage",
    Spec.HolyPaladin: "Holy Paladin",
    Spec.ProtectionPaladin: "Protection Paladin",
    Spec.RetributionPaladin: "Retribution Paladin",
    Spec.Priest: "Priest",
    Spec.Rogue: "Rogue",
    Spec.ElementalShaman: "Elemental Shaman",
    Spec.EnhancementShaman: "Enhancement Shaman",
    Spec.RestorationShaman: "Restoration Shaman",
    Spec.Warlock: "Warlock",
    Spec.DpsWarrior: "DPS Warrior",
    Spec.ProtectionWarrior: "Protection Warrior",
}

# Map Wickids slot keys to the keys accepted by ui/core/proto_utils/bis_list_parser.ts
SLOT_MAP: dict[str, str] = {
    "Head": "head",
    "Neck": "neck",
    "Shoulder": "shoulder",
    "Back": "back",
    "Chest": "chest",
    "Wrist": "wrist",
    "Hands": "hands",
    "Waist": "waist",
    "Legs": "legs",
    "Feet": "feet",
    "Finger": "finger1",
    "Ring1": "finger1",
    "Ring2": "finger2",
    "Trinket": "trinket1",
    "Trinket1": "trinket1",
    "Trinket2": "trinket2",
    "MainHand": "mainHand",
    "OffHand": "offHand",
    "TwoHand": "mainHand",
    "Relic": "ranged",
}

DATA_FILES = [
    "Data_BalanceDruid.lua",
    "Data_FeralDruid.lua",
    "Data_Hunter.lua",
    "Data_Mage.lua",
    "Data_Paladin.lua",
    "Data_RestorationDruid.lua",
    "Data_Rogue.lua",
    "Data_Shaman.lua",
    "Data_ShadowPriest.lua",
    "Data_HolyPriest.lua",
    "Data_Warlock.lua",
    "Data_Warrior.lua",
]


# ---------------------------------------------------------------------------
# Minimal Lua table parser for the subset used by Wickids data files.
# ---------------------------------------------------------------------------


class LuaParseError(Exception):
    pass


@dataclass
class Token:
    type: str
    value: Any


class LuaTokenizer:
    # String, punctuation/operators, numbers, words (identifiers/true/false/nil).
    _TOKEN_RE = re.compile(
        r'"[^"]*"'
        r'|[{}\[\]()=,;]'
        r'|-?\d+(?:\.\d+)?'
        r'|\b[A-Za-z_][A-Za-z0-9_]*\b'
    )

    def tokenize(self, text: str) -> list[Token]:
        # Strip line comments first so the regex only sees code tokens.
        text_without_comments = re.sub(r"--[^\n]*", "", text)
        tokens: list[Token] = []
        for match in self._TOKEN_RE.finditer(text_without_comments):
            raw = match.group(0)
            if raw.startswith('"'):
                # String literal (simple unescape).
                value = raw[1:-1].replace('\\"', '"').replace("\\\\", "\\")
                tokens.append(Token("STRING", value))
            elif raw in ("{", "}", "[", "]", "(", ")", "=", ",", ";"):
                tokens.append(Token(raw, raw))
            elif raw[0].isdigit() or (raw[0] == "-" and len(raw) > 1 and raw[1].isdigit()):
                tokens.append(Token("NUMBER", self._parse_number(raw)))
            elif raw in ("true", "false", "nil"):
                tokens.append(Token("BOOL" if raw != "nil" else "NIL", raw == "true" if raw != "nil" else None))
            else:
                tokens.append(Token("WORD", raw))
        return tokens

    @staticmethod
    def _parse_number(raw: str) -> int | float:
        if "." in raw:
            return float(raw)
        return int(raw)


class LuaParser:
    def __init__(self, tokens: list[Token]):
        self.tokens = tokens
        self.pos = 0

    def peek(self) -> Token | None:
        if self.pos < len(self.tokens):
            return self.tokens[self.pos]
        return None

    def consume(self, expected_type: str | None = None, expected_value: Any = None) -> Token:
        tok = self.peek()
        if tok is None:
            raise LuaParseError(f"Unexpected end of input, expected {expected_type or expected_value}")
        if expected_type and tok.type != expected_type:
            raise LuaParseError(f"Expected {expected_type}, got {tok.type} ({tok.value}) at pos {self.pos}")
        if expected_value is not None and tok.value != expected_value:
            raise LuaParseError(f"Expected {expected_value}, got {tok.value} at pos {self.pos}")
        self.pos += 1
        return tok

    def parse_table(self) -> dict[Any, Any] | list[Any]:
        self.consume("{")
        if self.peek() and self.peek().type == "}":
            self.consume("}")
            return {}

        # Numeric-key dict: {[1] = x, ...}
        if self.peek() and self.peek().type == "[":
            return self._parse_key_value_table(key_in_brackets=True)

        # String/identifier-key dict: Head = { ... }, ...
        if self.peek() and self.peek().type in ("WORD", "STRING") and self._peek_ahead(1) and self._peek_ahead(1).type == "=":
            return self._parse_key_value_table(key_in_brackets=False)

        # Sequence: { x, y, z }
        return self._parse_sequence()

    def _peek_ahead(self, offset: int) -> Token | None:
        idx = self.pos + offset
        if idx < len(self.tokens):
            return self.tokens[idx]
        return None

    def _parse_key_value_table(self, key_in_brackets: bool) -> dict[Any, Any]:
        result: dict[Any, Any] = {}
        while True:
            if key_in_brackets:
                self.consume("[")
                key = self._parse_value()
                self.consume("]")
            else:
                key_tok = self.consume("WORD" if self.peek().type == "WORD" else "STRING")
                key = key_tok.value
            self.consume("=")
            value = self._parse_value()
            result[key] = value

            tok = self.peek()
            if tok and tok.type == ",":
                self.consume(",")
                if self.peek() and self.peek().type == "}":
                    self.consume("}")
                    break
                continue
            if tok and tok.type == "}":
                self.consume("}")
                break
            raise LuaParseError(f"Expected ',' or '}}' in key-value table, got {tok}")
        return result

    def _parse_sequence(self) -> list[Any]:
        result: list[Any] = []
        while True:
            value = self._parse_value()
            result.append(value)
            tok = self.peek()
            if tok and tok.type == ",":
                self.consume(",")
                if self.peek() and self.peek().type == "}":
                    self.consume("}")
                    break
                continue
            if tok and tok.type == "}":
                self.consume("}")
                break
            raise LuaParseError(f"Expected ',' or '}}' in sequence, got {tok}")
        return result

    def _parse_value(self) -> Any:
        tok = self.peek()
        if tok is None:
            raise LuaParseError("Unexpected end of input while parsing value")
        if tok.type == "STRING":
            self.consume()
            return tok.value
        if tok.type == "NUMBER":
            self.consume()
            return tok.value
        if tok.type == "BOOL":
            self.consume()
            return tok.value
        if tok.type == "NIL":
            self.consume()
            return None
        if tok.type == "WORD":
            self.consume()
            return tok.value
        if tok.type == "{":
            return self.parse_table()
        raise LuaParseError(f"Unexpected token {tok.type} ({tok.value}) while parsing value")


# ---------------------------------------------------------------------------
# File parsing helpers
# ---------------------------------------------------------------------------


def fetch_file(file_name: str) -> str:
    url = f"{BASE_URL}/{file_name}"
    req = urllib.request.Request(url, headers={"User-Agent": "WoWSims-BiS-Generator/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        raise RuntimeError(f"Failed to fetch {url}: {e}") from e


def find_balanced_brace(text: str, open_idx: int) -> int:
    """Return the index of the closing brace matching the brace at open_idx."""
    depth = 1
    i = open_idx + 1
    while i < len(text):
        ch = text[i]
        if ch == '"':
            # Skip string literal; no \n escapes in this data, but respect escapes.
            i += 1
            while i < len(text):
                if text[i] == "\\":
                    i += 2
                elif text[i] == '"':
                    i += 1
                    break
                else:
                    i += 1
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise LuaParseError("Unbalanced braces")


def parse_spec_table(text: str, start: int, end: int) -> dict[Any, Any]:
    tokenizer = LuaTokenizer()
    tokens = tokenizer.tokenize(text[start : end + 1])
    parser = LuaParser(tokens)
    return parser.parse_table()


# ---------------------------------------------------------------------------
# Data transformation
# ---------------------------------------------------------------------------


@dataclass
class ParsedItemEntry:
    slot: str
    item_id: int
    name: str
    source: str


@dataclass
class SpecPhaseData:
    sim_spec: int
    phase: int
    entries: list[ParsedItemEntry] = field(default_factory=list)


def parse_lua_file(text: str, class_name: str, file_name: str) -> list[tuple[str, dict[Any, Any]]]:
    """Return a list of (wickids_spec_name, parsed_table) for a single file."""
    pattern = re.compile(r'WTBT_Data\s*\[\s*"([^"]+)"\s*\]\s*\[\s*"([^"]+)"\s*\]\s*=\s*\{')
    results: list[tuple[str, dict[Any, Any]]] = []
    for match in pattern.finditer(text):
        matched_class = match.group(1)
        spec_name = match.group(2)
        if matched_class != class_name:
            print(f"  Warning: class mismatch in {file_name}: expected {class_name}, got {matched_class}", file=sys.stderr)
        open_idx = text.find("{", match.start())
        close_idx = find_balanced_brace(text, open_idx)
        parsed = parse_spec_table(text, open_idx, close_idx)
        results.append((spec_name, parsed))
    return results


def dedupe_entries(entries: list[ParsedItemEntry]) -> list[ParsedItemEntry]:
    # The sim treats an item ID as unique, so keep the first occurrence even if it
    # appears under multiple slots in the source data.
    seen: set[int] = set()
    out: list[ParsedItemEntry] = []
    for e in entries:
        if e.item_id in seen:
            continue
        seen.add(e.item_id)
        out.append(e)
    return out


def build_spec_phase_data(
    file_name: str,
    class_name: str,
    wickids_spec: str,
    parsed: dict[Any, Any],
) -> dict[int, dict[int, list[ParsedItemEntry]]]:
    """Map parsed Lua table into {sim_spec: {phase: [entries]}}."""
    sim_specs = WICKIDS_SPEC_TO_SIM.get((class_name, wickids_spec))
    if not sim_specs:
        print(f"  Warning: no sim spec mapping for {class_name}/{wickids_spec} in {file_name}", file=sys.stderr)
        return {}

    result: dict[int, dict[int, list[ParsedItemEntry]]] = {sim_spec: {} for sim_spec in sim_specs}
    for phase_key, phase_table in parsed.items():
        if not isinstance(phase_key, int):
            continue
        phase = phase_key
        if not isinstance(phase_table, dict):
            continue
        for slot_key, slot_entries in phase_table.items():
            sim_slot = SLOT_MAP.get(slot_key)
            if sim_slot is None:
                print(f"  Warning: unknown slot '{slot_key}' in {class_name}/{wickids_spec} phase {phase}", file=sys.stderr)
                continue
            if not isinstance(slot_entries, list):
                continue
            for raw in slot_entries:
                if not isinstance(raw, dict):
                    continue
                item_id = raw.get("itemId")
                if not isinstance(item_id, int) or item_id <= 0:
                    continue
                name = raw.get("name") or ""
                source = raw.get("source") or ""
                for sim_spec in sim_specs:
                    result[sim_spec].setdefault(phase, []).append(
                        ParsedItemEntry(slot=sim_slot, item_id=item_id, name=name, source=source)
                    )
    return result


# ---------------------------------------------------------------------------
# Output generation
# ---------------------------------------------------------------------------


def safe_filename_part(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


def generate_preset_json(entries: list[ParsedItemEntry], name: str, source: str, sim_spec: int, phase: int) -> dict[str, Any]:
    slots: dict[str, list[dict[str, Any]]] = {}
    for entry in entries:
        slots.setdefault(entry.slot, []).append({
            "id": entry.item_id,
            "name": entry.name,
            "note": entry.source,
        })
    return {
        "name": name,
        "source": source,
        "spec": sim_spec,
        "phase": phase,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "slots": slots,
    }


def generate() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # {sim_spec: {phase: [entries]}}
    aggregated: dict[int, dict[int, list[ParsedItemEntry]]] = {}

    for file_name in DATA_FILES:
        # Derive class name from filename: Data_<Class>.lua or Data_<Spec><Class>.lua
        m = re.match(r"Data_(.+?)\.lua$", file_name)
        if not m:
            print(f"  Warning: cannot parse class from {file_name}", file=sys.stderr)
            continue
        # Class names are either a single word (Hunter, Mage) or trailing word after spec (BalanceDruid -> Druid).
        base = m.group(1)
        # Strip leading spec names to get class.
        class_name: str | None = None
        for candidate in ["Druid", "Hunter", "Mage", "Paladin", "Priest", "Rogue", "Shaman", "Warlock", "Warrior"]:
            if base.endswith(candidate):
                class_name = candidate
                break
        if class_name is None:
            print(f"  Warning: could not determine class for {file_name}", file=sys.stderr)
            continue

        print(f"Fetching {file_name}...")
        text = fetch_file(file_name)
        spec_tables = parse_lua_file(text, class_name, file_name)
        for wickids_spec, parsed in spec_tables:
            print(f"  Parsing {class_name}/{wickids_spec}...")
            per_sim = build_spec_phase_data(file_name, class_name, wickids_spec, parsed)
            for sim_spec, phases in per_sim.items():
                aggregated.setdefault(sim_spec, {})
                for phase, entries in phases.items():
                    aggregated[sim_spec].setdefault(phase, []).extend(entries)

    # Deduplicate and write presets.
    manifest: dict[str, Any] = {
        "source": "WickidsTBCBISTracker",
        "sourceUrl": "https://github.com/Wicksmods/WickidsTBCBISTracker",
        "license": "MIT",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "presets": [],
    }

    for sim_spec in sorted(aggregated.keys()):
        spec_name = SIM_SPEC_NAMES.get(sim_spec, f"Spec{sim_spec}")
        filename_base = safe_filename_part(spec_name)
        for phase in sorted(aggregated[sim_spec].keys()):
            entries = dedupe_entries(aggregated[sim_spec][phase])
            if not entries:
                continue
            name = f"Wickids — {spec_name} Phase {phase}"
            preset = generate_preset_json(entries, name, "WickidsTBCBISTracker", sim_spec, phase)
            file_name = f"{filename_base}_p{phase}.json"
            file_path = OUTPUT_DIR / file_name
            file_path.write_text(json.dumps(preset, indent=2, ensure_ascii=False), encoding="utf-8")
            manifest["presets"].append({
                "spec": sim_spec,
                "phase": phase,
                "source": "WickidsTBCBISTracker",
                "label": name,
                "path": f"wickids/{file_name}",
            })
            print(f"Wrote {file_path.relative_to(REPO_ROOT)} ({len(entries)} entries)")

    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {MANIFEST_PATH.relative_to(REPO_ROOT)} ({len(manifest['presets'])} presets)")


if __name__ == "__main__":
    try:
        generate()
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
