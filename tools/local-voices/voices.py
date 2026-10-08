"""Local speaker-embedding check (no network, no API calls).

  python voices.py embed   [wespeaker|titanet]   embed every clip listed in out/segments.json
  python voices.py compare [wespeaker|titanet]   cosine similarity within and across meetings

Run from this folder with the venv:  .venv/Scripts/python.exe voices.py embed wespeaker
"""
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).parent
OUT = HERE / "out"
MODELS = {
    "wespeaker": HERE / "models" / "wespeaker_en_voxceleb_resnet34_LM.onnx",
    "titanet": HERE / "models" / "nemo_en_titanet_small.onnx",
}


def unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / (np.linalg.norm(v, axis=-1, keepdims=True) + 1e-12)


def embed(model):
    import sherpa_onnx

    cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=str(MODELS[model]), num_threads=2, debug=False, provider="cpu"
    )
    if not cfg.validate():
        raise SystemExit("bad model config")
    ext = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)
    data = json.loads((OUT / "segments.json").read_text(encoding="utf8"))
    arrays = {}
    for name, m in data["meetings"].items():
        with sf.SoundFile(m["flac"]) as f:
            sr = f.samplerate
            for diar, v in m["voices"].items():
                embs = []
                for seg in v["segments"]:
                    f.seek(int(seg["start"] * sr))
                    x = f.read(int((seg["end"] - seg["start"]) * sr), dtype="float32")
                    if x.ndim > 1:
                        x = x.mean(axis=1)
                    if len(x) < sr:  # under one second
                        continue
                    s = ext.create_stream()
                    s.accept_waveform(sample_rate=sr, waveform=x)
                    s.input_finished()
                    embs.append(ext.compute(s))
                arrays[f"{name}|{diar}"] = np.array(embs, dtype=np.float32)
                print(f"{model} {name} {v['label']}: {len(embs)} clips", flush=True)
    np.savez(OUT / f"emb_{model}.npz", **arrays)
    print("saved", OUT / f"emb_{model}.npz")


def compare(model):
    data = json.loads((OUT / "segments.json").read_text(encoding="utf8"))
    emb = np.load(OUT / f"emb_{model}.npz")
    voices = []  # (key, meeting, label, person, centroid, n, consistency)
    for name, m in data["meetings"].items():
        for diar, v in m["voices"].items():
            key = f"{name}|{diar}"
            e = emb[key] if key in emb else np.zeros((0, 1))
            if len(e) == 0:
                continue
            u = unit(e)
            c = unit(u.mean(axis=0))
            cons = float((u @ c).mean())
            voices.append((key, name, v["label"], v.get("personId"), c, len(e), cons, v["sec"], v.get("person")))
    print(f"\n== {model}: {len(voices)} voices; clip-to-own-centroid cosine (how tight each voice is)")
    for k, name, label, pid, c, n, cons, sec, person in voices:
        print(f"  {name:8s} {label:10s} {sec:5d}s  clips {n:2d}  tightness {cons:.2f}")

    def sim(a, b):
        return float(a[4] @ b[4])

    print("\n-- two voices inside ONE meeting (high = maybe the same person split in two)")
    rows = []
    for i, a in enumerate(voices):
        for b in voices[i + 1:]:
            if a[1] == b[1]:
                rows.append((sim(a, b), a, b))
    for s, a, b in sorted(rows, key=lambda r: -r[0])[:8]:
        print(f"  {s:.2f}  {a[1]} {a[2]} ({a[7]}s) vs {b[2]} ({b[7]}s)")

    print("\n-- across meetings: every pair, best first (pyannote's person link marked)")
    rows = []
    for i, a in enumerate(voices):
        for b in voices[i + 1:]:
            if a[1] != b[1]:
                linked = bool(a[3]) and a[3] == b[3]
                rows.append((sim(a, b), linked, a, b))
    rows.sort(key=lambda r: -r[0])
    for s, linked, a, b in rows[:14]:
        print(f"  {s:.2f} {'LINKED by pyannote' if linked else '                  '} {a[1]} {a[2]} ({a[7]}s) ~ {b[1]} {b[2]} ({b[7]}s)")
    lk = [r[0] for r in rows if r[1]]
    nl = [r[0] for r in rows if not r[1]]
    print(f"\n  pyannote-linked pairs: {len(lk)}, cosine {', '.join(f'{x:.2f}' for x in sorted(lk, reverse=True))}")
    print(f"  all other cross-meeting pairs: {len(nl)}, max {max(nl):.2f}, 95th percentile {np.percentile(nl, 95):.2f}, median {np.median(nl):.2f}")


if __name__ == "__main__":
    cmd = sys.argv[1]
    model = sys.argv[2] if len(sys.argv) > 2 else "wespeaker"
    {"embed": embed, "compare": compare}[cmd](model)
