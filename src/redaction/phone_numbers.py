"""Bounded, local phone recognition with pinned numbering-plan metadata."""

import re
from time import process_time
from typing import NamedTuple

VERSION = "9.0.43"
MAX_TEXT = 65_536
MAX_NUMBER_GROUPS = 4_096
PHONE_CUE = re.compile(r"\b(?:tel(?:ephone|efon)?|phone|mobile?|fax|handy|cell)\.?[ \t]*:?[ \t]*$", re.I)
AREA_CODE = re.compile(r"^\([0-9]{2,5}\)")
NUMBER_START = re.compile(r"(?<!\d)\d")
NEXT_NUMERIC_LINE = re.compile(r"\n(?=[ \t]*[0-9(])")
# Distinguish a possible continuation from additional text after the match.
NUMERIC_TAIL = re.compile(r"[ \t.-]+[0-9]")


class PhoneMatch(NamedTuple):
    start: int
    end: int
    value: str


def intersects(left, right):
    return left.start < right.end and right.start < left.end


class PhoneNumbers:
    version = VERSION

    def __init__(self, regions):
        started = process_time()
        import phonenumbers

        if phonenumbers.__version__ != VERSION:
            raise ValueError("local phone parser version does not match the pinned release")
        if (len(regions) > 3 or len(set(regions)) != len(regions) or
                any(region not in phonenumbers.SUPPORTED_REGIONS for region in regions)):
            raise ValueError("invalid configured phone regions")
        self.parser = phonenumbers
        self.regions = tuple(regions)
        self.cpu_seconds = process_time() - started
        self.calls = 0

    def matches(self, text, protected=(), known=(), explicit=False):
        started = process_time()
        if len(text) > MAX_TEXT or sum(1 for _ in NUMBER_START.finditer(text)) > MAX_NUMBER_GROUPS:
            raise ValueError("page exceeds phone matching bound")
        # Preserve offsets while permitting a numeric continuation on the next printed line.
        joined = NEXT_NUMERIC_LINE.sub(" ", text)
        found = []
        for region in (None, *self.regions):
            matcher = self.parser.PhoneNumberMatcher(
                joined, region, self.parser.Leniency.VALID, max_tries=8 * MAX_TEXT
            )
            for item in matcher:
                raw = text[item.start:item.end]
                if raw.startswith("+") != (region is None):
                    continue
                if region and not self.parser.is_valid_number_for_region(item.number, region):
                    continue
                base = self.parser.format_number(item.number, self.parser.PhoneNumberFormat.E164)
                if not re.fullmatch(r"\+[0-9]{7,15}", base):
                    continue
                value = base + ";ext=" + item.number.extension if item.number.extension else base

                candidate = PhoneMatch(item.start, item.end, value)
                if any(intersects(candidate, prior) for prior in protected):
                    continue
                cue = PHONE_CUE.search(text[max(0, item.start - 40):item.start])
                if region:
                    if not (explicit or base in known or cue or AREA_CODE.match(raw)):
                        continue
                    parsed = self.parser.parse(joined[item.start:item.end], region, keep_raw_input=True)
                    if parsed.country_code_source != self.parser.CountryCodeSource.FROM_DEFAULT_COUNTRY:
                        continue
                if raw.count("\n") > 1:
                    raise ValueError("uncertain phone number wrap")
                if NUMERIC_TAIL.match(joined, item.end):
                    raise ValueError("phone match may be a partial number")
                if candidate not in found:
                    if any(intersects(candidate, prior) for prior in found):
                        raise ValueError("conflicting phone interpretations")
                    found.append(candidate)

        self.cpu_seconds += process_time() - started
        self.calls += 1
        return sorted(found)

    def measurement(self):
        return {"version": VERSION, "regions": self.regions, "cpuSeconds": self.cpu_seconds, "calls": self.calls}
