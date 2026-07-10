# Girke API

Girke API is a private capability gateway for local AI utilities and small public integration endpoints.

## Language

**Capability Endpoint**:
A top-level API capability exposed to clients, such as transcription, OCR, redaction, chat, coding, or video processing. Supporting HTTP routes for jobs, status, or retrieval belong to the capability endpoint and do not count as separate endpoints.
_Avoid_: Endpoint when counting every HTTP route.
