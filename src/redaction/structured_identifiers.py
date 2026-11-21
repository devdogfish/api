"""Offline IBAN (SWIFT registry countries), German IdNr, and common ASCII email recognition."""

import re
from collections import Counter
from typing import NamedTuple


class Match(NamedTuple):
    start: int
    end: int
    valid: bool
    kind: str | None = None


# IBAN lengths from the SWIFT IBAN Registry. Countries whose BBAN is numeric only accept digits.
IBAN_LENGTHS = dict(item.split(":") for item in """
AD:24 AE:23 AL:28 AT:20 AZ:28 BA:20 BE:16 BG:22 BH:22 BI:27 BR:29 BY:28 CH:21 CR:22 CY:28 CZ:24
DE:22 DJ:27 DK:18 DO:28 EE:20 EG:29 ES:24 FI:18 FK:18 FO:18 FR:27 GB:22 GE:22 GI:23 GL:18 GR:27
GT:28 HR:21 HU:28 IE:22 IL:23 IQ:23 IS:26 IT:27 JO:30 KW:30 KZ:20 LB:28 LC:32 LI:21 LT:20 LU:20
LV:21 LY:25 MC:27 MD:24 ME:22 MK:19 MN:20 MR:27 MT:31 MU:30 NI:28 NL:18 NO:15 OM:23 PK:24 PL:28
PS:29 PT:25 QA:29 RO:24 RS:22 RU:33 SA:24 SC:31 SD:18 SE:24 SI:19 SK:24 SM:27 SO:23 ST:25 SV:28
TL:23 TN:24 TR:26 UA:29 VA:22 VG:24 XK:20 YE:30""".split())
NUMERIC_BBAN = set("AT BE CZ DE DK EE ES FI HR HU IS LT NO PL PT RS SE SI SK".split())
IBAN = re.compile(r"(?<!\w)(?:" + "|".join(
    rf"[{code[0]}{code[0].lower()}][{code[1]}{code[1].lower()}][\s-]*[0-9]{{2}}"
    rf"(?:[\s-]*{'[0-9]' if code in NUMERIC_BBAN else '[0-9A-Za-z]'}){{{int(length) - 4}}}"
    for code, length in IBAN_LENGTHS.items()) + r")(?!\w)")
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
    # ISO 13616: move the country code and check digits to the end, letters become 10-35.
    rearranged = "".join(str(int(char, 36)) for char in value[4:] + value[:4])
    return 2 <= digits <= 98 and int(rearranged) % 97 == 1


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
    # An IBAN takes precedence over numeric spans within that same value.
    ibans = [numeric_match(text, match, iban_checksum, "IBAN") for match in IBAN.finditer(text)]
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
