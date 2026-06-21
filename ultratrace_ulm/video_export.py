from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .movie_export import MovieExportOptions, _tracks_payload, build_encoded_movie


@dataclass(frozen=True)
class MovieVideoOptions:
    movie: MovieExportOptions
    video_path: Path
    ffmpeg: str = "ffmpeg"
    point_radius: float = 2.4
    fps: float | None = None
    crf: int = 18
    preset: str = "medium"


def _x_to_px(x_mm: float, slab: dict, meta: dict) -> float:
    lo, hi = meta["bounds_mm"]["x"]
    width = int(slab.get("width", meta["width"]))
    col_start = int(slab.get("col_start", 0))
    return col_start + ((x_mm - lo) / (hi - lo)) * (width - 1)


def _z_to_px(z_mm: float, slab: dict, meta: dict) -> float:
    lo, hi = meta["bounds_mm"]["z"]
    return slab["row_start"] + ((z_mm - lo) / (hi - lo)) * (slab["height"] - 1)


def _is_y_in_slab(y_mm: float, slab: dict) -> bool:
    lo = min(float(slab["y_min_mm"]), float(slab["y_max_mm"]))
    hi = max(float(slab["y_min_mm"]), float(slab["y_max_mm"]))
    return lo <= float(y_mm) <= hi


def _draw_disk(
    frame: np.ndarray,
    x_px: float,
    y_px: float,
    radius: float,
    color: tuple[int, int, int],
) -> None:
    h, w, _ = frame.shape
    x0 = max(0, int(np.floor(x_px - radius - 1)))
    x1 = min(w, int(np.ceil(x_px + radius + 2)))
    y0 = max(0, int(np.floor(y_px - radius - 1)))
    y1 = min(h, int(np.ceil(y_px + radius + 2)))
    if x0 >= x1 or y0 >= y1:
        return
    yy, xx = np.ogrid[y0:y1, x0:x1]
    dist2 = (xx - x_px) ** 2 + (yy - y_px) ** 2
    mask = dist2 <= radius**2
    frame[y0:y1, x0:x1][mask] = color


def _draw_points(
    rgb: np.ndarray,
    tracks: list[dict],
    frame_idx: int,
    meta: dict,
    radius: float,
) -> None:
    slabs = meta.get("projection_meta", {}).get("elev_slabs") or [
        {
            "row_start": 0,
            "col_start": 0,
            "height": meta["height"],
            "width": meta["width"],
            "y_min_mm": meta["bounds_mm"]["y"][0],
            "y_max_mm": meta["bounds_mm"]["y"][1],
        }
    ]
    yellow = (255, 230, 70)
    for track in tracks:
        frames = np.asarray(track["frames"], dtype=np.float32)
        if len(frames) == 0:
            continue
        last = int(np.searchsorted(frames, frame_idx, side="right") - 1)
        if last < 0 or abs(float(frames[last]) - frame_idx) >= 1.5:
            continue
        y_mm = float(track["y"][last])
        for slab in slabs:
            if not _is_y_in_slab(y_mm, slab):
                continue
            x_px = _x_to_px(float(track["x"][last]), slab, meta)
            y_px = _z_to_px(float(track["z"][last]), slab, meta)
            _draw_disk(rgb, x_px, y_px, radius, yellow)


def _pad_even(frame: np.ndarray) -> np.ndarray:
    h, w, _ = frame.shape
    pad_h = h % 2
    pad_w = w % 2
    if not pad_h and not pad_w:
        return frame
    return np.pad(frame, ((0, pad_h), (0, pad_w), (0, 0)), mode="edge")


def export_svd_video(opts: MovieVideoOptions) -> Path:
    ffmpeg_path = shutil.which(opts.ffmpeg) if Path(opts.ffmpeg).name == opts.ffmpeg else opts.ffmpeg
    if not ffmpeg_path:
        raise SystemExit("ffmpeg is required for movie-video export")

    encoded, meta, selected, frames_per_acq = build_encoded_movie(opts.movie)
    tracks = _tracks_payload(opts.movie.tracks_path, selected, frames_per_acq, opts.movie).get("tracks", [])
    fps = float(opts.fps or opts.movie.fps or meta.get("fps") or 30.0)
    first = _pad_even(np.repeat(encoded[0, :, :, None], 3, axis=2))
    height, width, _ = first.shape
    opts.video_path.parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        str(ffmpeg_path),
        "-y",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        f"{width}x{height}",
        "-r",
        f"{fps:g}",
        "-i",
        "-",
        "-an",
        "-vcodec",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        opts.preset,
        "-crf",
        str(int(opts.crf)),
        str(opts.video_path),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    assert proc.stdin is not None
    try:
        for frame_idx in range(encoded.shape[0]):
            rgb = np.repeat(encoded[frame_idx, :, :, None], 3, axis=2)
            _draw_points(rgb, tracks, frame_idx, meta, opts.point_radius)
            proc.stdin.write(_pad_even(rgb).astype(np.uint8, copy=False).tobytes())
    finally:
        proc.stdin.close()
    code = proc.wait()
    if code != 0:
        raise SystemExit(f"ffmpeg failed with exit code {code}")
    print(f"Wrote SVD point video to {opts.video_path}")
    return opts.video_path


def make_options(args) -> MovieVideoOptions:
    movie = MovieExportOptions(
        beamformed_path=Path(args.beamformed).expanduser().resolve(),
        tracks_path=Path(args.tracks).expanduser().resolve() if args.tracks else None,
        output_dir=Path(args.output).expanduser().resolve().parent,
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
        tail_frames=0,
        max_frames=args.max_frames,
    )
    return MovieVideoOptions(
        movie=movie,
        video_path=Path(args.output).expanduser().resolve(),
        ffmpeg=args.ffmpeg,
        point_radius=args.point_radius,
        fps=args.fps,
        crf=args.crf,
        preset=args.preset,
    )
