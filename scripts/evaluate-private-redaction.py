"""Aggregate-only worker. Launch through evaluate-private-redaction.sh."""

import argparse
from collections import Counter, defaultdict
import json
import os
from pathlib import Path
import stat
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "redaction"))

DETECTORS = ("exact", "structured", "person", "phone")


def valid_phrase(value):
    return isinstance(value, str) and 0 < len(value) <= 256


def read_private(worker, path, limit):
    info = path.lstat()
    worker.require(info.st_uid == os.geteuid() and not info.st_mode & 0o077, "private input required")
    return worker.checked_bytes(path, limit)


def identifier_key(worker, value, structured, phones):
    value = value.strip()
    if structured:
        for match in worker.structured_matches(value):
            if match.valid and match.start == 0 and match.end == len(value):
                return match.kind, worker.structured_value(match.kind, value)
    if phones:
        for match in phones.matches(value, explicit=True):
            if match.start == 0 and match.end == len(value):
                return "PHONE", match.value
    return "text", worker.tokens(value)


def label_counts(worker, text, values, keys, phones):
    sequence = worker.tokens(text)
    structured = any(key[0] not in ("text", "PHONE") for key in keys.values())
    parsed = list(worker.structured_matches(text)) if structured else []
    hits = Counter((hit.kind, worker.structured_value(hit.kind, text[hit.start:hit.end]))
                   for hit in parsed if hit.valid)
    if phones and any(key[0] == "PHONE" for key in keys.values()):
        hits.update(("PHONE", match.value) for match in phones.matches(text, explicit=True))
    return {value: max(hits[keys[value]], sum(1 for _ in worker.matching_starts(sequence, values[value])))
            for value in values}


