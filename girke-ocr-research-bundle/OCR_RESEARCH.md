# OCR Research Report — Girke API

Generated: 2026-07-12  
Repo: `/home/ubuntu/dev/api`  
Benchmark data: `/home/ubuntu/dev/api/tmp_ocr_bench/data`  
Benchmark outputs: `/home/ubuntu/dev/api/tmp_ocr_bench/results_fast`

## Executive summary

I reviewed the Girke API README, `RESEARCH.md`, the prior progress file, and the nested external gist links. The gist links currently return HTTP 404, so the reliable inputs for this pass are the repo docs, the live machine, and the Proton Drive OCR dataset already downloaded locally.

I benchmarked **20 OCR variants** on the CPU-only ARM64 VPS against the 7 image/`.txt` pairs. The clear practical winner is:

- **Recommended default:** `tesseract` with the **Latin script model**, `--psm 11`, grayscale preprocessing.
- **Measured speed:** **18.214s total** for 7 full-resolution 4032×3024 images; **2.602s/image** average.
- **Measured accuracy:** **0.7360 token-set similarity**, **0.3888 strict normalized character accuracy** against the provided `.txt` mirrors.
- **Why this wins:** best accuracy by a wide margin while still fast enough for a Girke API synchronous/async OCR endpoint on this CPU-only VPS.

The best language-agnostic-ish route for this dataset is the Tesseract **Latin script** pack, not hardcoded `eng`/`deu`/`fra`. It works across English, German, French, and general Latin-script product/shipping-label text without asking the caller for language.

## Host constraints

From the live machine:

- Architecture: `aarch64` / ARM64
- CPU: 4 vCPU
- RAM: 23 GiB, no swap
- GPU: none
- Disk free during test: ~101 GiB on `/`
- Tesseract: 5.3.4

Implication: large OCR/VLM systems are not the right default. Use CPU-native OCR first; keep heavier neural OCR as optional async/future tiers only.

## Girke API context reviewed

From `README.md`:

- Girke API is a Hono/TypeScript service at `https://api.girke.dev`.
- It already has a tiered protected transcription endpoint using a FastAPI sidecar pattern.
- No OCR endpoint is currently defined.
- OCR should follow the existing pattern: protected API route, sidecar-style processor, metadata endpoint, sync for short/small jobs, async jobs for large images/batches.

From `RESEARCH.md` / `PROGRESS.md`:

- Previous conclusion that Unlimited-OCR is not realistic on this CPU-only VPS still holds.
- Favor lightweight CPU-capable OCR stacks.
- Existing model endpoint strategy should stay under ~10 total endpoints.

External links checked:

- `https://gist.github.com/hermesdogfish/71e59984680461f9515e8d34b761266b` → HTTP 404
- `https://gist.github.com/hermesdogfish/e57f0b3c8e9c2e0e6e37ea36daabf9a5` → HTTP 404

## Dataset

Downloaded Proton Drive data is in:

`/home/ubuntu/dev/api/tmp_ocr_bench/data`

Pairs tested:

| Image | Size | Reference chars | Content type |
|---|---:|---:|---|
| IMG_2172.jpeg | 4032×3024 | 293 | shipping/Amazon label |
| IMG_2174.jpeg | 4032×3024 | 113 | German supplement front label |
| IMG_2175.jpeg | 4032×3024 | 1377 | German supplement ingredients/directions |
| IMG_2176.jpeg | 4032×3024 | 5185 | Ricola medicinal ingredients label |
| IMG_2177.jpeg | 4032×3024 | 341 | Kirkland granola bar English/French |
| IMG_2178.jpeg | 4032×3024 | 1634 | Smartfood/Frito Lay dense label |
| IMG_2180.jpeg | 4032×3024 | 357 | Jameson bottle English/French |

## Accuracy method

Each OCR output was compared to the same-stem `.txt` file.

Metrics:

- **Token-set similarity:** RapidFuzz token-set ratio after lowercasing, punctuation stripping, and whitespace normalization. This is forgiving for layout/order noise and is the best practical usefulness signal for labels.
- **Strict char accuracy:** `1 - normalized Levenshtein distance` after the same normalization. This is harsh for OCR because line order/layout changes count as errors.

