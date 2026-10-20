# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = [
#   "f5-tts-mlx==0.2.6",
#   "mlx==0.23.2",  # newer MLX rejects the array-valued shapes f5-tts-mlx passes to random.normal
# ]
# ///
"""Voice-cloning sidecar #2: F5-TTS (MLX) speaks in the voice of the recorded sample.

POST /tts    body = {"text": "...", "speed": 1.0} -> audio/wav
POST /prepare                                      -> {"ok": bool}  (process a new sample now)
GET  /health                                       -> {"ok": true, "hasVoice": bool}

Uses the same sample as clone_tts.py (~/.basketeer/my-voice.wav). F5 needs a short reference
clip plus its transcript: we take the first 6-12 s, cut at a pause, and transcribe it with the
Parakeet sidecar. That's redone whenever the sample file changes.

Note: the F5-TTS model weights are licensed CC-BY-NC (non-commercial use).
"""

import io
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import urllib.request
import wave
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import mlx.core as mx
import numpy as np
import soundfile as sf

PORT = int(os.environ.get("F5_PORT", "3003"))
SPEECH_URL = os.environ.get("SPEECH_URL", "http://127.0.0.1:3001")
SAMPLE = Path(os.environ.get("VOICE_SAMPLE_PATH", Path.home() / ".basketeer" / "my-voice.wav"))
SR = 24_000
HOP = 256
TARGET_RMS = 0.1


def log(*args):
    print("[f5]", *args, file=sys.stderr, flush=True)


log("loading F5-TTS (first run downloads the model) ...")
from f5_tts_mlx.cfm import F5TTS  # noqa: E402
from f5_tts_mlx.utils import convert_char_to_pinyin  # noqa: E402

# MLX streams are per-thread, so the model lives on (and only runs on) one worker thread.
worker = ThreadPoolExecutor(max_workers=1)
model = worker.submit(F5TTS.from_pretrained, "lucasnewman/f5-tts-mlx").result()

ref = {"mtime": None, "audio": None, "text": None}
ref_lock = threading.Lock()


def pick_cut(path: Path, lo=6.0, hi=12.0) -> float:
    """End the reference at a pause between lo and hi seconds (fallback: 10 s)."""
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(path), "-af", "silencedetect=noise=-35dB:d=0.25", "-f", "null", "-"],
        capture_output=True, text=True, check=False,
    ).stderr
    starts = [float(m) for m in re.findall(r"silence_start: ([\d.]+)", out)]
    ends = [float(m) for m in re.findall(r"silence_end: ([\d.]+)", out)]
    pauses = [(s + e) / 2 for s, e in zip(starts, ends) if lo <= (s + e) / 2 <= hi]
    return max(pauses) if pauses else 10.0


def transcribe(wav_bytes: bytes) -> str:
    req = urllib.request.Request(f"{SPEECH_URL}/stt", data=wav_bytes, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)["text"].strip()


def load_reference():
    """(Re)build the reference clip + transcript if the sample changed. Returns False if no sample."""
    if not SAMPLE.exists():
        return False
    mtime = SAMPLE.stat().st_mtime
    with ref_lock:
        if ref["mtime"] == mtime:
            return True
        cut = pick_cut(SAMPLE)
        with tempfile.TemporaryDirectory() as d:
            clip = Path(d) / "ref.wav"
            subprocess.run(
                ["ffmpeg", "-loglevel", "error", "-y", "-i", str(SAMPLE), "-t", f"{cut:.2f}",
                 "-ac", "1", "-ar", str(SR), str(clip)],
                check=True,
            )
            text = transcribe(clip.read_bytes())
            audio, _ = sf.read(str(clip), dtype="float32")
        if not re.search(r"[.!?]$", text):
            text += "."
        ref.update(mtime=mtime, audio=audio, text=text + " ")
        log(f"reference: {cut:.1f}s, text: {text!r}")
        return True


def synth(text: str, speed: float) -> np.ndarray:
    audio = mx.array(ref["audio"])
    rms = mx.sqrt(mx.mean(mx.square(audio)))
    if rms < TARGET_RMS:
        audio = audio * TARGET_RMS / rms
    ref_frames = audio.shape[0] // HOP
    ref_len = len(ref["text"].encode())
    out = []
    for sentence in [s.strip() for s in re.split(r"(?<=[.!?;:])\s+", text) if s.strip()]:
        # Duration heuristic from f5-tts-mlx: speak at the reference's chars-per-frame rate.
        frames = ref_frames + int(ref_frames / ref_len * len(sentence.encode()) / speed)
        wave_, _ = model.sample(
            mx.expand_dims(audio, axis=0),
            text=convert_char_to_pinyin([ref["text"] + sentence]),
            duration=frames,
            steps=8,
            method="rk4",
            cfg_strength=2.0,
            sway_sampling_coef=-1.0,
        )
        wave_ = wave_[audio.shape[0]:]
        mx.eval(wave_)
        out.append(np.array(wave_))
        out.append(np.zeros(int(SR * 0.12), dtype=np.float32))
    return np.concatenate(out)


def to_wav(samples: np.ndarray) -> bytes:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
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
                # Rebuild the reference clip + transcript now (after a new recording).
                ok = load_reference()
                return self.send_json(200 if ok else 409, {"ok": ok})
            if self.path != "/tts":
                return self.send_json(404, {"error": "not found"})
            if not load_reference():
                return self.send_json(409, {"error": "No voice recorded yet."})
            req = json.loads(body)
            samples = worker.submit(synth, req["text"], float(req.get("speed") or 1.0)).result()
            self.send(200, to_wav(samples), "audio/wav")
        except Exception as e:
            log("error:", repr(e))
            self.send_json(500, {"error": str(e)})


log(f"ready on http://127.0.0.1:{PORT}")
ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
