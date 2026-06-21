# Reproducibility

This repository is reproducible as a standalone ULM package for beamformed
ultratrace H5 files. It does not require an external checkout, a separate venv,
or runtime path injection.

## Clean Install Check

Use Python 3.11 for the pinned check:

```bash
python3.11 -m venv /tmp/microbubbles-repro
/tmp/microbubbles-repro/bin/python -m pip install --upgrade pip setuptools wheel
/tmp/microbubbles-repro/bin/python -m pip install -c requirements.lock -e .
/tmp/microbubbles-repro/bin/ultratrace-ulm doctor
/tmp/microbubbles-repro/bin/ultratrace-ulm --help
```

The helper script runs the same check and validates bundled web assets:

```bash
scripts/check_repro.sh
```

## Runtime Inputs

End-to-end tracking and viewer generation require:

- A beamformed ultratrace HDF5 file.
- `compound_image` under each selected acquisition.
- Saved `x`, `y`, and `z` grid arrays under the selected acquisition metadata.

Example:

```bash
ultratrace-ulm run \
  --beamformed /path/to/beamformed_ultratrace.h5 \
  --tracks outputs/tracks.pkl \
  --export-dir outputs/viewer \
  --num-acqs 10 \
  --svd-low-cutoff 0.1 \
  --temporal-sigma 7 \
  --sigma-threshold 2.0
```

## Guardrails

- Runtime paths are not passed by CLI or environment variables.
- MACH beamforming reproduces from a neutral demodulated-IQ ultratrace
  (IQ plus transmit-delay and geometry metadata) via the optional `mach` GPU
  kernel. It does not decode vendor raw frames.
