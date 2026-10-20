# /// script
# requires-python = ">=3.11,<3.12"
# dependencies = [
#   "chatterbox-tts==0.1.7",
#   "setuptools<81",
# ]
# ///
"""Voice-cloning sidecar: Chatterbox Turbo speaks in the voice of a recorded sample.

POST /tts    body = {"text": "..."} -> audio/wav in the sampled voice
POST /prepare                    -> {"ok": bool}  (process a new sample now)
GET  /health                     -> {"ok": true, "hasVoice": bool}

The sample (~/.basketeer/my-voice.wav) is written by the Node server. The model loads once at
startup; the voice conditioning is recomputed whenever the sample file changes.
"""

import io
import json
import os
import re
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import torch

PORT = int(os.environ.get("CLONE_PORT", "3002"))
SAMPLE = Path(os.environ.get("VOICE_SAMPLE_PATH", Path.home() / ".basketeer" / "my-voice.wav"))


def log(*args):
    print("[clone]", *args, file=sys.stderr, flush=True)


device = "mps" if torch.backends.mps.is_available() else "cpu"
log(f"loading Chatterbox Turbo on {device} (first run downloads the model) ...")
from chatterbox.tts_turbo import ChatterboxTurboTTS  # noqa: E402

model = ChatterboxTurboTTS.from_pretrained(device=device)
lock = threading.Lock()  # one generation at a time
loaded_mtime = None


def ensure_voice():
    """Recompute the voice conditioning if the sample changed. Returns False if there's none."""
    global loaded_mtime
    if not SAMPLE.exists():
        return False
    mtime = SAMPLE.stat().st_mtime
    if mtime != loaded_mtime:
        model.prepare_conditionals(str(SAMPLE))
        loaded_mtime = mtime
        log(f"using voice sample {SAMPLE}")
    return True


def chunks(text: str, limit: int = 220):
    """Split into sentence groups so long replies don't get truncated or drift."""
    out, cur = [], ""
    for s in re.split(r"(?<=[.!?])\s+", text.strip()):
        if cur and len(cur) + len(s) > limit:
            out.append(cur)
            cur = s
        else:
            cur = f"{cur} {s}".strip()
    if cur:
        out.append(cur)
    return out


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
            self.send_json(200, {"ok": True, "hasVoice": SAMPLE.exists()})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        try:
            if self.path == "/prepare":
                # Re-read the sample now (after a new recording) instead of on the next reply.
                with lock:
                    ok = ensure_voice()
                return self.send_json(200 if ok else 409, {"ok": ok})
            if self.path == "/tts":
                text = json.loads(body)["text"]
                parts = []
                with lock:
                    if not ensure_voice():
                        return self.send_json(409, {"error": "No voice recorded yet."})
                    for c in chunks(text):
                        wav = model.generate(c)
                        parts.append(wav.squeeze(0).numpy())
                        parts.append(np.zeros(int(model.sr * 0.15), dtype=np.float32))
                self.send(200, to_wav(np.concatenate(parts), model.sr), "audio/wav")
            else:
                self.send_json(404, {"error": "not found"})
        except Exception as e:
            log("error:", repr(e))
            self.send_json(500, {"error": str(e)})


log(f"ready on http://127.0.0.1:{PORT}")
ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
