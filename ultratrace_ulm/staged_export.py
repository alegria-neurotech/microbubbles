from __future__ import annotations

import json
import shutil
from dataclasses import dataclass, replace
from importlib import resources
from pathlib import Path

import numpy as np

from .h5_io import acq_keys, axis_bounds, grid_arrays, load_compound, open_h5, select_acquisitions
from .movie_export import (
    MovieExportOptions,
    _encode_uint8,
    _filter_svd,
    _project,
    _tracks_payload,
)


@dataclass(frozen=True)
class StagedMovieOptions:
    movie: MovieExportOptions
    raw_dynamic_range_db: float = 45.0
    filtered_dynamic_range_db: float = 15.0
    detect_dynamic_range_db: float = 10.0


def _encode_layer(frames: np.ndarray, opts: MovieExportOptions, dynamic_range_db: float) -> tuple[np.ndarray, dict]:
    return _encode_uint8(frames, replace(opts, dynamic_range_db=dynamic_range_db))


def _copy_web_assets(output_dir: Path) -> None:
    asset_root = resources.files("ultratrace_ulm.web.staged_viewer")
    for name in ["index.html", "app.js", "styles.css"]:
        with resources.as_file(asset_root / name) as src:
            shutil.copyfile(src, output_dir / name)


def _trim_tracks_payload(payload: dict, max_frames: int | None, min_length: int) -> dict:
    if max_frames is None:
        return payload
    tracks = []
    for track in payload.get("tracks", []):
        frames = np.asarray(track.get("frames", []), dtype=np.float32)
        keep = frames < int(max_frames)
        if int(keep.sum()) < int(min_length):
            continue
        out = dict(track)
        for key in ["frames", "x", "y", "z"]:
            values = np.asarray(track.get(key, []))
            out[key] = values[keep].tolist()
        tracks.append(out)
    payload = dict(payload)
    payload["tracks"] = tracks
    payload["max_frames"] = int(max_frames)
    return payload


def build_staged_movie(opts: StagedMovieOptions) -> tuple[dict, dict]:
    movie_opts = opts.movie
    with open_h5(movie_opts.beamformed_path) as h5:
        selected = select_acquisitions(
            acq_keys(h5),
            movie_opts.acq_start,
            movie_opts.num_acqs,
            movie_opts.acq_step,
        )
        grid_x, grid_y, grid_z = grid_arrays(h5, selected[0])
        raw_frames = []
        filtered_frames = []
        frames_per_acq = None
        projection_meta = {}
        for acq_id in selected:
            compound = load_compound(h5, acq_id)
            if frames_per_acq is None:
                frames_per_acq = int(compound.shape[0])
            raw = np.abs(compound).astype(np.float32, copy=False)
            raw_projected, projection_meta = _project(raw, movie_opts, grid_x, grid_y, grid_z)
            filtered = _filter_svd(compound, movie_opts)
            filtered_projected, projection_meta = _project(filtered, movie_opts, grid_x, grid_y, grid_z)
            raw_frames.append(raw_projected)
            filtered_frames.append(filtered_projected)

    raw_movie = np.concatenate(raw_frames, axis=0)
    filtered_movie = np.concatenate(filtered_frames, axis=0)
    if movie_opts.max_frames is not None:
        raw_movie = raw_movie[: movie_opts.max_frames]
        filtered_movie = filtered_movie[: movie_opts.max_frames]

    raw_encoded, raw_display = _encode_layer(raw_movie, movie_opts, opts.raw_dynamic_range_db)
    filtered_encoded, filtered_display = _encode_layer(
        filtered_movie, movie_opts, opts.filtered_dynamic_range_db
    )
    detect_encoded, detect_display = _encode_layer(
        filtered_movie, movie_opts, opts.detect_dynamic_range_db
    )

    meta = {
        "source": movie_opts.beamformed_path.name,
        "dtype": "uint8",
        "width": int(raw_encoded.shape[2]),
        "height": int(raw_encoded.shape[1]),
        "frames": int(raw_encoded.shape[0]),
        "fps": float(movie_opts.fps),
        "projection": movie_opts.projection,
        "projection_meta": projection_meta,
        "acq_ids": [int(v) for v in selected],
        "frames_per_acq": int(frames_per_acq or 0),
        "bounds_mm": axis_bounds(grid_x, grid_y, grid_z),
        "layers": {
            "raw": {"file": "raw.raw", "display": raw_display},
            "filtered": {"file": "filtered.raw", "display": filtered_display},
            "detect": {"file": "detect.raw", "display": detect_display},
        },
        "tracks": "tracks.json",
        "svd": {
            "low_cutoff": movie_opts.svd_low_cutoff,
            "high_cutoff": movie_opts.svd_high_cutoff,
            "temporal_sigma": movie_opts.temporal_sigma,
        },
    }
    tracks = _tracks_payload(movie_opts.tracks_path, [int(v) for v in selected], int(frames_per_acq or 0), movie_opts)
    tracks = _trim_tracks_payload(tracks, movie_opts.max_frames, movie_opts.track_min_length)
    return meta, {
        "raw.raw": raw_encoded,
        "filtered.raw": filtered_encoded,
        "detect.raw": detect_encoded,
        "tracks.json": tracks,
    }


def export_staged_movie(opts: StagedMovieOptions) -> Path:
    output_dir = opts.movie.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    meta, payload = build_staged_movie(opts)
    for filename, data in payload.items():
        path = output_dir / filename
        if isinstance(data, np.ndarray):
            data.tofile(path)
        else:
            path.write_text(json.dumps(data) + "\n")
    (output_dir / "staged_movie.json").write_text(json.dumps(meta, indent=2) + "\n")
    _copy_web_assets(output_dir)
    print(f"Wrote staged movie viewer bundle to {output_dir}")
    return output_dir / "index.html"


def make_options(args) -> StagedMovieOptions:
    movie = MovieExportOptions(
        beamformed_path=Path(args.beamformed).expanduser().resolve(),
        tracks_path=Path(args.tracks).expanduser().resolve() if args.tracks else None,
        output_dir=Path(args.output_dir).expanduser().resolve(),
        acq_start=args.acq_start,
        num_acqs=args.num_acqs,
        acq_step=args.acq_step,
        svd_low_cutoff=args.svd_low_cutoff,
        svd_high_cutoff=args.svd_high_cutoff,
        svd_method=args.svd_method,
        temporal_sigma=args.temporal_sigma,
        projection=args.projection,
        elev_index=args.elev_index,
        elev_slabs=args.elev_slabs,
        slab_cols=args.slab_cols,
        slab_gap_px=args.slab_gap_px,
        physical_aspect=args.physical_aspect,
        percentile=args.percentile,
        fps=args.fps,
        track_min_length=args.track_min_length,
        max_frames=args.max_frames,
    )
    return StagedMovieOptions(
        movie=movie,
        raw_dynamic_range_db=args.raw_dynamic_range_db,
        filtered_dynamic_range_db=args.filtered_dynamic_range_db,
        detect_dynamic_range_db=args.detect_dynamic_range_db,
    )
