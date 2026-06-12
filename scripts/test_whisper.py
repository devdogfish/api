import struct
import wave

import requests

path = '/tmp/silence.wav'
with wave.open(path, 'w') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(16000)
    for _ in range(16000):
        w.writeframes(struct.pack('<h', 0))

with open(path, 'rb') as f:
    response = requests.post(
        'http://127.0.0.1:8000/transcribe',
        files={'file': ('silence.wav', f, 'audio/wav')},
        timeout=240,
    )
print(response.status_code)
print(response.text[:500])
