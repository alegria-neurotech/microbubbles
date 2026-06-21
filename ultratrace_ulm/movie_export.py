from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from importlib import resources
from pathlib import Path

import numpy as np
from scipy.ndimage import zoom

from .h5_io import acq_keys, axis_bounds, grid_arrays, load_compound, open_h5, select_acquisitions
from .runtime import load_pickle
from .svd import filtered_magnitude


@dataclass(frozen=True)
class MovieExportOptions:
    beamformed_path: Path
    output_dir: Path
    tracks_path: Path | None = None
    acq_start: int = 0
    num_acqs: int = 1
    acq_step: int = 1
    svd_low_cutoff: float = 0.1
    svd_high_cutoff: float | None = None
    svd_method: str = "fast"
    temporal_sigma: float = 0.0
    projection: str = "xz-mip"
    elev_index: int | None = None
    elev_slabs: int = 6
    slab_cols: int = 1
    slab_gap_px: int = 3
    physical_aspect: bool = False
    dynamic_range_db: float = 15.0
    percentile: float = 99.7
    fps: float = 30.0
    track_min_length: int = 5
    prefer_smoothed_tracks: bool = True
    tail_frames: int = 18
    max_frames: int | None = None


def _filter_svd(compound: np.ndarray, opts: MovieExportOptions) -> np.ndarray:
    return filtered_magnitude(
        compound,
        low_cutoff=opts.svd_low_cutoff,
        high_cutoff=opts.svd_high_cutoff,
        method=opts.svd_method,
        temporal_sigma=opts.temporal_sigma,
    )


def _xz_physical_aspect(
    grid_x: np.ndarray | None,
    grid_z: np.ndarray | None,
) -> float | None:
    if grid_x is None or grid_z is None:
        return None
    x_span = float(np.nanmax(grid_x) - np.nanmin(grid_x))
    z_span = float(np.nanmax(grid_z) - np.nanmin(grid_z))
    if not np.isfinite(x_span) or not np.isfinite(z_span) or x_span <= 0 or z_span <= 0:
        return None
    return x_span / z_span


def _resize_z_for_aspect(frames: np.ndarray, aspect: float | None) -> np.ndarray:
    if aspect is None or aspect <= 0:
        return frames
    target_height = max(1, int(round(frames.shape[2] / aspect)))
    if target_height == frames.shape[1]:
        return frames
    scale = target_height / frames.shape[1]
    resized = zoom(frames, (1.0, scale, 1.0), order=1)
    return resized.astype(frames.dtype, copy=False)


