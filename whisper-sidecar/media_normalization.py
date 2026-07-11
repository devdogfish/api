import subprocess
from pathlib import Path
from typing import Callable, Sequence

SUPPORTED_AUDIO_EXTENSIONS = {
    '.wav',
    '.mp3',
    '.m4a',
    '.aac',
    '.ogg',
    '.opus',
    '.flac',
    '.webm',
}

SUPPORTED_VIDEO_EXTENSIONS = {
    '.mp4',
    '.mov',
    '.mkv',
    '.webm',
    '.avi',
}

SUPPORTED_MEDIA_EXTENSIONS = SUPPORTED_AUDIO_EXTENSIONS | SUPPORTED_VIDEO_EXTENSIONS
Runner = Callable[[Sequence[str]], object]


def normalize_media_file(source: Path, runner: Runner | None = None) -> Path:
    """Normalize common audio/video files to Whisper-friendly mono 16 kHz WAV.

    The same path works for audio and video inputs because ffmpeg extracts the
    primary audio stream and drops video with -vn.
    """
    suffix = source.suffix.lower()
    if suffix not in SUPPORTED_MEDIA_EXTENSIONS:
        raise ValueError(f"unsupported_media_format:{suffix or 'none'}")

    output = source.with_suffix('.normalized.wav')
    command = [
        'ffmpeg',
        '-y',
        '-i',
        str(source),
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-f',
        'wav',
        str(output),
    ]

    run = runner or (lambda cmd: subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE))
    run(command)
    return output
