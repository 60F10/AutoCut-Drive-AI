#!/usr/bin/env python3
"""
AutoCut Drive AI — Speech Transcription CLI (faster-whisper with GPU CUDA / CPU int8)

Usage:
  python worker/transcribe.py --in audio.wav --out transcript.json --model medium --lang es --device auto

Outputs JSON:
  {
    "duration": 42.18,
    "language": "es",
    "segments": [
      {
        "id": 0,
        "start": 0.42,
        "end": 3.85,
        "text": "Hola que tal",
        "words": [{ "start": 0.42, "end": 0.78, "text": "Hola", "prob": 0.96 }]
      }
    ]
  }
"""

import argparse
import glob
import importlib.util
import json
import logging
import os
import sys
import warnings

_HF_UNAUTH_MARKER = "unauthenticated requests"


class _HFUnauthenticatedFilter(logging.Filter):
    """Descarta el aviso de Hugging Face sobre peticiones no autenticadas."""

    def filter(self, record) -> bool:
        try:
            return _HF_UNAUTH_MARKER not in record.getMessage().lower()
        except Exception:
            return True


def silence_hf_unauthenticated_warning() -> None:
    logging.getLogger("huggingface_hub").addFilter(_HFUnauthenticatedFilter())
    warnings.filterwarnings("ignore", message=".*unauthenticated requests.*")


def register_cuda_dll_dirs(platform=None, find_spec=None, add_dll_directory=None, environ=None):
    """En Windows, registra site-packages/nvidia/*/bin para que CTranslate2 encuentre cuBLAS/cuDNN.

    Devuelve la lista de carpetas registradas. Los parámetros permiten simular win32 en tests.
    """
    if (platform or sys.platform) != "win32":
        return []
    find_spec = find_spec or importlib.util.find_spec
    add_dll_directory = add_dll_directory or getattr(os, "add_dll_directory", None)
    environ = os.environ if environ is None else environ

    try:
        spec = find_spec("nvidia")
    except (ImportError, ValueError):
        spec = None
    if spec is None:
        return []

    roots = list(getattr(spec, "submodule_search_locations", None) or [])
    registered = []
    for root in roots:
        for bin_dir in sorted(glob.glob(os.path.join(root, "*", "bin"))):
            if not os.path.isdir(bin_dir):
                continue
            if add_dll_directory is not None:
                try:
                    add_dll_directory(bin_dir)
                except OSError:
                    continue
            registered.append(bin_dir)

    if registered:
        current = environ.get("PATH", "")
        existing = current.split(os.pathsep) if current else []
        new_dirs = [d for d in registered if d not in existing]
        if new_dirs:
            environ["PATH"] = os.pathsep.join(new_dirs + ([current] if current else []))
    return registered


def emit_whisper_device(device: str, compute_type: str) -> None:
    sys.stderr.write(f"whisper-device: {device}/{compute_type}\n")
    sys.stderr.flush()


def probe_device() -> tuple:
    """Detecta el dispositivo real sin cargar el modelo (CUDA usable o CPU)."""
    register_cuda_dll_dirs()
    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() > 0:
            if sys.platform == "win32":
                import ctypes

                ctypes.WinDLL("cublas64_12.dll")
            return "cuda", "float16"
    except Exception:
        pass
    return "cpu", "int8"


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe audio WAV with faster-whisper")
    parser.add_argument("--probe", dest="probe", action="store_true", help="Solo detectar el dispositivo (sin cargar el modelo)")
    parser.add_argument("--in", dest="input_path", help="Input 16kHz mono WAV path")
    parser.add_argument("--out", dest="output_path", help="Output JSON path")
    parser.add_argument("--model", dest="model", default="small", help="Whisper model size (small/medium)")
    parser.add_argument("--lang", dest="lang", default="es", help="Language code (default: es)")
    parser.add_argument(
        "--device",
        dest="device",
        choices=["auto", "cuda", "cpu"],
        default="auto",
        help="Execution device: auto (try cuda/float16 then cpu/int8), cuda, or cpu (default: auto)",
    )
    parser.add_argument(
        "--compute-type",
        dest="compute_type",
        default="",
        help="Optional faster-whisper compute_type (default: float16 on cuda, int8 on cpu)",
    )
    return parser.parse_args(argv)


