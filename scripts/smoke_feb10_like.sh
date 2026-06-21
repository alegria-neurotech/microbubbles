#!/usr/bin/env bash
set -euo pipefail

PYTHON="${PYTHON:-python3}"
BEAMFORMED="${1:?usage: smoke_feb10_like.sh /path/to/beamformed_ultratrace.h5 /path/to/output_dir}"
OUTDIR="${2:?usage: smoke_feb10_like.sh /path/to/beamformed_ultratrace.h5 /path/to/output_dir}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "${OUTDIR}"
export PYTHONPATH="${REPO_DIR}:${PYTHONPATH:-}"

"${PYTHON}" -m ultratrace_ulm.cli run \
  --beamformed "${BEAMFORMED}" \
  --tracks "${OUTDIR}/smoke_tracks.pkl" \
  --export-dir "${OUTDIR}/tracks" \
  --export-stem smoke_tracks \
  --num-acqs 1 \
  --svd-low-cutoff 0.1 \
  --temporal-sigma 7 \
  --sigma-threshold 2.0

"${PYTHON}" -m ultratrace_ulm.cli movie \
  --beamformed "${BEAMFORMED}" \
  --tracks "${OUTDIR}/smoke_tracks_smoothed.pkl" \
  --output-dir "${OUTDIR}/movie" \
  --num-acqs 1 \
  --projection xz-slab-mip \
  --elev-slabs 6 \
  --dynamic-range-db 15 \
  --temporal-sigma 7
