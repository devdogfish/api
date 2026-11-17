"""Offline private PDF redaction pilot. Adapted from Quantself's synthetic PDF proof (#447)."""

import argparse
import csv
import hashlib
import io
import json
import math
import os
import re
import stat
import subprocess
import unicodedata
from bisect import bisect_right
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import pymupdf as pdf
from pypdf import PdfReader, PdfWriter

from paddle_scan import PaddleScan
from placeholder_pixels import apply_patches, subtract
from structured_identifiers import structured_matches, structured_value

DPI = 300
MAX_PAGES = 8
MAX_PIXELS = 12_000_000
MAX_CANDIDATE_BYTES = MAX_PAGES * MAX_PIXELS * 3 + 2 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def command(*args, data=None):
    result = subprocess.run(args, input=data, capture_output=True, timeout=30, check=True)
    if args[0] != "tesseract":
        require(not result.stderr, "PDF tool reported a warning")
    return result.stdout.decode("utf-8")


def tokens(text):
    return tuple(re.findall(r"\w+|[^\w\s]", unicodedata.normalize("NFC", text).casefold()))


def matching_starts(sequence, term):
    for index in range(len(sequence) - len(term) + 1):
        if sequence[index:index + len(term)] == term:
            yield index


def contains(sequence, term):
    return next(matching_starts(sequence, term), None) is not None


def settings(directory):
    request = json.loads((directory / "dictionary.json").read_text())
    language = request["language"]
    require(language in ("eng", "deu"), "unsupported OCR language")
    identifiers = [tokens(value) for value in request["identifiers"]]
    anchors = [[tokens(value) for value in page] for page in request["safeTextByPage"]]
    structured = request.get("structuredIdentifiers", False)
    require(type(structured) is bool, "invalid structured detector setting")
    require((identifiers or structured) and all(identifiers) and all(page and all(page) for page in anchors),
            "missing identifier or safe text")
    return identifiers, anchors, language, structured


def raster(page):
    return page.get_pixmap(dpi=DPI, colorspace=pdf.csRGB, alpha=False, annots=False)


def ocr(pixels, language, segmentation):
    tsv = command("tesseract", "stdin", "stdout", "-l", language, "--dpi", str(DPI),
                  "--psm", str(segmentation), "tsv", data=pixels.tobytes("png"))
    return [row for row in csv.DictReader(io.StringIO(tsv), delimiter="\t") if row["text"].strip()]


def text_boxes(page):
    lines = defaultdict(list)
    for x0, y0, x1, y1, word, block, line, _ in page.get_text("words", sort=False):
        lines[block, line].append((word, pdf.Rect(x0, y0, x1, y1)))
    return lines.values()


def ocr_line(row):
    return tuple(row[key] for key in ("block_num", "par_num", "line_num"))


def ocr_text(rows):
    lines = defaultdict(list)
    for row in rows:
        lines[ocr_line(row)].append(row["text"])
    return "\n".join(" ".join(line) for line in lines.values())


def ocr_boxes(page, pixels, language):
    lines = defaultdict(list)
    scale = pdf.Matrix(page.rect.width / pixels.width, page.rect.height / pixels.height)
    for row in ocr(pixels, language, 6):
        x, y, w, h = (int(row[key]) for key in ("left", "top", "width", "height"))
        box = pdf.Rect(x, y, x + w, y + h) * scale
        lines[ocr_line(row)].append((row["text"], box))
    return lines.values()


def identifier_boxes(lines, terms, structured):
    for line in lines:
        parts = [(token, box) for word, box in line for token in tokens(word)]
        sequence = tuple(token for token, _ in parts)
        for term in terms:
            for i in matching_starts(sequence, term):
                box = pdf.Rect()
                for _, word in parts[i:i + len(term)]:
                    box |= word
                yield box + (-2, -2, 2, 2)
        if structured:
            start = 0
            spans = []
            for word, box in line:
                end = start + len(word)
                spans.append((start, end, box))
                start = end + 1
            for match in structured_matches(" ".join(word for word, _ in line)):
                if not match.valid:
                    continue
                box = pdf.Rect()
                for start, end, word in spans:
                    if start < match.end and end > match.start:
                        box |= word
                yield box + (-2, -2, 2, 2)