def evaluate_document(worker, spec, root, options, totals):
    filename = spec["pdf"]
    worker.require(isinstance(filename, str) and Path(filename).name == filename, "use a relative PDF basename")
    source = read_private(worker, root / filename, 25 * 1024 * 1024)
    dictionary = spec["dictionary"]
    worker.require(isinstance(dictionary, dict), "dictionary required")
    anchors = dictionary["safeTextByPage"]
    identifiers = dictionary["identifiers"]
    worker.require(isinstance(identifiers, list) and len(identifiers) <= 128
                   and all(map(valid_phrase, identifiers)), "invalid exact dictionary")
    worker.require(isinstance(anchors, list) and 1 <= len(anchors) <= worker.MAX_PAGES
                   and all(isinstance(page, list) and 1 <= len(page) <= 32
                           and all(map(valid_phrase, page)) for page in anchors), "invalid safe anchors")
    enabled = {"exact"}
    if dictionary.get("structuredIdentifiers") is True:
        enabled.add("structured")
    if options.person_names:
        enabled.add("person")
    if options.phone_regions is not None:
        enabled.add("phone")

    labels = defaultdict(dict)
    raw_labels = spec["expected"]
    worker.require(isinstance(raw_labels, list) and 1 <= len(raw_labels) <= 512, "expected labels required")
    values = {}
    for item in raw_labels:
        page, value, count, detectors = (item[k] for k in ("page", "value", "count", "detectors"))
        worker.require(type(page) is int and 1 <= page <= len(anchors)
                       and isinstance(value, str) and 0 < len(value) <= 256 and (term := worker.tokens(value))
                       and type(count) is int and 1 <= count <= 128
                       and isinstance(detectors, list) and detectors and set(detectors) <= enabled,
                       "invalid expected label")
        worker.require(value not in labels[page - 1], "duplicate expected label")
        labels[page - 1][value] = (count, set(detectors))
        values[value] = term

    environment = {}
    residuals = Counter()

    def measure(page, pixels, ocr_lines, exact, structured, names, phones):
        keys = {value: identifier_key(worker, value, structured, phones) for value in values}
        worker.require(len(set(keys.values())) == len(keys), "duplicate normalized labels")
        environment.update(keys=keys, phones=phones)
        language = dictionary["language"]
        original_ocr = worker.ocr_text(worker.ocr(pixels, language, 11))
        check_counts = label_counts(worker, original_ocr, values, keys, phones)
        extracted_counts = label_counts(worker, page.get_text(), values, keys, phones)
        for value in values:
            expected = labels[page.number].get(value, (0,))[0]
            totals["source_count_mismatches"] += int(
                check_counts[value] != expected or extracted_counts[value] > expected)
        scans = {
            "exact": (exact, False, None, None),
            "structured": ({}, structured, None, None),
            "person": ({}, False, names, None),
            "phone": ({}, False, None, phones),
        }
        for detector, inputs in scans.items():
            expected = {value: count for value, (count, assigned) in labels[page.number].items() if detector in assigned}
            if not expected:
                continue
            detected = []
            for lines in (worker.text_boxes(page), ocr_lines):
                detected.extend(worker.detected_occurrences(lines, *inputs))
            observed = Counter(identifier_key(worker, hit.value, structured, phones)
                               if hit.identity[0] not in ("PHONE", "TAX_ID", "IBAN", "EMAIL") else hit.identity
                               for hit in worker.merge_occurrences(detected))
            bucket = totals["detectors"][detector]
            for value, count in expected.items():
                bucket["expected"] += count
                bucket["misses"] += max(0, count - observed[keys[value]])

    def audit(page, text):
        for value, count in label_counts(worker, text, values, **environment).items():
            residuals[page, value] = max(residuals[page, value], count)

    with tempfile.TemporaryDirectory(prefix=".redaction-evaluation-", dir=root) as scratch:
        target = Path(scratch)
        (target / "source.pdf").write_bytes(source)
        (target / "dictionary.json").write_text(json.dumps(dictionary))
        vault = target / "vault"
        vault.mkdir(mode=0o700)
        scratch_settings = ("HOME", "TMPDIR", "XDG_CACHE_HOME")
        previous = {key: os.environ.get(key) for key in scratch_settings}
        os.environ.update({key: scratch for key in scratch_settings})
        try:
            worker.redact(target, review=True, vault=vault, paddle_models=options.paddle_models,
                          person_names=options.person_names, phone_regions=options.phone_regions, observe=measure)
            worker.verify(target, review=True, vault=vault, person_names=options.person_names,
                          phone_regions=options.phone_regions, observe_ocr=audit)
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
    totals["documents"] += 1
    totals["residuals"] += sum(residuals.values())


def run(totals):
    import exact_match_pdf as worker

    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--paddle-models", type=Path)
    parser.add_argument("--person-names", action="store_true")
    parser.add_argument("--phone-regions", type=lambda value: value.split(",") if value else [])
    options = parser.parse_args()
    if options.paddle_models is not None:
        options.paddle_models = options.paddle_models.resolve()
    root = options.manifest.absolute().parent
    info = root.stat()
    worker.require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o077,
                   "private directory required")
    manifest = json.loads(read_private(worker, options.manifest, 1024 * 1024))
    documents = manifest["documents"]
    worker.require(isinstance(documents, list) and 1 <= len(documents) <= 32, "documents required")
    for document in documents:
        evaluate_document(worker, document, root, options, totals)


def main():
    os.umask(0o077)
    # Silence native libraries, subprocess stderr, tracebacks and verifier digests.
    output = os.dup(1)
    with open(os.devnull, "wb") as sink:
        os.dup2(sink.fileno(), 1)
        os.dup2(sink.fileno(), 2)
    totals = {"documents": 0, "detectors": {name: {"expected": 0, "misses": 0} for name in DETECTORS},
              "source_count_mismatches": 0, "residuals": 0, "errors": 0}
    try:
        run(totals)
    except (Exception, SystemExit):
        totals["errors"] = 1
    if totals["errors"] or totals["source_count_mismatches"]:
        totals["residuals"] = None
    with os.fdopen(output, "w") as report:
        print(json.dumps(totals, sort_keys=True), file=report)
    return int(bool(totals["errors"] or totals["source_count_mismatches"] or totals["residuals"]))


if __name__ == "__main__":
    sys.exit(main())
