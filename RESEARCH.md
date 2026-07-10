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