@dataclass
class Occurrence:
    identity: tuple
    value: str
    boxes: list


def exact_identities(directory, structured):
    request = json.loads((directory / "dictionary.json").read_text())
    values = request["identifiers"]
    types = request.get("identifierTypes", [None] * len(values))
    require(len(types) == len(values), "identifier types do not match dictionary")
    exact = {}
    for value, kind in zip(values, types, strict=True):
        require(kind in (None, "IDENTIFIER", "PERSON"), "unsupported exact identifier type")
        term = tokens(value)
        trimmed = value.strip()
        known = next((m for m in structured_matches(trimmed)
                      if m.valid and m.start == 0 and m.end == len(trimmed)), None) if structured else None
        if known:
            require(kind in (None, "IDENTIFIER"), "conflicting identifier type")
            canonical = structured_value(known.kind, trimmed)
            identity = (known.kind, canonical)
        else:
            canonical = value
            identity = (kind or "IDENTIFIER", term)
        prior = exact.setdefault(term, (identity, canonical))
        require(prior[0] == identity, "conflicting normalized exact identifiers")
    return exact


def occurrence(identity, value, words):
    lines = {}
    for index, box in words:
        lines[index] = lines.get(index, pdf.Rect()) | box
    boxes = list(lines.values())
    for left, right in zip(boxes, boxes[1:]):
        require(left.y0 < right.y0 and right.y0 - left.y1 <= 2 * max(left.height, right.height),
                "uncertain identifier line wrap")
    return Occurrence(identity, value, boxes)


def detected_occurrences(lines, exact, structured):
    # Newlines preserve the distinction between separators and adjacent values.
    words = []
    text_lines = []
    parts = []
    offset = 0
    for index, line in enumerate(lines):
        line_text = []
        for word, box in line:
            end = offset + len(word)
            words.append((offset, end, index, box))
            parts.extend((token, index, box) for token in tokens(word))
            line_text.append(word)
            offset = end + 1
        text_lines.append(" ".join(line_text))
    sequence = tuple(token for token, _, _ in parts)
    for term, (identity, value) in exact.items():
        for start in matching_starts(sequence, term):
            yield occurrence(identity, value, ((i, box) for _, i, box in parts[start:start + len(term)]))
    if structured:
        joined = "\n".join(text_lines)
        ends = [end for _, end, _, _ in words]
        for match in structured_matches(joined):
            if match.valid:
                value = structured_value(match.kind, joined[match.start:match.end])
                covered = []
                start = bisect_right(ends, match.start)
                for word_index in range(start, len(words)):
                    begin, _, index, box = words[word_index]
                    if begin >= match.end:
                        break
                    covered.append((index, box))
                yield occurrence((match.kind, value), value, covered)


def merge_occurrences(observed):
    unique = []
    for current in observed:
        overlaps = [prior for prior in unique
                    if any(a.intersects(b) for a in prior.boxes for b in current.boxes)]
        if not overlaps:
            unique.append(current)
            continue
        require(len(overlaps) == 1 and overlaps[0].identity == current.identity,
                "conflicting identifier geometries")
        prior = overlaps[0]
        for box in current.boxes:
            touched = [candidate for candidate in prior.boxes if candidate.intersects(box)]
            require(len(touched) <= 1, "conflicting identifier line wrap")
            if touched:
                index = prior.boxes.index(touched[0])
                prior.boxes[index] |= box
            else:
                prior.boxes.append(box)
    return sorted(unique, key=lambda hit: min((box.y0, box.x0) for box in hit.boxes))


