# Research
Created and verified both public GitHub gists:  
  
- Batch 1 — “Can I run X?” feasibility checks:  
https://gist.github.com/hermesdogfish/71e59984680461f9515e8d34b761266b  
  
- Batch 2 — local model recommendations:  
https://gist.github.com/hermesdogfish/e57f0b3c8e9c2e0e6e37ea36daabf9a5  
  
Concise answers were already delivered:  
- Unlimited-OCR: **No, not realistically on this CPU-only VPS**  
- Nemotron ASR streaming: **Maybe experimental offline; no for practical supported streaming**  
- Image semantics: **SmolVLM-500M-Instruct**  
- Best general model: **Qwen3-8B Q4_K_M**  
- Best coding model: **Qwen2.5-Coder-7B-Instruct Q4_K_M**  
- Fastest decent general model: **Gemma 3 4B IT Q4_K_M**  
- Redaction: **Presidio + GLiNER2 PII**


I need redaction, I need OCR, I need general purpose model, I need an extremely fast general purpose model for conversation, I need the best coding model, I can run on my machine, I need a voice transcription model. And I need all of these models available in less than 10 endpoints total.

## Host Specifications
ARM64 VPS, 4 vCPU, 23 GiB RAM (only 5.8 GiB free), 111 GiB disk free, no GPU, no swap. Docker installed, no LLM runtime set up yet.

Good for 1–3B models, manageable for 7–8B Q4, nothing larger. Best candidates: Qwen2.5-3B, Llama-3.2-3B, Phi-3.5-mini, maybe Mistral-7B Q4. Add swap before running anything.

## Audio transcription benchmark update — 2026-07-11

The two public gist links above currently return 404 through both raw gist URLs and the GitHub Gist API, so the endpoint work used the repo docs plus live local benchmarks.

Host confirmed: ARM64/aarch64, 4 vCPU, 23 GiB RAM, no GPU, no swap. `yt-dlp` could not pull the provided YouTube sample because YouTube returned a bot/sign-in challenge, so benchmarking used short English/German `espeak-ng` speech clips under `tmp_bench/`.

Benchmark setup: `faster-whisper`, CPU, `int8`, `beam_size=1`, up to 4 CPU threads, short ~8s 16 kHz WAV clips.

Measured candidates:

- `tiny.en` English: 0.715s transcribe; understandable but shaky.
- `tiny` English: 0.812s; rough errors.
- `tiny` German: 11.201s; bad output, not recommended.
- `base.en` English: 1.141s; fast but odd/profane phrase error on synthetic clip.
- `base` English: 1.180s; fastest reliable English-ish output.
- `base` German: 1.316s; usable first sentence, rough second sentence.
- `small.en` English: 3.287s; exact expected output.
- `small` English: 3.347s; very good.
- `small` German: 3.791s; best German among small/base/tiny, one notable noun error.
- `distil-small.en` English: 2.740s; exact expected output, best English medium tier.
- `distil-medium.en` English: 5.942s; slower and not better on this clip.
- `large-v3-turbo` English: 10.830s; exact expected output.
- `large-v3-turbo` German: 11.140s; best practical German result tested, one color-word error.

Selected endpoint tiers:

- `low`: `base` — fastest reliable tier across English/German; `tiny` was lower quality and German was unexpectedly slow/bad.
- `medium`: English `distil-small.en`, German/auto `small`.
- `high`: `large-v3-turbo` — best practical model verified on this CPU-only machine.

