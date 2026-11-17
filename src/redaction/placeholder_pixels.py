"""Paint a complete replacement for each redacted region in the flattened raster."""

import re

import pymupdf as pdf

LABEL = re.compile(r"\[(?:PERSON|IDENTIFIER|IBAN|TAX_ID|EMAIL)_[1-9][0-9]*\]")


def patch(box, label):
    if label is None:
        pixels = pdf.Pixmap(pdf.csRGB, box, False)
        pixels.clear_with(255)
        return pixels
    if not isinstance(label, str) or not LABEL.fullmatch(label):
        raise ValueError("invalid placeholder label")
    unit_width = pdf.get_text_length(label, fontname="cour", fontsize=1)
    size = min(64, (box.width - 8) / unit_width, (box.height - 8) / 1.3)
    if size < 24:
        raise ValueError("placeholder does not fit the redacted region")
    with pdf.open() as document:
        page = document.new_page(width=box.width, height=box.height)
        page.insert_text((4, (box.height + size * 0.55) / 2), label, fontname="cour", fontsize=size)
        pixels = page.get_pixmap(colorspace=pdf.csRGB, alpha=False)
    pixels.set_origin(box.x0, box.y0)
    return pixels


def subtract(box, covered):
    common = box & covered
    if common.is_empty:
        return [box]
    pieces = [
        pdf.IRect(box.x0, box.y0, common.x0, box.y1),
        pdf.IRect(common.x1, box.y0, box.x1, box.y1),
        pdf.IRect(common.x0, box.y0, common.x1, common.y0),
        pdf.IRect(common.x0, common.y1, common.x1, box.y1),
    ]
    return [piece for piece in pieces if not piece.is_empty]


def apply_patches(pixels, placements, verify=False):
    labels = set()
    used = []
    bounds = pdf.IRect(pixels.irect)
    for coords, label in placements:
        if len(coords) != 4 or any(type(coord) is not int for coord in coords):
            raise ValueError("invalid placeholder coordinates")
        box = pdf.IRect(coords)
        if box.is_empty or not bounds.contains(box) or any(box.intersects(other) for other in used):
            raise ValueError("overlapping or out-of-bounds placeholder regions")
        used.append(box)
        expected = patch(box, label)
        if verify:
            actual = pdf.Pixmap(pdf.csRGB, box, False)
            actual.copy(pixels, box)
            if actual.samples != expected.samples:
                raise ValueError("unexpected pixels inside placeholder region")
        else:
            pixels.copy(expected, box)
        if label is not None:
            labels.add(label)
    return labels