def plan_placeholders(page, pixels, exact, structured, identities, values, counters, ocr_lines):
    observed = list(detected_occurrences(text_boxes(page), exact, structured))
    observed.extend(detected_occurrences(ocr_lines, exact, structured))
    boxes = []
    placements = []
    scale = pdf.Matrix(pixels.width / page.rect.width, pixels.height / page.rect.height)
    for hit in merge_occurrences(observed):
        if hit.identity not in identities:
            kind = hit.identity[0]
            counters[kind] += 1
            label = f"[{kind}_{counters[kind]}]"
            identities[hit.identity] = label
            values[label] = hit.value
        label = identities[hit.identity]
        fragments = [(box + (-2, -2, 2, 2)) & page.rect for box in hit.boxes]
        pixel_boxes = [(box * scale).irect & pixels.irect for box in fragments]
        # Use the fragment that accommodates the largest readable label.
        display = max(range(len(pixel_boxes)), key=lambda i: min(
            pixel_boxes[i].width / (len(label) * 0.6), pixel_boxes[i].height / 1.3))
        boxes.extend(fragments)
        painted = [pixel_boxes.pop(display)]
        placements.append((list(painted[0]), label))
        for box in pixel_boxes:
            uncovered = [box]
            for covered in painted:
                uncovered = [part for piece in uncovered for part in subtract(piece, covered)]
            placements.extend((list(part), None) for part in uncovered)
            painted.extend(uncovered)
    return boxes, placements


def check_identifiers(text, terms, structured, message):
    sequence = tokens(text)
    require(not any(contains(sequence, term) for term in terms), message)
    if structured:
        for match in structured_matches(text):
            require(match.valid, "uncertain structured identifier remains")
            raise RuntimeError("structured identifier remains")
    return sequence


def save_flat(pages, path, review, placeholders):
    # Only fresh raster pages enter the writer. PyMuPDF adds Info on save.
    buffer = io.BytesIO(pages.tobytes(garbage=4, deflate=True))
    writer = PdfWriter()
    writer.append_pages_from_reader(PdfReader(buffer, strict=True))
    writer.metadata = None
    if placeholders:
        writer.generate_file_identifiers()
    with path.open("x+b") as target:
        writer.write(target)
        if review:
            target.flush()
            target.seek(0)
            return hashlib.file_digest(target, "sha256").hexdigest()


def check_source(document, anchors):
    require(not document.is_repaired and not document.is_encrypted and document.is_pdf, "invalid input PDF")
    require(1 <= document.page_count <= MAX_PAGES and document.page_count == len(anchors), "unexpected page count")
    for page in document:
        require(page.rotation == 0 and page.cropbox == page.mediabox and
                page.mediabox.tl == pdf.Point(0, 0), "unsupported page geometry")
        width, height = (int(value * DPI / 72 + 1) for value in (page.rect.width, page.rect.height))
        require(width > 0 and height > 0 and width * height <= MAX_PIXELS, "page raster exceeds limit")


def raster_digest(pixels):
    return [pixels.width, pixels.height, hashlib.sha256(pixels.samples).hexdigest()]


def redact(directory, review=False, vault=None, paddle_models=None):
    terms, anchors, language, structured = settings(directory)
    manifest = []
    highlights = []
    placements_by_page = []
    exact = exact_identities(directory, structured) if vault is not None else None
    identities, values, counters = {}, {}, defaultdict(int)
    with pdf.open(directory / "source.pdf") as source, pdf.open() as output:
        check_source(source, anchors)
        paddle = PaddleScan(paddle_models) if paddle_models is not None else None
        for page in source:
            pixels = raster(page)
            ocr_lines = paddle.lines(page, pixels) if paddle else ocr_boxes(page, pixels, language)
            if exact is not None:
                boxes, placements = plan_placeholders(page, pixels, exact, structured, identities, values,
                                                      counters, ocr_lines)
                placements_by_page.append(placements)
            else:
                boxes = list(identifier_boxes(text_boxes(page), terms, structured))
                boxes.extend(identifier_boxes(ocr_lines, terms, structured))
            if review:
                highlights.append([list(box & page.rect) for box in boxes])
            for box in boxes:
                page.add_redact_annot(box, fill=(1, 1, 1), cross_out=False)
            if boxes:
                require(page.apply_redactions(images=pdf.PDF_REDACT_IMAGE_PIXELS,
                                              graphics=pdf.PDF_REDACT_LINE_ART_NONE,
                                              text=pdf.PDF_REDACT_TEXT_REMOVE), "redaction failed")
            check_identifiers(page.get_text(), terms, structured, "identifier remains in working text")
            pixels = raster(page)
            if vault is not None:
                apply_patches(pixels, placements)
            manifest.append(raster_digest(pixels))
            fresh = output.new_page(width=page.rect.width, height=page.rect.height)
            xref = fresh.insert_image(fresh.rect, pixmap=pixels, keep_proportion=False)
            output.xref_set_key(xref, "ColorSpace", "/DeviceRGB")
        digest = save_flat(output, directory / "candidate.pdf", review, vault is not None)
    (directory / "rasters.json").write_text(json.dumps(manifest))
    if review:
        plan = {"digest": digest, "highlights": highlights}
        if paddle:
            plan["paddle"] = paddle.measurement()
        if vault is not None:
            mapping = json.dumps({"candidateSha256": digest, "values": values}, ensure_ascii=False).encode("utf-8")
            with (vault / "mapping.json").open("xb") as private:
                private.write(mapping)
            plan.update(placements=placements_by_page, mappingDigest=hashlib.sha256(mapping).hexdigest())
        (directory / "review-plan.json").write_text(json.dumps(plan))


