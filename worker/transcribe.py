#!/usr/bin/env python3
"""
AutoCut Drive AI — Speech Transcription CLI (faster-whisper on CPU int8)

Usage:
  python worker/transcribe.py --in audio.wav --out transcript.json --model small --lang es

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
from faster_whisper import WhisperModel


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe audio WAV with faster-whisper")
    parser.add_argument("--in", dest="input_path", required=True, help="Input 16kHz mono WAV path")
    parser.add_argument("--out", dest="output_path", required=True, help="Output JSON path")
    parser.add_argument("--model", dest="model", default="small", help="Whisper model size (small/medium)")
    parser.add_argument("--lang", dest="lang", default="es", help="Language code (default: es)")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not os.path.isfile(args.input_path):
        sys.stderr.write("Input audio file not found.\n")
        return 1

    cpu_threads = os.cpu_count() or 4
    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
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