def _project(
    volume: np.ndarray,
    opts: MovieExportOptions,
    grid_x: np.ndarray | None = None,
    grid_y: np.ndarray | None = None,
    grid_z: np.ndarray | None = None,
) -> tuple[np.ndarray, dict]:
    aspect = _xz_physical_aspect(grid_x, grid_z) if opts.physical_aspect else None
    if opts.projection == "xz-mip":
        projected = _resize_z_for_aspect(volume.max(axis=1), aspect)
        return projected, {"physical_aspect": aspect} if aspect else {}
    if opts.projection == "xz-mean":
        projected = _resize_z_for_aspect(volume.mean(axis=1), aspect)
        return projected, {"physical_aspect": aspect} if aspect else {}
    if opts.projection == "xz-plane":
        elev = volume.shape[1] // 2 if opts.elev_index is None else opts.elev_index
        projected = _resize_z_for_aspect(volume[:, int(elev)], aspect)
        meta = {"elev_index": int(elev)}
        if aspect:
            meta["physical_aspect"] = aspect
        return projected, meta
    if opts.projection == "xz-slab-mip":
        elev_count = int(volume.shape[1])
        slab_count = min(max(1, int(opts.elev_slabs)), elev_count)
        slab_cols = min(max(1, int(opts.slab_cols)), slab_count)
        slab_rows = int(np.ceil(slab_count / slab_cols))
        edges = np.linspace(0, elev_count, slab_count + 1, dtype=int)
        gap = max(0, int(opts.slab_gap_px))
        slabs = []
        projected_slabs = []
        for slab_id, (start, stop) in enumerate(zip(edges[:-1], edges[1:], strict=True)):
            stop = max(stop, start + 1)
            slab = volume[:, start:stop].max(axis=1)
            slab = _resize_z_for_aspect(slab, aspect)
            projected_slabs.append(slab)
            if grid_y is not None:
                y_region = grid_y[start:stop]
                y_min = float(np.nanmin(y_region))
                y_max = float(np.nanmax(y_region))
            else:
                y_min = float(start)
                y_max = float(stop - 1)
            slab_h = int(slab.shape[1])
            slab_w = int(slab.shape[2])
            row_index = slab_id // slab_cols
            col_index = slab_id % slab_cols
            row_start = row_index * (slab_h + gap)
            col_start = col_index * (slab_w + gap)
            slabs.append(
                {
                    "id": int(slab_id),
                    "start_index": int(start),
                    "stop_index": int(stop),
                    "y_min_mm": y_min,
                    "y_max_mm": y_max,
                    "row_start": int(row_start),
                    "col_start": int(col_start),
                    "height": slab_h,
                    "width": slab_w,
                    "row_index": int(row_index),
                    "col_index": int(col_index),
                }
            )
        slab_h = int(projected_slabs[0].shape[1])
        slab_w = int(projected_slabs[0].shape[2])
        out_h = slab_rows * slab_h + gap * (slab_rows - 1)
        out_w = slab_cols * slab_w + gap * (slab_cols - 1)
        canvas = np.zeros((volume.shape[0], out_h, out_w), dtype=volume.dtype)
        for slab, info in zip(projected_slabs, slabs, strict=True):
            row_start = int(info["row_start"])
            col_start = int(info["col_start"])
            canvas[
                :,
                row_start : row_start + int(info["height"]),
                col_start : col_start + int(info["width"]),
            ] = slab
        return canvas, {
            "elev_slabs": slabs,
            "slab_cols": int(slab_cols),
            "slab_rows": int(slab_rows),
            "slab_gap_px": gap,
            "physical_aspect": aspect,
        }
    raise ValueError(f"Unsupported projection: {opts.projection}")


def _encode_uint8(frames: np.ndarray, opts: MovieExportOptions) -> tuple[np.ndarray, dict]:
    scale = float(np.percentile(frames, opts.percentile))
    scale = max(scale, np.finfo(np.float32).eps)
    db = 20.0 * np.log10(np.maximum(frames, np.finfo(np.float32).eps) / scale)
    db = np.clip(db, -opts.dynamic_range_db, 0.0)
    encoded = ((db + opts.dynamic_range_db) / opts.dynamic_range_db * 255.0)
    return encoded.astype(np.uint8), {
        "scale_percentile": opts.percentile,
        "scale_value": scale,
        "dynamic_range_db": opts.dynamic_range_db,
    }


def _axis_bounds(grid_x: np.ndarray, grid_y: np.ndarray, grid_z: np.ndarray) -> dict:
    return axis_bounds(grid_x, grid_y, grid_z)


def _tracks_payload(
    tracks_path: Path | None,
    acq_ids: list[int],
    frames_per_acq: int,
    opts: MovieExportOptions,
) -> dict:
    if tracks_path is None:
        return {"tracks": []}
    data = load_pickle(tracks_path)
    key = "tracks_smoothed" if opts.prefer_smoothed_tracks and "tracks_smoothed" in data else "tracks"
    tracks = []
    selected_tracks = data.get("params", {}).get("selected_acq_ids")
    if selected_tracks == [int(v) for v in acq_ids]:
        frame_min = 0
        frame_max = len(acq_ids) * frames_per_acq
    else:
        frame_min = acq_ids[0] * frames_per_acq
        frame_max = (acq_ids[-1] + 1) * frames_per_acq
    for track_id, track in enumerate(data.get(key, [])):
        length = int(track.get("length", len(track.get("positions", []))))
        if length < opts.track_min_length:
            continue
        frames = np.asarray(track["frames"], dtype=np.float32)
        positions = np.asarray(track["positions"], dtype=np.float32)
        mask = (frames >= frame_min) & (frames < frame_max)
        if int(mask.sum()) < opts.track_min_length:
            continue
        local_frames = frames[mask] - frame_min
        pos = positions[mask]
        tracks.append(
            {
                "id": int(track.get("id", track_id)),
                "frames": np.round(local_frames, 3).tolist(),
                "x": np.round(pos[:, 0], 4).tolist(),
                "y": np.round(pos[:, 1], 4).tolist(),
                "z": np.round(pos[:, 2], 4).tolist(),
            }
        )
    payload = {
        "source": tracks_path.name,
        "track_key": key,
        "track_min_length": opts.track_min_length,
        "frame_offset": int(frame_min),
        "frames_per_acq": int(frames_per_acq),
        "tracks": tracks,
    }
    return payload