def ref(document, owner, key):
    kind, value = document.xref_get_key(owner, key)
    require(kind == "xref", "unexpected PDF reference")
    return int(value.split()[0])


def check_page(document, page, original, digest, allowed):
    require(all(math.isclose(a, b, rel_tol=0, abs_tol=0.001) for a, b in zip(page.rect, original.rect)),
            "page dimensions changed")
    images = page.get_images(full=True)
    require(len(images) == 1, "expected one image")
    xref, mask, *_, name, _filter, referrer = images[0]
    require(mask == referrer == 0, "unexpected image mask or nesting")
    resources = ref(document, page.xref, "Resources")
    require(set(document.xref_get_keys(resources)) == {"XObject"} and
            ref(document, resources, f"XObject/{name}") == xref, "unexpected page resources")
    require(set(document.xref_get_keys(page.xref)) <=
            {"Type", "Parent", "MediaBox", "Rotate", "Resources", "Contents"}, "unexpected page features")
    require(set(document.xref_get_keys(xref)) <=
            {"Type", "Subtype", "Width", "Height", "BitsPerComponent", "ColorSpace",
             "Length", "Filter", "DecodeParms"}, "unexpected image metadata")
    require(document.xref_get_key(xref, "ColorSpace") == ("name", "/DeviceRGB"), "expected plain RGB")
    streams = page.get_contents()
    content = page.read_contents().decode("ascii").split()
    require(len(streams) == 1 and len(content) == 11 and content[0] == "q" and
            content[7:] == ["cm", f"/{name}", "Do", "Q"] and
            all(math.isclose(a, b, rel_tol=0, abs_tol=0.001) for a, b in
                zip(map(float, content[1:7]), [page.rect.width, 0, 0, page.rect.height, 0, 0])),
            "unexpected page drawing commands")
    allowed.update((page.xref, resources, xref, *streams))
    embedded = pdf.Pixmap(document, xref)
    require(raster_digest(embedded) == digest, "embedded pixels differ from working raster")
    return embedded


