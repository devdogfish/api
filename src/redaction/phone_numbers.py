"""Bounded, local phone recognition with pinned numbering-plan metadata."""

import re
from bisect import bisect_left, bisect_right
from time import process_time
from typing import NamedTuple

VERSION = "9.0.43"
MAX_TEXT = 65_536
MAX_NUMBER_GROUPS = 4_096
MAX_CHUNKS = 16
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
        if len(text) <= MAX_TEXT and sum(1 for _ in NUMBER_START.finditer(text)) <= MAX_NUMBER_GROUPS:
            return self.scan(text, protected, known, explicit)
        # Noisy OCR can exceed one bounded scan. Split at line breaks that cannot continue a number,
        # scan each chunk within the same bounds, and keep an overall cap.
        if len(text) > MAX_TEXT * MAX_CHUNKS or sum(1 for _ in NUMBER_START.finditer(text)) > MAX_NUMBER_GROUPS * MAX_CHUNKS:
            raise ValueError("page exceeds phone matching bound")
        # Line ends (exclusive) with the running digit-group count, so chunk sizing stays linear.
        ends = [match.end() for match in re.finditer("\n", text)]
        if not ends or ends[-1] != len(text):
            ends.append(len(text))
        starts = [match.start() for match in NUMBER_START.finditer(text)]
        found, start = [], 0
        while start < len(text):
            first = bisect_left(starts, start)
            end = start
            for cut in ends[bisect_right(ends, start):]:
                if cut - start > MAX_TEXT or bisect_left(starts, cut) - first > MAX_NUMBER_GROUPS:
                    break
                end = cut
            if end == start:
                raise ValueError("page exceeds phone matching bound")
            if end < len(text) and NEXT_NUMERIC_LINE.match(text, end - 1):
                # The next line may continue a number: rescan the current last line with it.
                overlap = text.rfind("\n", start, end - 1) + 1
            else:
                overlap = end
            chunk = text[start:end]
            shifted = [PhoneMatch(item.start - start, item.end - start, "") for item in protected
                       if item.end > start and item.start < end]
            for item in self.scan(chunk, shifted, known, explicit):
                candidate = PhoneMatch(item.start + start, item.end + start, item.value)
                if candidate in found:
                    continue
                if any(intersects(candidate, prior) for prior in found):
                    raise ValueError("conflicting phone interpretations")
                found.append(candidate)
            start = overlap if overlap > start else end
        return sorted(found)

    def scan(self, text, protected=(), known=(), explicit=False):
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
