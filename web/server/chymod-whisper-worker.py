"""Long-lived faster-whisper worker for the ChyMOD voice backend.

Reads one JSON request per stdin line ({"id": 1, "audio": "utterance.wav"}) and
writes one JSON response per stdout line. The model stays loaded between
requests. CUDA is used when CTranslate2 can run on the GPU with the cuBLAS and
cuDNN libraries from the nvidia-* pip packages; otherwise it falls back to CPU
int8. Set CHYMOD_WHISPER_DEVICE to "cpu" or "cuda" to force a device. Logs go to
stderr so stdout carries only protocol lines.
"""

import argparse
import glob
import json
import os
import sys
import sysconfig

INITIAL_PROMPT = "This is primarily US English speech and may include Traditional Chinese words or phrases."


def log(message):
    print(message, file=sys.stderr, flush=True)


def emit(message):
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def expose_nvidia_libraries():
    site_packages = sysconfig.get_paths()["purelib"]
    for directory in glob.glob(os.path.join(site_packages, "nvidia", "*", "bin")):
        if hasattr(os, "add_dll_directory"):
            os.add_dll_directory(directory)
        os.environ["PATH"] = directory + os.pathsep + os.environ.get("PATH", "")


def load_model(name, requested_device):
    import ctranslate2
    import numpy as np
    from faster_whisper import WhisperModel

    if requested_device in ("auto", "cuda") and ctranslate2.get_cuda_device_count() > 0:
        try:
            model = WhisperModel(name, device="cuda", compute_type="float16")
            # cuBLAS and cuDNN load lazily, so run the encoder once before trusting CUDA.
            segments, _ = model.transcribe(np.zeros(16000, dtype=np.float32), beam_size=1, vad_filter=False)
            list(segments)
            return model, "cuda", "float16"
        except Exception as error:
            if requested_device == "cuda":
                raise
            log(f"CUDA is unavailable, falling back to CPU: {error}")
    return WhisperModel(name, device="cpu", compute_type="int8"), "cpu", "int8"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    expose_nvidia_libraries()
    model, device, compute_type = load_model(args.model, os.environ.get("CHYMOD_WHISPER_DEVICE", "auto"))
    emit({"type": "ready", "device": device, "computeType": compute_type})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            request_id = request["id"]
            audio = request["audio"]
        except (ValueError, KeyError, TypeError) as error:
            log(f"ignored malformed request: {error}")
            continue
        try:
            segments, _ = model.transcribe(audio, beam_size=5, vad_filter=True, initial_prompt=INITIAL_PROMPT)
            emit({"id": request_id, "text": "".join(segment.text for segment in segments).strip()})
        except Exception as error:
            emit({"id": request_id, "error": str(error)})


if __name__ == "__main__":
    main()