def checked_bytes(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as file:
        info = os.fstat(file.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
                0 < info.st_size <= limit, "invalid private artifact")
        data = file.read(info.st_size + 1)
        require(len(data) == info.st_size, "private artifact size changed")
        return data


def add_review_page(review, original, candidate_pixels, boxes):
    gap, header = 16, 26
    width, height = original.rect.width, original.rect.height
    page = review.new_page(width=2 * width + 3 * gap, height=height + header + gap)
    left = pdf.Rect(gap, header, gap + width, header + height)
    right = left + (width + gap, 0, width + gap, 0)
    page.insert_text((left.x0, 17), "PRIVATE REVIEW / ORIGINAL", fontsize=10)
    page.insert_text((right.x0, 17), "VERIFIED CANDIDATE", fontsize=10)
    page.insert_image(left, pixmap=raster(original), keep_proportion=False)
    page.insert_image(right, pixmap=candidate_pixels, keep_proportion=False)
    for coords in {tuple(box) for box in boxes}:
        box = pdf.Rect(coords)
        require(not box.is_empty and original.rect.contains(box), "invalid review highlight")
        page.draw_rect(box + (right.x0, right.y0, right.x0, right.y0),
                       color=(0.8, 0.13, 0.03), width=1)


def verify(directory, review=False, vault=None):
    terms, anchors, language, structured = settings(directory)
    candidate = checked_bytes(directory / "candidate.pdf", MAX_CANDIDATE_BYTES)
    manifest = json.loads((directory / "rasters.json").read_text())
    highlights = [[] for _ in manifest]
    placements = [[] for _ in manifest]
    labels = set()
    if review:
        plan = json.loads((directory / "review-plan.json").read_text())
        digest = hashlib.sha256(candidate).hexdigest()
        require(digest == plan["digest"], "candidate bytes changed after redaction")
        highlights = plan["highlights"]
        require(("placements" in plan) == (vault is not None) and
                ("mappingDigest" in plan) == (vault is not None), "review requires its Vault mapping")
        if vault is not None:
            placements = plan["placements"]
            mapping = checked_bytes(vault / "mapping.json", 4 * 1024 * 1024)
            mapping_digest = hashlib.sha256(mapping).hexdigest()
            require(mapping_digest == plan["mappingDigest"], "Vault mapping changed before verification")
            reverse = json.loads(mapping)
            require(reverse["candidateSha256"] == digest and isinstance(reverse["values"], dict),
                    "Vault mapping does not belong to candidate")
    require(not command("pdftotext", "-enc", "UTF-8", "-", "-", data=candidate).strip(), "extractable text remains")
    require(not command("pdfinfo", "-meta", "-", data=candidate).strip(), "XMP remains")
    with (pdf.open(directory / "source.pdf") as source, pdf.open(stream=candidate, filetype="pdf") as document,
          pdf.open() as preview):
        check_source(source, anchors)
        require(not document.is_repaired and not document.is_encrypted and
                document.page_count == source.page_count == len(manifest), "invalid candidate")
        require(set(document.xref_get_keys(-1)) <= {"Size", "Root", "ID"}, "unexpected PDF trailer")
        catalog = document.pdf_catalog()
        require(set(document.xref_get_keys(catalog)) == {"Type", "Pages"}, "unexpected catalog features")
        tree = ref(document, catalog, "Pages")
        require(set(document.xref_get_keys(tree)) == {"Type", "Kids", "Count"}, "unexpected page tree")
        allowed = {catalog, tree}
        pages = zip(document, source, manifest, anchors, highlights, placements, strict=True)
        for page, original, raster_hash, safe, boxes, patches in pages:
            embedded = check_page(document, page, original, raster_hash, allowed)
            labels.update(apply_patches(embedded, patches, verify=True))
            rendered = raster(page)
            # Audit across lines and use a different segmentation mode from the detector.
            for pixels in (embedded, rendered):
                seen = check_identifiers(ocr_text(ocr(pixels, language, 11)),
                                         terms, structured, "identifier remains in raster OCR")
                require(all(contains(seen, term) for term in safe), "safe text missing")
            if review:
                add_review_page(preview, original, rendered, boxes)
        objects = {xref for xref in range(1, document.xref_length()) if document.xref_object(xref) != "null"}
        require(objects == allowed, "unexpected PDF objects")
        if vault is not None:
            require(labels == set(reverse["values"]) and
                    all(isinstance(value, str) and value for value in reverse["values"].values()),
                    "Vault mapping and rendered placeholders differ")
        if review:
            review_pdf = preview.tobytes(garbage=4, deflate=True)
            with (directory / "review.pdf").open("xb") as output:
                output.write(review_pdf)
            proof = [digest, hashlib.sha256(review_pdf).hexdigest()]
            if vault is not None:
                proof.append(mapping_digest)
            print(*proof)


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("redact", "verify", "redact-review", "verify-review"))
    parser.add_argument("location", type=Path)
    parser.add_argument("vault", nargs="?", type=Path)
    parser.add_argument("--paddle-models", type=Path)
    args = parser.parse_args()
    action, _, suffix = args.mode.partition("-")
    require(args.vault is None or suffix == "review", "invalid worker mode")
    if action == "redact":
        redact(args.location, review=suffix == "review", vault=args.vault, paddle_models=args.paddle_models)
    else:
        require(args.paddle_models is None, "verification uses independent OCR")
        verify(args.location, review=suffix == "review", vault=args.vault)
