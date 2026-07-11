import os
import tempfile
import threading
import time
import gc
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from faster_whisper import WhisperModel
from media_normalization import SUPPORTED_AUDIO_EXTENSIONS, SUPPORTED_VIDEO_EXTENSIONS, normalize_media_file

DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
CPU_THREADS = int(os.getenv("WHISPER_CPU_THREADS", str(min(4, os.cpu_count() or 1))))
NUM_WORKERS = int(os.getenv("WHISPER_NUM_WORKERS", "1"))

LEVELS = {"low", "medium", "high"}
LANGUAGES = {"en", "de"}

DEFAULT_MODEL_MAP = {
    # Benchmarked on this ARM64 VPS: base was faster and more reliable than tiny,
    # especially for German. Keep low fast, but not useless.
    ("low", "en"): "base",
    ("low", "de"): "base",
    ("low", None): "base",
    # English gets the faster distil model that matched small.en quality in the
    # local benchmark; German needs multilingual small.
    ("medium", "en"): "distil-small.en",
    ("medium", "de"): "small",
    ("medium", None): "small",
    # Best practical multilingual model verified on this machine.
    ("high", "en"): "large-v3-turbo",
    ("high", "de"): "large-v3-turbo",
    ("high", None): "large-v3-turbo",
}

app = FastAPI(title="girke-api whisper sidecar")
_models: dict[str, WhisperModel] = {}
_model_lock = threading.Lock()


def _env_key(level: str, language: str | None) -> str:
    suffix = "AUTO" if language is None else language.upper()
    return f"WHISPER_MODEL_{level.upper()}_{suffix}"


def resolve_model(level: str, language: str | None) -> str:
    legacy_model = os.getenv("WHISPER_MODEL")
    override = os.getenv(_env_key(level, language))
    if override:
        return override
    if language is None and legacy_model:
        return legacy_model
    return DEFAULT_MODEL_MAP[(level, language)]


def get_model(model_name: str) -> WhisperModel:
    with _model_lock:
        if model_name not in _models:
            unload_models_except(model_name)
            _models[model_name] = WhisperModel(
                model_name,
                device=DEVICE,
                compute_type=COMPUTE_TYPE,
                cpu_threads=CPU_THREADS,
                num_workers=NUM_WORKERS,
            )
        return _models[model_name]


def unload_models_except(model_name: str) -> None:
    for loaded_name, model in list(_models.items()):
        if loaded_name == model_name:
            continue

        close = getattr(model, "close", None)
        if callable(close):
            close()
        else:
            inner_model = getattr(model, "model", None)
            unload = getattr(inner_model, "unload_model", None)
            if callable(unload):
                unload()

        del _models[loaded_name]
    gc.collect()


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "ok": True,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
        "cpu_threads": CPU_THREADS,
        "loaded_models": sorted(_models.keys()),
    }


@app.get("/models")
def models() -> dict[str, object]:
    return {
        "levels": sorted(LEVELS),
        "languages": sorted(LANGUAGES),
        "models": {
            level: {
                "auto": resolve_model(level, None),
                "en": resolve_model(level, "en"),
                "de": resolve_model(level, "de"),
            }
            for level in sorted(LEVELS)
        },
        "accepted_media": {
            "audio": sorted(ext.lstrip(".") for ext in SUPPORTED_AUDIO_EXTENSIONS),
            "video": sorted(ext.lstrip(".") for ext in SUPPORTED_VIDEO_EXTENSIONS),
        },
    }


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    level: str = Form("medium"),
    language: str | None = Form(None),
):
    normalized_level = level.strip().lower()
    if normalized_level not in LEVELS:
        raise HTTPException(status_code=400, detail="invalid_level")

    normalized_language = language.strip().lower() if language else None
    if normalized_language == "english":
        normalized_language = "en"
    elif normalized_language in {"german", "deutsch"}:
        normalized_language = "de"
    elif normalized_language == "auto":
        normalized_language = None
    if normalized_language not in LANGUAGES and normalized_language is not None:
        raise HTTPException(status_code=400, detail="invalid_language")

    model_name = resolve_model(normalized_level, normalized_language)
    suffix = Path(file.filename or "audio").suffix or ".bin"
    started = time.time()

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        media_path = normalize_media_file(Path(tmp_path))
        segments, info = get_model(model_name).transcribe(
            str(media_path),
            language=normalized_language,
            beam_size=int(os.getenv(f"WHISPER_BEAM_{normalized_level.upper()}", "1")),
            condition_on_previous_text=False,
        )
        segment_list = list(segments)
        response_segments = [
            {
                "start": round(segment.start, 3),
                "end": round(segment.end, 3),
                "text": segment.text.strip(),
            }
            for segment in segment_list
        ]
        text = " ".join(segment["text"] for segment in response_segments).strip()
        return {
            "text": text,
            "segments": response_segments,
            "duration_seconds": round(info.duration, 3),
            "processing_seconds": round(time.time() - started, 3),
            "level": normalized_level,
            "language": normalized_language or "auto",
            "detected_language": info.language,
            "model": model_name,
        }
    except ValueError as exc:
        if str(exc).startswith("unsupported_media_format"):
            raise HTTPException(status_code=415, detail="unsupported_media_format") from exc
        raise
    finally:
        for path in (tmp_path, str(Path(tmp_path).with_suffix('.normalized.wav'))):
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