The `.txt` mirrors include OCR-like artifacts themselves, so these scores measure resemblance to the provided targets, not perfect human transcription.

## Full benchmark summary

| Variant | Images OK | Total sec | Avg sec/img | Token-set acc | Char acc | Status |
|---|---:|---:|---:|---:|---:|---|
| tess-latin-psm11-gray | 7/7 | 18.214 | 2.602 | 0.7360 | 0.3888 | ok |
| tess-eng+deu+fra-psm12-raw | 7/7 | 40.314 | 5.759 | 0.5853 | 0.2948 | ok |
| tess-latin-psm12-raw | 7/7 | 30.564 | 4.366 | 0.5837 | 0.2729 | ok |
| tess-deu-psm3-raw | 7/7 | 18.392 | 2.627 | 0.4636 | 0.2055 | ok |
| tess-eng+deu+fra-psm3-raw | 7/7 | 36.514 | 5.216 | 0.4658 | 0.2039 | ok |
| tess-latin+eng-psm3-raw | 7/7 | 30.199 | 4.314 | 0.4619 | 0.2031 | ok |
| tess-fra-psm3-raw | 7/7 | 18.508 | 2.644 | 0.4705 | 0.2029 | ok |
| tess-eng-psm3-raw | 7/7 | 18.162 | 2.595 | 0.4657 | 0.2015 | ok |
| tess-latin-psm11-raw | 7/7 | 36.754 | 5.251 | 0.3626 | 0.1986 | ok |
| tess-eng+deu+fra-psm11-raw | 7/7 | 56.390 | 8.056 | 0.3673 | 0.1951 | ok |
| tess-latin-psm3-raw | 7/7 | 22.047 | 3.150 | 0.4538 | 0.1947 | ok |
| tess-latin-psm11-sharpen | 5/7 | 67.616 | 13.523 | 0.6507 | 0.1309 | partial |
| tess-latin-psm11-otsu | 7/7 | 89.059 | 12.723 | 0.6682 | 0.1308 | ok |
| tess-latin-psm11-up2_gray | 7/7 | 97.774 | 13.968 | 0.6702 | 0.1306 | ok |
| tess-latin-psm6-raw | 7/7 | 62.145 | 8.878 | 0.3502 | 0.1027 | ok |
| tess-latin-psm11-contrast | 7/7 | 110.296 | 15.757 | 0.3125 | 0.1024 | ok |
| tess-eng+deu+fra-psm6-raw | 7/7 | 111.897 | 15.985 | 0.3539 | 0.1001 | ok |
| tess-eng+deu+fra-psm4-raw | 7/7 | 10.450 | 1.493 | 0.2130 | 0.0368 | ok |
| tess-latin-psm4-raw | 7/7 | 10.354 | 1.479 | 0.2077 | 0.0359 | ok |
| tess-latin-psm13-raw | 7/7 | 31.661 | 4.523 | 0.0114 | 0.0047 | ok |

## Best variant per-image results

Best variant: `tess-latin-psm11-gray`

| Image | Sec | Token-set acc | Char acc | Output chars |
|---|---:|---:|---:|---:|
| IMG_2172.jpeg | 1.528 | 0.5691 | 0.3798 | 314 |
| IMG_2174.jpeg | 3.013 | 0.8828 | 0.0000 | 1208 |
| IMG_2175.jpeg | 2.090 | 0.8039 | 0.6562 | 1378 |
| IMG_2176.jpeg | 5.818 | 0.8839 | 0.5183 | 4763 |
| IMG_2177.jpeg | 1.536 | 0.7735 | 0.4105 | 509 |
| IMG_2178.jpeg | 2.470 | 0.6461 | 0.4357 | 1199 |
| IMG_2180.jpeg | 1.759 | 0.5930 | 0.3208 | 490 |

## Additional engine attempt: EasyOCR

I installed EasyOCR successfully with Torch on ARM64, but it is not a good default on this VPS:

