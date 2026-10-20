# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = [
#   "parakeet-mlx>=0.3",
#   "kokoro-onnx>=0.4",
#   "numpy",
# ]
# ///
"""Local speech sidecar: Parakeet (speech-to-text) and Kokoro (text-to-speech).

POST /stt  body = audio bytes (any format ffmpeg reads) -> {"text": "..."}
POST /tts  body = {"text": "...", "voice": "bf_emma"}    -> audio/wav
GET  /health                                              -> {"ok": true}

Both models load once at startup and stay in memory.
"""

import io
import json
import os
import sys
import tempfile
import threading
import urllib.request
import wave
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

PORT = int(os.environ.get("SPEECH_PORT", "3001"))
STT_MODEL = os.environ.get("STT_MODEL", "mlx-community/parakeet-tdt-0.6b-v3")
TTS_VOICE = os.environ.get("TTS_VOICE", "bm_george")
TTS_SPEED = float(os.environ.get("TTS_SPEED", "0.95"))
CACHE = Path.home() / ".cache" / "basketeer-voice"
KOKORO_BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
KOKORO_FILES = ["kokoro-v1.0.onnx", "voices-v1.0.bin"]


def log(*args):
    print("[speech]", *args, file=sys.stderr, flush=True)


def ensure_kokoro_files():
    CACHE.mkdir(parents=True, exist_ok=True)
    for name in KOKORO_FILES:
        dest = CACHE / name
        if not dest.exists():
            log(f"downloading {name} ...")
            tmp = dest.with_suffix(dest.suffix + ".part")
            urllib.request.urlretrieve(f"{KOKORO_BASE}/{name}", tmp)
            tmp.rename(dest)
    return [str(CACHE / n) for n in KOKORO_FILES]


log(f"loading STT model {STT_MODEL} ...")
from parakeet_mlx import from_pretrained  # noqa: E402

# MLX streams are per-thread, so the model lives on (and only runs on) one worker thread.
stt_worker = ThreadPoolExecutor(max_workers=1)
stt_model = stt_worker.submit(from_pretrained, STT_MODEL).result()

log("loading Kokoro TTS ...")
from kokoro_onnx import Kokoro  # noqa: E402

tts_model = Kokoro(*ensure_kokoro_files())

tts_lock = threading.Lock()


def to_wav(samples: np.ndarray, rate: int) -> bytes:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send(self, code, body: bytes, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, code, obj):
        self.send(code, json.dumps(obj).encode())

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"ok": True})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        try:
            if self.path == "/stt":
                with tempfile.NamedTemporaryFile(suffix=".audio") as f:
                    f.write(body)
                    f.flush()
                    result = stt_worker.submit(stt_model.transcribe, f.name).result()
                self.send_json(200, {"text": result.text.strip()})
            elif self.path == "/tts":
                req = json.loads(body)
                with tts_lock:
                    samples, rate = tts_model.create(
                        req["text"],
                        voice=req.get("voice") or TTS_VOICE,
                        speed=float(req.get("speed") or TTS_SPEED),
                        lang="en-gb",
                    )
                self.send(200, to_wav(samples, rate), "audio/wav")
            else:
                self.send_json(404, {"error": "not found"})
        except Exception as e:  # report, don't crash the server
            log("error:", repr(e))
            self.send_json(500, {"error": str(e)})


log(f"ready on http://127.0.0.1:{PORT}")
ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
