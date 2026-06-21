# Ultratrace ULM

A standalone microbubble **ULM** (ultrasound localization microscopy) pipeline:
beamforming, SVD clutter filtering, 3D bubble detection and localization,
Kalman track linking, and interactive browser viewers — packaged as a
self-contained Python package with no external acquisition stack.

Built by [Aleph Neuro](https://alephneuro.com).

## Pipeline

1. **Beamform** a neutral demodulated-IQ ultratrace into a beamformed H5
   (`acquisitions/<id>/meta/compound_image` plus a saved imaging grid), using
   the optional `mach` GPU kernel. No vendor raw-frame decoding.
2. **Track** — temporal SVD clutter filtering → 3D detection and sub-voxel
   localization → Kalman + Hungarian track linking → smoothing.
3. **View** — export compact binary tracks for the animated 3D track viewer,
   or render SVD b-mode movie and rotatable 3D volume viewers.

## Install

```bash
python3.11 -m venv .venv
.venv/bin/pip install -e .             # core: tracking + viewers
.venv/bin/pip install -e ".[mach]"     # + GPU MACH beamforming (CUDA)
```

## Beamform (optional, GPU)

```bash
ultratrace-ulm beamform \
  --input neutral_ultratrace.h5 \
  --output beamformed.h5 \
  --spatial-tgc
```

## Track

```bash
ultratrace-ulm track \
  --beamformed beamformed.h5 \
  --tracks outputs/tracks.pkl \
  --svd-method adaptive --frame-rate 222 \
  --sigma-threshold 2.0 --subpixel centroid \
  --tracking kalman --min-track-length 5
```

This writes `outputs/tracks.pkl` and a smoothed `outputs/tracks_smoothed.pkl`.

## 3D track viewer

```bash
ultratrace-ulm track-viewer \
  --tracks outputs/tracks_smoothed.pkl \
  --output-dir outputs/viewer \
  --min-length 35 --beamformed beamformed.h5
cd outputs/viewer && python3 -m http.server 8080
```

## SVD movie / volume viewers

```bash
ultratrace-ulm movie  --beamformed beamformed.h5 --tracks outputs/tracks_smoothed.pkl --output-dir outputs/movie
ultratrace-ulm volume --beamformed beamformed.h5 --tracks outputs/tracks_smoothed.pkl --output-dir outputs/volume
```

Serve any viewer directory with a static file server (`python3 -m http.server`).

## Reproducibility

`scripts/check_repro.sh` builds a fresh virtualenv, installs only this
repository, and validates the runtime and bundled web assets. See
[`REPRODUCIBILITY.md`](REPRODUCIBILITY.md).

## License

[MIT](LICENSE) — © 2026 Aleph Neuro.
