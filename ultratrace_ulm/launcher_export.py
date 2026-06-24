"""Write a static landing page that links several viewer bundles.

The launcher is a tiny self-contained ``index.html`` that reads a sibling
``viewers.json`` and renders one card per viewer. It lets a single served
directory expose the volume, track-flow, and movie viewers behind one link.
"""
from __future__ import annotations

import json
import shutil
from importlib import resources
from pathlib import Path


def parse_viewer_spec(spec: str) -> dict:
    """Parse a ``HREF|TITLE|DESCRIPTION|EMOJI`` CLI spec into a viewer dict.

    Only the href is required; the remaining fields are optional and default
    to sensible values (title falls back to the last href path segment).
    """
    parts = [p.strip() for p in spec.split("|")]
    href = parts[0]
    title = parts[1] if len(parts) > 1 and parts[1] else href.rstrip("/").split("/")[-1] or href
    description = parts[2] if len(parts) > 2 else ""
    emoji = parts[3] if len(parts) > 3 else ""
    return {"href": href, "title": title, "description": description, "emoji": emoji}


def write_launcher(
    output_dir: Path,
    title: str = "Ultratrace ULM Viewers",
    subtitle: str = "",
    footer: str = "",
    viewers: list[dict] | None = None,
) -> Path:
    """Write ``index.html`` + ``viewers.json`` into ``output_dir``."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    config = {
        "title": title,
        "subtitle": subtitle,
        "footer": footer,
        "viewers": list(viewers or []),
    }
    (output_dir / "viewers.json").write_text(json.dumps(config, indent=2))
    asset_root = resources.files("ultratrace_ulm.web.launcher")
    with resources.as_file(asset_root / "index.html") as src:
        shutil.copyfile(src, output_dir / "index.html")
    n_viewers = len(config["viewers"])
    print(f"Wrote viewer launcher ({n_viewers} viewers) to {output_dir}")
    return output_dir / "index.html"