- Package install succeeded via `uv pip install easyocr`.
- First inference on `IMG_2172.jpeg` took **35.607s for one image** and produced low similarity: token-set **0.2263**, char **0.1533**.
- It then failed on the next full-resolution image with an OpenCV resize assertion inside EasyOCR.
- A prior multi-language EasyOCR run exceeded the 600s command budget before completing all variants.

Conclusion: EasyOCR is too slow/fragile here for the default endpoint. It can be revisited only if images are downscaled/tiled and processed async.

## Findings

1. **Best overall:** `tess-latin-psm11-gray`.
   - Highest token-set and char accuracy.
   - Fast enough for short sync calls.
   - Language-agnostic for Latin-script labels, which matches this dataset.

2. **Second-best accuracy:** `tess-eng+deu+fra-psm12-raw`.
   - More than 2× slower than the winner and lower accuracy.
   - Worth keeping as an optional fallback, not default.

3. **Fastest variants are bad.**
   - PSM 4 variants ran around 1.5s/image but extracted almost nothing useful.

4. **Upscaling often hurts on this VPS.**
   - Upscaled/thresholded variants inflated output size and runtime while reducing strict accuracy.
   - Simple grayscale preprocessing beat heavier OpenCV tricks.

5. **Tesseract language packs vs script pack.**
   - Individual `eng`, `deu`, `fra` were all close around ~0.20 strict char accuracy.
   - `Latin` script with sparse text mode + grayscale jumped to **0.3888** strict char accuracy and **0.7360** token-set similarity.

## Recommendation for Girke API OCR endpoint

Use a small OCR sidecar rather than embedding OCR inside the Hono app.

Suggested tiers:

- `low`: Tesseract `Latin`, `--psm 3`, raw or grayscale. Faster baseline, lower quality.
- `medium` / default: Tesseract `Latin`, `--psm 11`, grayscale preprocessing. Best current tradeoff.
- `high`: Tesseract ensemble/fallback: run default plus `eng+deu+fra --psm 12`, merge unique lines. Async only; benchmark before shipping.

Suggested route shape, mirroring transcription:

- `GET /api/v1/ocr` — metadata: levels, accepted image formats, max dimensions/bytes.
- `POST /api/v1/ocr/recognize` — sync multipart for one small/medium image.
- `POST /api/v1/ocr/jobs` — async for batches/large images.
- `GET /api/v1/ocr/jobs/:job_id`
- `GET /api/v1/ocr/jobs/:job_id/result`
- `DELETE /api/v1/ocr/jobs/:job_id`

Default implementation details:

```bash
tesseract INPUT stdout -l Latin --psm 11 --oem 1
```

Preprocess:

- Decode image safely.
- Convert to grayscale.
- Preserve original resolution initially; do not upscale by default.
- Enforce max pixels/bytes to avoid huge CPU spikes.
- Return raw text plus optional normalized lines/confidence if using TSV output.

## Files produced

- Report: `/home/ubuntu/dev/api/OCR_RESEARCH.md`
- Benchmark script: `/home/ubuntu/dev/api/tmp_ocr_bench/benchmark_ocr_fast.py`
- Remaining variants script: `/home/ubuntu/dev/api/tmp_ocr_bench/benchmark_remaining.py`
- EasyOCR attempt script: `/home/ubuntu/dev/api/tmp_ocr_bench/run_easy_one.py`
- Summary CSV: `/home/ubuntu/dev/api/tmp_ocr_bench/results_fast/summary.csv`
- Per-image CSV: `/home/ubuntu/dev/api/tmp_ocr_bench/results_fast/per_image.csv`
- OCR text outputs: `/home/ubuntu/dev/api/tmp_ocr_bench/results_fast/texts/`

## Bottom line

Ship OCR v1 with **Tesseract Latin script + PSM 11 + grayscale**. It is boring, CPU-native, installed cleanly, and beat all tested variants. Do not default to EasyOCR/Paddle/large VLM OCR on this machine until there is a GPU or a separate async worker box.
