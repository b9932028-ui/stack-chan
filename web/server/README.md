# ChyMOD voice backend

The Vite development server exposes request-scoped local endpoints for ChyMOD voice:

- `POST /api/chymod/voice/transcribe` — local `faster-whisper` `small`
- `POST /api/chymod/voice/ask` — stateless `codex exec` with `gpt-5.6-luna` and `read-only` sandboxing
- `POST /api/chymod/voice/speak` — Windows SAPI, written as 16 kHz mono PCM16

Install the STT dependency into the Python environment used by the backend:

```powershell
C:\Users\<you>\anaconda3\envs\Whisper\python.exe -m pip install -r server\requirements-chymod-voice.txt
```

Optional environment variables:

- `CHYMOD_WHISPER_PYTHON`
- `CHYMOD_CODEX_BIN`
- `CHYMOD_POWERSHELL_BIN`

Audio and text are written only to request-scoped operating-system temporary directories. Each directory is removed in a `finally` block.
