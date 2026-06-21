#!/usr/bin/env bash
set -euo pipefail

PYTHON_BIN="${PYTHON_BIN:-python3.11}"
if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  PYTHON_BIN="${PYTHON_BIN_FALLBACK:-python3}"
fi
if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  echo "No usable Python found. Set PYTHON_BIN to Python 3.11+." >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${MICROBUBBLES_REPRO_VENV:-/tmp/microbubbles-repro-venv}"

rm -rf "${VENV_DIR}"
"${PYTHON_BIN}" -m venv "${VENV_DIR}"
"${VENV_DIR}/bin/python" -m pip install --upgrade pip setuptools wheel
"${VENV_DIR}/bin/python" -m pip install -c "${REPO_DIR}/requirements.lock" -e "${REPO_DIR}"

"${VENV_DIR}/bin/ultratrace-ulm" --help >/dev/null

"${VENV_DIR}/bin/python" - <<'PY'
from importlib import resources

from ultratrace_ulm.cli import build_parser

build_parser()
for package in [
    "ultratrace_ulm.web.svd_viewer",
    "ultratrace_ulm.web.volume_viewer",
]:
    root = resources.files(package)
    for name in ["index.html", "app.js", "styles.css"]:
        path = root / name
        if not path.is_file():
            raise SystemExit(f"missing web asset: {package}/{name}")
print("standalone package check passed")
PY

"${VENV_DIR}/bin/ultratrace-ulm" doctor