def _export_tracks(
    tracks_path: Path | None,
    output_dir: Path,
    acq_ids: list[int],
    frames_per_acq: int,
    opts: MovieExportOptions,
) -> None:
    payload = _tracks_payload(tracks_path, acq_ids, frames_per_acq, opts)
    (output_dir / "tracks.json").write_text(json.dumps(payload) + "\n")


def _copy_web_assets(output_dir: Path) -> None:
    asset_root = resources.files("ultratrace_ulm.web.svd_viewer")
    for name in ["index.html", "app.js", "styles.css"]:
        with resources.as_file(asset_root / name) as src:
            shutil.copyfile(src, output_dir / name)


def build_encoded_movie(
    opts: MovieExportOptions,
) -> tuple[np.ndarray, dict, list[int], int]:
    with open_h5(opts.beamformed_path) as h5:
        selected = select_acquisitions(acq_keys(h5), opts.acq_start, opts.num_acqs, opts.acq_step)
        grid_x, grid_y, grid_z = grid_arrays(h5, selected[0])
        frames = []
        frames_per_acq = None
        for acq_id in selected:
            compound = load_compound(h5, acq_id)
            if frames_per_acq is None:
                frames_per_acq = int(compound.shape[0])
            filtered = _filter_svd(compound, opts)
            projected, projection_meta = _project(filtered, opts, grid_x, grid_y, grid_z)
            frames.append(projected)
    movie = np.concatenate(frames, axis=0)
    if opts.max_frames is not None:
        movie = movie[: opts.max_frames]
    encoded, display = _encode_uint8(movie, opts)

    raw_path = opts.output_dir / "movie.raw"
    encoded.tofile(raw_path)
    meta = {
        "source": opts.beamformed_path.name,
        "movie_raw": "movie.raw",
        "tracks": "tracks.json",
        "dtype": "uint8",
        "width": int(encoded.shape[2]),
        "height": int(encoded.shape[1]),
        "frames": int(encoded.shape[0]),
        "fps": float(opts.fps),
        "projection": opts.projection,
        "projection_meta": projection_meta,
        "tail_frames": int(opts.tail_frames),
        "acq_ids": [int(v) for v in selected],
        "frames_per_acq": int(frames_per_acq or 0),
        "bounds_mm": axis_bounds(grid_x, grid_y, grid_z),
        "display": display,
        "svd": {
            "low_cutoff": opts.svd_low_cutoff,
            "high_cutoff": opts.svd_high_cutoff,
            "temporal_sigma": opts.temporal_sigma,
        },
    }
    return encoded, meta, [int(v) for v in selected], int(frames_per_acq or 0)


def export_svd_movie(opts: MovieExportOptions) -> Path:
    opts.output_dir.mkdir(parents=True, exist_ok=True)
    encoded, meta, selected, frames_per_acq = build_encoded_movie(opts)

    (opts.output_dir / "movie.json").write_text(json.dumps(meta, indent=2) + "\n")
    _export_tracks(opts.tracks_path, opts.output_dir, selected, frames_per_acq, opts)
    _copy_web_assets(opts.output_dir)
    print(f"Wrote SVD movie viewer bundle to {opts.output_dir}")
    return opts.output_dir / "index.html"


def make_options(args) -> MovieExportOptions:
    return MovieExportOptions(
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
        dynamic_range_db=args.dynamic_range_db,
        percentile=args.percentile,
        fps=args.fps,
        track_min_length=args.track_min_length,
        tail_frames=args.tail_frames,
        max_frames=args.max_frames,
    )
