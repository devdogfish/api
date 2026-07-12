# OCR Research Progress

## Summary

Good progress has been made on the Girke API OCR research track. The project is now set up for the actual benchmark loop: the API docs and prior research have been reviewed, the public OCR test dataset has been downloaded and verified locally, and the first OCR dependencies are installed on the VPS.

The next step is straightforward: continue testing OCR engines/model variants against the provided matching `.txt` files, then turn the results into a concise recommendation for the Girke API OCR endpoint.

## What has been completed

### Girke API context reviewed

Reviewed `/home/ubuntu/dev/api/README.md`.

Key points:

- Girke API is a Hono/TypeScript service.
- Public base URL is `https://api.girke.dev`.
- Existing AI/media capability is the transcription sidecar using faster-whisper tiers.
- The README does not currently define an OCR endpoint, so this research is useful groundwork for adding one cleanly.

### Prior research reviewed

Reviewed `/home/ubuntu/dev/api/RESEARCH.md`.

Important inherited context:

- Previous conclusion: Unlimited-OCR is probably not practical on this CPU-only VPS.
- Host target: ARM64, 4 vCPU, 23 GiB RAM, no GPU, no swap.
- Practical model strategy should favor lightweight CPU-capable OCR stacks over large VLM OCR systems.

### Host suitability checked

The machine is confirmed to be a CPU-only ARM64 VPS:

- Architecture: ARM64 / aarch64
- CPU: 4 vCPU, Neoverse-N1
- RAM: 23 GiB total
- Swap: none
- Disk: enough free space for OCR testing
- GPU: none

This is enough for practical OCR engines and smaller CPU-friendly models, but not ideal for large vision-language OCR models.

### External research links checked

The two public gist links referenced in `RESEARCH.md` were checked and currently return 404:

- `https://gist.github.com/hermesdogfish/71e59984680461f9515e8d34b761266b`
- `https://gist.github.com/hermesdogfish/e57f0b3c8e9c2e0e6e37ea36daabf9a5`

The local repo docs and live machine checks are therefore the reliable source of truth for this pass.

### OCR test dataset downloaded and verified

The Proton Drive dataset was successfully downloaded into:

`/home/ubuntu/dev/api/tmp_ocr_bench/data`

Downloaded image/text pairs:

- `IMG_2172.jpeg` / `IMG_2172.txt`
- `IMG_2174.jpeg` / `IMG_2174.txt`
- `IMG_2175.jpeg` / `IMG_2175.txt`
- `IMG_2176.jpeg` / `IMG_2176.txt`
- `IMG_2177.jpeg` / `IMG_2177.txt`
- `IMG_2178.jpeg` / `IMG_2178.txt`
- `IMG_2180.jpeg` / `IMG_2180.txt`

The `.txt` files are usable as the benchmark reference targets. They contain realistic OCR-style product/shipping-label text, including English, German, French, layout noise, and some imperfect recognition artifacts. That makes the dataset useful because the benchmark can compare each OCR output against the provided target text directly.

### Dataset character understood

The dataset covers varied real-world OCR cases:

- `IMG_2172`: Amazon/shipping label with mixed label text and noisy characters.
- `IMG_2174`: German supplement front label.
- `IMG_2175`: German supplement ingredients and directions.
- `IMG_2176`: Ricola medicinal ingredients label.
- `IMG_2177`: Kirkland granola bar label, English/French.
- `IMG_2178`: Smartfood/Frito Lay nutrition and ingredients label, dense and challenging.
- `IMG_2180`: Jameson bottle label, English/French.

This is a solid test set for practical multilingual/product-label OCR.

### Initial OCR dependencies installed

Installed system OCR/runtime dependencies:

- `tesseract-ocr`
- `tesseract-ocr-eng`
- `tesseract-ocr-deu`
- `tesseract-ocr-osd`

Installed Python benchmarking/image-processing dependencies in the Hermes environment:

- `pillow`
- `opencv-python-headless`
- `pytesseract`
- `rapidfuzz`
- `pandas`
- `numpy`

This is enough to start the first benchmark pass with Tesseract variants and preprocessing strategies.

## Positive finding so far

The VPS is not a strong fit for giant OCR/VLM models, but it is well positioned for a practical, reliable OCR endpoint based on CPU-friendly engines.

The best path is likely not “run the biggest OCR model.” The better product path is:

1. Benchmark lightweight OCR stacks honestly.
2. Pick the fastest acceptable engine for default usage.
3. Keep heavier OCR/VLM options as optional future tiers only if they prove stable on CPU.

This aligns well with the Girke API’s current tiered transcription design.

## Recommended next steps

### 1. Continue OCR model testing

Compare each OCR candidate against the downloaded image/text pairs and capture the practical tradeoffs:

- How reliably it runs on this ARM64 CPU-only VPS.
- How long it takes on the full sample set.
- How closely the extracted text matches the provided `.txt` references.
- Whether the output is useful enough for a Girke API endpoint.

### 2. Benchmark Tesseract variants first

Start with the already-installed engine:

- `eng`
- `deu`
- `eng+deu`
- `osd+eng+deu`
- PSM modes: `3`, `4`, `6`, `11`, `12`, `13`
- With and without OpenCV preprocessing:
  - grayscale
  - thresholding
  - resize/upscale
  - denoise/sharpen if helpful

This alone can produce 10+ meaningful variants quickly.

### 3. Try additional CPU-feasible OCR engines

After the Tesseract baseline, test install/runtime feasibility for:

- EasyOCR
- PaddleOCR
- docTR
- Surya OCR
- TrOCR or Donut only if CPU runtime is not absurd

If a model fails to install or run on ARM64 CPU, record that clearly as a benchmark result rather than treating it as wasted effort.

### 4. Produce final report

Write the final report to one of:

- `/home/ubuntu/dev/api/OCR_RESEARCH.md`
- `/home/ubuntu/dev/api/tmp_ocr_bench/OCR_RESEARCH.md`

The final report should include:

- Executive summary
- Host constraints
- Dataset description
- Models/engines tested
- Speed table
- Accuracy table
- Failures/incompatibilities
- Recommended endpoint implementation
- Suggested Girke API tiering, if useful

## Current status

Status: ready for benchmark execution.

The foundation work is complete: docs reviewed, links checked, machine constraints confirmed, dataset acquired, references verified, and baseline OCR dependencies installed. The remaining work is the benchmark loop and final recommendation report.
