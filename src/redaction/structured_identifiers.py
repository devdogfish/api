"""Offline DE IBAN, personal IdNr, and common ASCII email recognition."""

import re
from collections import Counter
from typing import NamedTuple


class Match(NamedTuple):
    start: int
    end: int
    valid: bool
    kind: str | None = None


DE_IBAN = re.compile(r"(?<!\w)[Dd][Ee][\s-]*[0-9]{2}(?:[\s-]*[0-9]){18}(?!\w)")
TAX_ID = re.compile(r"(?<!\w)(?:[0-9]{11}|[0-9]{2}(?:[\s-]+[0-9]{3}){3})(?!\w)")
EXTRA_DIGIT = re.compile(r"[ \t-]+[0-9]")
ATOM = r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+"
LABEL = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
EMAIL = re.compile(
    rf"(?<![\w!#$%&'*+/=?^`{{|}}~.@-]){ATOM}(?:\.{ATOM})*"
    rf"\s*@\s*(?:{LABEL}\.)+[A-Za-z]{{2,63}}(?![\w@-]|\.[\w.-])",
)


def iban_checksum(text):
    value = re.sub(r"[\s-]+", "", text).upper()
    digits = int(value[2:4])
    # The country letters DE become 13 and 14 after moving the prefix to the end.
    return 2 <= digits <= 98 and int(value[4:] + "1314" + value[2:4]) % 97 == 1


def tax_id_checksum(text):
    value = re.sub(r"[\s-]+", "", text)
    # Include the leading-zero format used by ELSTER test IDs.
    body, check = value[:-1], int(value[-1])
    occurrences = Counter(body)
    repeats = [digit for digit, count in occurrences.items() if count > 1]
    if len(repeats) != 1 or occurrences[repeats[0]] not in (2, 3):
        return False
    if occurrences[repeats[0]] == 3 and repeats[0] * 2 in body:
        return False
    product = 10
    for digit in body:
        total = (int(digit) + product) % 10 or 10
        product = total * 2 % 11
    return (11 - product) % 10 == check


def numeric_match(text, match, checksum, kind):
    # Refuse a prefix of a longer formatted number on the same line.
    valid = not EXTRA_DIGIT.match(text, match.end()) and checksum(match.group())
    return Match(match.start(), match.end(), valid, kind)


def structured_matches(text):
    # A DE IBAN takes precedence over numeric spans within that same value.
    ibans = [numeric_match(text, match, iban_checksum, "IBAN") for match in DE_IBAN.finditer(text)]
    yield from ibans
    for match in TAX_ID.finditer(text):
        if not any(match.start() < iban.end and iban.start < match.end() for iban in ibans):
            yield numeric_match(text, match, tax_id_checksum, "TAX_ID")
    recognized_at_signs = set()
    for match in EMAIL.finditer(text):
        local, domain = match.group().split("@")
        if len(local.rstrip()) <= 64 and len(domain.lstrip()) <= 253:
            recognized_at_signs.add(match.start() + len(local))
            yield Match(match.start(), match.end(), True, "EMAIL")
    for match in re.finditer("@", text):
        if match.start() not in recognized_at_signs:
            yield Match(match.start(), match.end(), False)


def structured_value(kind, text):
    if kind == "EMAIL":
        local, domain = text.split("@")
        return local.rstrip() + "@" + domain.lstrip().lower()
    return re.sub(r"[\s-]+", "", text).upper()
