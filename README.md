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

## Sample data

A sanitized neutral ultratrace — demodulated IQ plus transmit delays and a
beamforming-only config (no raw frames, no device metadata) — is hosted on
Cloudflare R2 (~98 GB, 223 acquisitions):

```bash
curl -O https://pub-9c1be6312b2441eb8732660783d9ee81.r2.dev/sanitized_neutral_ultratrace.h5
```

Feed it straight into `beamform` below.

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

## License

[MIT](LICENSE) — © 2026 Aleph Neuro.

## Combined Viewer Launcher

Serve several viewer bundles behind one link. After exporting the `volume`,
`track-viewer`, and `movie` bundles into a shared directory, write a landing
page that links them:

```bash
ultratrace-ulm launcher \
  --output-dir outputs/viewer \
  --title "Ultratrace ULM" \
  --subtitle "feb10 15:35 - adaptive SVD" \
  --viewer "volume/|3D SVD Volume Viewer|Rotatable super-resolution volume.|ð§" \
  --viewer "tracks3d/|3D Track-Flow Viewer|Animated point-flow of tracks.|â¨" \
  --viewer "movie/|SVD B-mode Movie Viewer|SVD b-mode movie with overlay.|ðï¸"
```

This writes `index.html` + `viewers.json`; serve the directory with any static
server. Each `--viewer` is `HREF|TITLE|DESCRIPTION|EMOJI` (only the href is
required) and may be repeated.

## Recommended Tracking Recipe (read before using --temporal-sigma)

For non-stationary microbubble tracks, prefer **adaptive SVD with
`--temporal-sigma 0`** over the temporal-blur recipe above:

```bash
ultratrace-ulm run \
  --beamformed /path/to/beamformed.h5 --tracks outputs/tracks.pkl \
  --svd-method adaptive --frame-rate <Hz> --knee-filter \
  --temporal-sigma 0 --sigma-threshold 2.0 --svd-low-cutoff 0.1 \
  --min-distance 2 --smoothing-sigma 1.0 --tracking kalman \
  --max-gap 3 --min-track-length 5 --max-cost 10
```

A large `--temporal-sigma` (e.g. 7) combined with the `fast` SVD variant tends
to track stationary tissue/clutter: it yields many more tracks per acquisition
that barely move. Adaptive SVD with no temporal blur matches the production
reference (~260 tracks/acquisition, genuinely flowing).
