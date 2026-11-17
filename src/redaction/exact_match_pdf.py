"""Offline exact-match pilot. Adapted from Quantself's synthetic PDF proof (#447)."""

import csv
import hashlib
import io
import json
import math
import os
import re
import subprocess
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

import pymupdf as pdf
from pypdf import PdfReader, PdfWriter

DPI = 300
MAX_PAGES = 8
MAX_PIXELS = 12_000_000


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
    require(identifiers and all(identifiers) and all(page and all(page) for page in anchors),
            "missing identifier or safe text")
    return identifiers, anchors, language


def raster(page):
    return page.get_pixmap(dpi=DPI, colorspace=pdf.csRGB, alpha=False, annots=False)


def ocr(pixels, language, segmentation):
    tsv = command("tesseract", "stdin", "stdout", "-l", language, "--dpi", str(DPI),
                  "--psm", str(segmentation), "tsv", data=pixels.tobytes("png"))
    return [row for row in csv.DictReader(io.StringIO(tsv), delimiter="\t") if row["text"].strip()]


def text_boxes(page):
    lines = defaultdict(list)
    for x0, y0, x1, y1, word, block, line, _ in page.get_text("words", sort=False):
        lines[block, line].extend((token, pdf.Rect(x0, y0, x1, y1)) for token in tokens(word))
    return lines.values()


def ocr_boxes(page, pixels, language):
    lines = defaultdict(list)
    scale = pdf.Matrix(page.rect.width / pixels.width, page.rect.height / pixels.height)
    for row in ocr(pixels, language, 6):
        x, y, w, h = (int(row[key]) for key in ("left", "top", "width", "height"))
        box = pdf.Rect(x, y, x + w, y + h) * scale
        key = tuple(row[column] for column in ("block_num", "par_num", "line_num"))
        lines[key].extend((token, box) for token in tokens(row["text"]))
    return lines.values()


def identifier_boxes(lines, terms):
    for line in lines:
        sequence = tuple(token for token, _ in line)
        for term in terms:
            for i in matching_starts(sequence, term):
                box = pdf.Rect()
                for _, word in line[i:i + len(term)]:
                    box |= word
                yield box + (-2, -2, 2, 2)


def save_flat(pages, path):
    # Only fresh raster pages enter the writer. PyMuPDF adds Info on save.
    buffer = io.BytesIO(pages.tobytes(garbage=4, deflate=True))
    writer = PdfWriter()
    writer.append_pages_from_reader(PdfReader(buffer, strict=True))
    writer.metadata = None
    writer.write(path)


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


def redact(directory):
    terms, anchors, language = settings(directory)
    manifest = []
    with pdf.open(directory / "source.pdf") as source, pdf.open() as output:
        check_source(source, anchors)
        for page in source:
            pixels = raster(page)
            boxes = list(identifier_boxes(text_boxes(page), terms))
            boxes.extend(identifier_boxes(ocr_boxes(page, pixels, language), terms))
            for box in boxes:
                page.add_redact_annot(box, fill=(1, 1, 1), cross_out=False)
            if boxes:
                require(page.apply_redactions(images=pdf.PDF_REDACT_IMAGE_PIXELS,
                                              graphics=pdf.PDF_REDACT_LINE_ART_NONE,
                                              text=pdf.PDF_REDACT_TEXT_REMOVE), "redaction failed")
            remaining = tokens(page.get_text())
            require(not any(contains(remaining, term) for term in terms), "identifier remains in working text")
            pixels = raster(page)
            manifest.append(raster_digest(pixels))
            fresh = output.new_page(width=page.rect.width, height=page.rect.height)
            xref = fresh.insert_image(fresh.rect, pixmap=pixels, keep_proportion=False)
            output.xref_set_key(xref, "ColorSpace", "/DeviceRGB")
        save_flat(output, directory / "candidate.pdf")
    (directory / "rasters.json").write_text(json.dumps(manifest))


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


def verify(directory):
    terms, anchors, language = settings(directory)
    candidate = directory / "candidate.pdf"
    manifest = json.loads((directory / "rasters.json").read_text())
    require(not command("pdftotext", "-enc", "UTF-8", str(candidate), "-").strip(), "extractable text remains")
    require(not command("pdfinfo", "-meta", str(candidate)).strip(), "XMP remains")
    with pdf.open(directory / "source.pdf") as source, pdf.open(candidate) as document:
        check_source(source, anchors)
        require(not document.is_repaired and not document.is_encrypted and
                document.page_count == source.page_count == len(manifest), "invalid candidate")
        require(set(document.xref_get_keys(-1)) <= {"Size", "Root", "ID"}, "unexpected PDF trailer")
        catalog = document.pdf_catalog()
        require(set(document.xref_get_keys(catalog)) == {"Type", "Pages"}, "unexpected catalog features")
        tree = ref(document, catalog, "Pages")
        require(set(document.xref_get_keys(tree)) == {"Type", "Kids", "Count"}, "unexpected page tree")
        allowed = {catalog, tree}
        for page, original, digest, safe in zip(document, source, manifest, anchors, strict=True):
            embedded = check_page(document, page, original, digest, allowed)
            # Audit across lines and use a different segmentation mode from the detector.
            for pixels in (embedded, raster(page)):
                seen = tokens(" ".join(row["text"] for row in ocr(pixels, language, 11)))
                require(not any(contains(seen, term) for term in terms), "identifier remains in raster OCR")
                require(all(contains(seen, term) for term in safe), "safe text missing")
        objects = {xref for xref in range(1, document.xref_length()) if document.xref_object(xref) != "null"}
        require(objects == allowed, "unexpected PDF objects")


if __name__ == "__main__":
    os.umask(0o077)
    mode, location = sys.argv[1:]
    {"redact": redact, "verify": verify}[mode](Path(location))
