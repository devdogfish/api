"""Local PP-OCRv5 detection geometry for the private PDF worker."""

import math
import os
import re
import resource
import sys
from time import perf_counter

import pymupdf as pdf

DETECTION = "PP-OCRv5_mobile_det"
RECOGNITION = "PP-OCRv5_mobile_rec"


def bounds(coords, width, height):
    x0, y0, x1, y1 = map(float, coords)
    if not (all(math.isfinite(value) for value in (x0, y0, x1, y1)) and
            0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
        raise ValueError("PaddleOCR coordinates are outside the input raster")
    return pdf.Rect(x0, y0, x1, y1)


def word_boxes(text, parts, boxes, region, width, height):
    words = list(re.finditer(r"\S+", text))
    if "".join(parts) != text or len(parts) != len(boxes) or not words:
        raise ValueError("PaddleOCR word geometry does not match the recognized line")
    fragments = []
    end = 0
    for part, coords in zip(parts, boxes, strict=True):
        start = end
        end += len(part)
        if part.strip():
            fragments.append((start, end, bounds(coords, width, height)))

    output = []
    cursor = 0
    for i, word in enumerate(words):
        while fragments[cursor][1] <= word.start():
            cursor += 1
        box = pdf.Rect()
        for index in range(cursor, len(fragments)):
            start, _, fragment = fragments[index]
            if start >= word.end():
                break
            box |= fragment
        # CTC word edges are approximate. Use detector edges at both ends of the line.
        if i == 0:
            box.x0 = min(box.x0, region.x0)
        if i + 1 == len(words):
            box.x1 = max(box.x1, region.x1)
        box.y0 = min(box.y0, region.y0)
        box.y1 = max(box.y1, region.y1)
        output.append((word.group(), box))
    return output


def visual_lines(regions):
    # The detector may return several recognition crops for one printed line.
    rows = []
    for region, words in sorted(regions, key=lambda item: ((item[0].y0 + item[0].y1) / 2, item[0].x0)):
        row = next((row for row in reversed(rows)
                    if (min(region.y1, row[0].y1) - max(region.y0, row[0].y0)) >=
                    min(region.height, row[0].height) / 2), None)
        if row is None:
            rows.append((region, [(region, words)]))
        else:
            row[1].append((region, words))
    for _, pieces in rows:
        line = []
        previous = None
        for region, words in sorted(pieces, key=lambda item: item[0].x0):
            if previous is not None and region.x0 - previous.x1 > 2 * max(region.height, previous.height):
                yield line
                line = []
            line.extend(words)
            previous = region
        yield line


class PaddleScan:
    def __init__(self, models):
        started = perf_counter()
        det, rec = (models / (name + "_infer") for name in (DETECTION, RECOGNITION))
        for directory in (det, rec):
            if any(not (directory / name).is_file()
                   for name in ("inference.json", "inference.pdiparams", "inference.yml")):
                raise ValueError("staged PaddleOCR model files are missing")

        os.environ.update(
            PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK="True", HF_HUB_OFFLINE="1",
            OMP_NUM_THREADS="2", OPENBLAS_NUM_THREADS="2",
        )
        import numpy as np
        from paddleocr import PaddleOCR

        self.numpy = np
        self.model = PaddleOCR(
            device="cpu", cpu_threads=2, enable_mkldnn=False,
            text_detection_model_name=DETECTION, text_detection_model_dir=str(det),
            text_recognition_model_name=RECOGNITION, text_recognition_model_dir=str(rec),
            use_doc_orientation_classify=False, use_doc_unwarping=False,
            use_textline_orientation=False,
        )
        self.initialization_seconds = perf_counter() - started
        self.pages = []

    def lines(self, page, pixels):
        started = perf_counter()
        width, height = pixels.width, pixels.height
        rgb = self.numpy.frombuffer(pixels.samples_mv, dtype=self.numpy.uint8).reshape(height, width, 3)
        bgr = self.numpy.ascontiguousarray(rgb[:, :, ::-1])
        result, = self.model.predict(bgr, return_word_box=True)
        regions = []
        fields = (result[key] for key in ("rec_texts", "rec_boxes", "text_word", "text_word_boxes"))
        for text, coords, parts, boxes in zip(*fields, strict=True):
            if text.strip():
                region = bounds(coords, width, height)
                words = word_boxes(text, parts, boxes, region, width, height)
                regions.append((region, words))
        scale = pdf.Matrix(page.rect.width / width, page.rect.height / height)
        lines = [[(word, box * scale) for word, box in line] for line in visual_lines(regions)]
        if not lines:
            raise ValueError("PaddleOCR found no word geometry on the page")
        self.pages.append({"seconds": perf_counter() - started, "words": sum(map(len, lines))})
        return lines

    def measurement(self):
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return {
            "model": "PP-OCRv5_mobile",
            "initializationSeconds": self.initialization_seconds,
            "pages": self.pages,
            "peakRssBytes": peak if sys.platform == "darwin" else peak * 1024,
        }
