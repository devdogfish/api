"""Optional second pass for person names with a pinned local 4B model (Owner decision, quantself#698).

The model runs only through a local llama.cpp binary, loads only for this step and never receives
anything except page text already on this machine. Names it returns are kept only when they appear
verbatim in that text, so the model can add redactions but never invent or remove them.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from time import perf_counter

# Qwen/Qwen3-4B-GGUF at bc640142c66e1fdd12af0bd68f40445458f3869b, Apache-2.0.
MODEL_NAME = "Qwen3-4B-Q4_K_M.gguf"
MODEL_SHA256 = "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5"
MODEL_BYTES = 2_497_280_256
MAX_CHARS = 6_000
MAX_NAMES = 64
# Shorter model-guessed names match OCR noise; listed identifiers have no such floor.
MIN_LETTERS = 3
TITLES = {"dr", "mr", "mrs", "ms", "miss", "prof", "sir", "herr", "frau", "sr", "sra", "dra", "dona", "don"}
# Continuation after the prefilled "[": a closed list of short quoted strings, nothing else.
GRAMMAR = r'''root ::= ws ("]" | item (ws "," ws item)* ws "]")
item ::= "\"" [^"\\\n]{1,80} "\""
ws ::= [ \n]{0,3}'''
SYSTEM = (
    "You extract names of people from document text. Output a JSON array of strings: every name of a "
    "human person exactly as it is written in the text, including first names or surnames that appear "
    "alone. Never include companies, banks, insurers, government bodies, places, streets, products or "
    "job titles. Output [] when there are no people."
)


def verified_model(path):
    path = Path(path)
    info = path.stat()
    if path.name != MODEL_NAME or info.st_size != MODEL_BYTES:
        raise ValueError("local name model is not the pinned release")
    digest = hashlib.sha256()
    with path.open("rb") as model:
        for block in iter(lambda: model.read(8 * 1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != MODEL_SHA256:
        raise ValueError("local name model checksum mismatch")
    return path


class LocalNameModel:
    def __init__(self, model, runtime=None):
        started = perf_counter()
        self.model = verified_model(model)
        self.runtime = runtime or os.environ.get("GIRKE_LLAMA_COMPLETION") or shutil.which("llama-completion")
        if not self.runtime or not Path(self.runtime).is_file():
            raise ValueError("local llama.cpp runtime is unavailable")
        self.cache = {}
        self.calls = 0
        self.names = 0
        self.seconds = 0.0
        self.initialization_seconds = perf_counter() - started

    def _ask(self, text):
        prompt = (f"<|im_start|>system\n{SYSTEM}<|im_end|>\n<|im_start|>user\n{text}\n/no_think<|im_end|>\n"
                  "<|im_start|>assistant\n<think>\n\n</think>\n\n[")
        started = perf_counter()
        result = subprocess.run(
            [self.runtime, "-m", str(self.model), "-no-cnv", "--no-display-prompt", "--no-warmup",
             "--temp", "0", "--seed", "0", "-n", "1024", "-c", "8192", "--grammar", GRAMMAR, "-p", prompt],
            capture_output=True, timeout=600, check=True,
        )
        self.seconds += perf_counter() - started
        self.calls += 1
        output = "[" + result.stdout.decode("utf-8", "replace")
        try:
            names, _ = json.JSONDecoder().raw_decode(output)
        except ValueError as error:
            raise ValueError("local name model returned no complete list") from error
        if not isinstance(names, list) or len(names) > MAX_NAMES or not all(isinstance(n, str) for n in names):
            raise ValueError("local name model returned an invalid list")
        return [" ".join(name.split()) for name in names if name.strip()]

    def spans(self, text, tokens):
        """Return name token sequences that occur verbatim in text, including the parts of full names."""
        text = text.strip()
        if not text:
            return []
        if text not in self.cache:
            found = []
            for start in range(0, len(text), MAX_CHARS):
                found.extend(self._ask(text[start:start + MAX_CHARS]))
            self.cache[text] = found
        sequence = tokens(text)
        terms = []
        for name in self.cache[text]:
            term = tuple(token for token in tokens(name) if token not in TITLES or len(tokens(name)) == 1)
            parts = [part for part in term if re.fullmatch(r"[^\W\d_]{3,}", part)]
            for candidate in [term] + ([(part,) for part in parts if part not in TITLES] if len(parts) > 1 else []):
                if sum(len(token) for token in candidate if token.isalnum()) >= MIN_LETTERS and any(sequence[i:i + len(candidate)] == candidate
                                     for i in range(len(sequence) - len(candidate) + 1)):
                    terms.append(candidate)
        self.names += len(terms)
        return list(dict.fromkeys(terms))

    def measurement(self):
        return {"model": MODEL_NAME, "sha256": MODEL_SHA256, "initializationSeconds": self.initialization_seconds,
                "calls": self.calls, "names": self.names, "seconds": self.seconds}
