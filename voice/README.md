# Tesco Voice

A local web app for doing your Tesco shop by talking. You speak, Parakeet transcribes on-device, Claude does the shopping through basketeer, and Kokoro reads the reply aloud.

```
browser mic ─▶ /api/stt ─▶ Parakeet (MLX, local)
                 text ─▶ Claude Agent SDK ─▶ basketeer CLI + shop tools
               reply ─▶ /api/tts ─▶ Kokoro (ONNX, local) ─▶ speaker
```

## Run

```bash
npm run build            # once, from the repo root: the agent uses dist/
npm run voice            # starts the speech sidecar and the server
```

Open http://localhost:3000. The first start downloads Parakeet (~1.2 GB) and Kokoro (~350 MB) into the Hugging Face cache and `~/.cache/basketeer-voice/`.

Requirements: Apple Silicon Mac, `uv`, `ffmpeg`, a signed-in `claude` CLI, and a basketeer session (`basketeer login`).

## Modes

- **Tap to talk**: tap the mic, speak, tap again to send.
- **Hands-free**: tap once to start listening; it records when you speak and sends after about 1.2 s of silence. It pauses while thinking and speaking. Tap the mic while it's speaking to interrupt.

You can also type messages.

## Voices

Pick a voice under the mic. Kokoro has eight British voices (George is the default) and three speeds. Prices are spoken as "26 pounds and 43 pence".

**My voice** clones your own voice. There are two engines to compare, both using the same recording: [Chatterbox Turbo](https://github.com/resemble-ai/chatterbox) and [F5-TTS](https://github.com/lucasnewman/f5-tts-mlx) (MLX; weights are non-commercial, `f5_tts.py`, port 3003, transcribes the first 6–12 s of your recording with Parakeet as its reference). Click **Record my voice**, read the paragraph (about 20 seconds, somewhere quiet), and replies come back in your voice. The sample is saved to `~/.basketeer/my-voice.wav`. The cloning sidecar (`clone_tts.py`, port 3002) only starts once you use My voice, or at launch if a sample exists. It downloads about 2 GB the first time, takes a minute or two to load, and once warm generates speech at roughly real time. The speed setting doesn't apply to it. Chatterbox adds an inaudible watermark to what it generates. Only clone voices you have permission to use.

## What the agent can do

- Search, add, change and remove basket items (`basketeer` CLI, Bash restricted to `basketeer …`).
- Recipes from BBC Good Food (`recipe_search`, `recipe_get`), then add the ingredients in one go.
- "Add my usuals": order history is synced to `~/.basketeer/order-history.json` (incremental, at most every 6 hours). `usual_items` finds products in at least 25% of orders over the last 6 months, and `basket_add_many` tops the basket up to their typical quantities.
- `purchase_history` answers "which bread do I usually get?".
- Delivery slots. It never pays.

## Config

| Env | Default |
|---|---|
| `PORT` | `3000` |
| `SPEECH_PORT` / `SPEECH_URL` | `3001` / `http://127.0.0.1:3001` |
| `STT_MODEL` | `mlx-community/parakeet-tdt-0.6b-v3` |
| `TTS_VOICE` | `bm_george` (British: `bm_fable`, `bm_lewis`, `bm_daniel`, `bf_emma`, `bf_isabella`, `bf_alice`, `bf_lily`; pick in the UI) |
| `TTS_SPEED` | `0.95` |
| `CLAUDE_MODEL` | your Claude Code default |
| `ORDER_HISTORY_PATH` | `~/.basketeer/order-history.json` |
| `CLONE_PORT` / `CLONE_URL` | `3002` / `http://127.0.0.1:3002` |
| `VOICE_SAMPLE_PATH` | `~/.basketeer/my-voice.wav` |
| `CHAT_PATH` | `~/.basketeer/voice-chat.json` (chat log + Claude session id; "New conversation" moves the log to `voice-chat-archive.jsonl`) |
