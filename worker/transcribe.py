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
import json
import os
import sys


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe audio WAV with faster-whisper")
    parser.add_argument("--in", dest="input_path", required=True, help="Input 16kHz mono WAV path")
    parser.add_argument("--out", dest="output_path", required=True, help="Output JSON path")
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
    if not os.path.isfile(args.input_path):
        sys.stderr.write("Input audio file not found.\n")
        return 1

    cpu_threads = os.cpu_count() or 4
    model, _active_device, _active_compute = load_whisper_model(
        model_name=args.model,
        device=args.device,
        compute_type=args.compute_type,
        cpu_threads=cpu_threads,
    )

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