def resolve_compute_type(device: str, requested_compute_type: str = "") -> str:
    cleaned = (requested_compute_type or "").strip()
    if cleaned:
        return cleaned
    return "float16" if device == "cuda" else "int8"


def load_whisper_model(model_name: str, device: str, compute_type: str = "", cpu_threads: int = 4):
    register_cuda_dll_dirs()
    silence_hf_unauthenticated_warning()
    from faster_whisper import WhisperModel

    requested_device = (device or "auto").strip().lower()
    if requested_device == "auto":
        cuda_compute = resolve_compute_type("cuda", compute_type)
        try:
            model = WhisperModel(
                model_name,
                device="cuda",
                compute_type=cuda_compute,
            )
            return model, "cuda", cuda_compute
        except Exception:
            sys.stderr.write("fallback-cpu\n")
            sys.stderr.flush()
            cpu_compute = "int8"
            model = WhisperModel(
                model_name,
                device="cpu",
                compute_type=cpu_compute,
                cpu_threads=cpu_threads,
            )
            return model, "cpu", cpu_compute

    active_compute = resolve_compute_type(requested_device, compute_type)
    if requested_device == "cuda":
        model = WhisperModel(
            model_name,
            device="cuda",
            compute_type=active_compute,
        )
        return model, "cuda", active_compute

    model = WhisperModel(
        model_name,
        device="cpu",
        compute_type=active_compute,
        cpu_threads=cpu_threads,
    )
    return model, "cpu", active_compute


def main(argv=None) -> int:
    args = parse_args(argv)
    if args.probe:
        device, compute = probe_device()
        emit_whisper_device(device, compute)
        return 0
    if not args.input_path or not args.output_path:
        sys.stderr.write("--in y --out son obligatorios.\n")
        return 2
    if not os.path.isfile(args.input_path):
        sys.stderr.write("Input audio file not found.\n")
        return 1

    cpu_threads = os.cpu_count() or 4
    model, active_device, active_compute = load_whisper_model(
        model_name=args.model,
        device=args.device,
        compute_type=args.compute_type,
        cpu_threads=cpu_threads,
    )
    emit_whisper_device(active_device, active_compute)

    segments_iter, info = model.transcribe(
        args.input_path,
        language=args.lang or "es",
        beam_size=5,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 300},
        condition_on_previous_text=False,
    )

    segments_out = []
    last_end = 0.0

    for idx, seg in enumerate(segments_iter):
        seg_start = round(max(0.0, float(seg.start)), 3)
        seg_end = round(max(seg_start, float(seg.end)), 3)
        if seg_end > last_end:
            last_end = seg_end

        words_out = []
        if seg.words:
            for w in seg.words:
                word_text = (w.word or "").strip()
                if not word_text:
                    continue
                w_start = round(max(0.0, float(w.start)), 3)
                w_end = round(max(w_start, float(w.end)), 3)
                if w_end > last_end:
                    last_end = w_end
                prob = round(float(getattr(w, "probability", 0.0) or 0.0), 4)
                words_out.append(
                    {
                        "start": w_start,
                        "end": w_end,
                        "text": word_text,
                        "prob": prob,
                    }
                )

        seg_text = (seg.text or "").strip()
        if not seg_text and words_out:
            seg_text = " ".join(w["text"] for w in words_out)

        segments_out.append(
            {
                "id": idx,
                "start": seg_start,
                "end": seg_end,
                "text": seg_text,
                "words": words_out,
            }
        )

    duration = round(float(getattr(info, "duration", 0.0) or last_end), 3)
    payload = {
        "duration": duration,
        "language": getattr(info, "language", None) or args.lang or "es",
        "segments": segments_out,
    }

    out_dir = os.path.dirname(os.path.abspath(args.output_path))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    with open(args.output_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
