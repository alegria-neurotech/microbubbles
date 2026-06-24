from __future__ import annotations

import argparse
from pathlib import Path

from .beamform_mach import beamform_mach, make_options as make_beamform_options
from .movie_export import export_svd_movie, make_options as make_movie_options
from .staged_export import export_staged_movie, make_options as make_staged_options
from .tracking import (
    export_tracks_bin,
    make_options as make_tracking_options,
    run_tracking_outputs,
    smooth_tracks_pickle,
)
from .track_viewer_export import write_track_viewer
from .launcher_export import parse_viewer_spec, write_launcher
from .video_export import export_svd_video, make_options as make_video_options
from .volume_export import export_svd_volume, make_options as make_volume_options


def add_beamform_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--input", required=True, help="Input raw ultratrace.")
    parser.add_argument("--output", required=True, help="Output beamformed ultratrace.")
    parser.add_argument("--acq-start", type=int, default=0)
    parser.add_argument("--num-acqs", type=int, default=1)
    parser.add_argument("--acq-step", type=int, default=1)
    parser.add_argument(
        "--all-acqs",
        action="store_true",
        help="Process every acquisition. Required for full re-beamforming.",
    )
    parser.add_argument("--elev-planes", type=int, default=25)
    parser.add_argument("--z-coarseness", type=float, default=0.5)
    parser.add_argument("--x-coarseness", type=float, default=0.5)
    parser.add_argument("--no-large-fov", action="store_true")
    parser.add_argument("--xlarge-fov", action="store_true")
    parser.add_argument("--n-chunks", type=int, default=4)
    parser.add_argument("--spatial-tgc", action="store_true")
    parser.add_argument("--tgc-acqs", type=int, default=12)
    parser.add_argument("--tgc-sigma-lambda", type=float, default=9.0)
    parser.add_argument("--tgc-svd-cut", type=float, default=0.05)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--dry-run", action="store_true")


def add_tracking_args(parser: argparse.ArgumentParser, require_beamformed: bool = True) -> None:
    parser.add_argument(
        "--beamformed",
        required=require_beamformed,
        help="Beamformed ultratrace.",
    )
    parser.add_argument("--tracks", required=True, help="Output tracking pickle.")
    parser.add_argument("--num-acqs", type=int, default=None)
    parser.add_argument("--acq-start", type=int, default=None)
    parser.add_argument("--acq-step", type=int, default=1)
    parser.add_argument("--output-per-acq", action="store_true")
    parser.add_argument("--sigma-threshold", type=float, default=2.0)
    parser.add_argument("--svd-low-cutoff", "--svd-cutoff", type=float, default=0.1)
    parser.add_argument("--svd-high-cutoff", type=float, default=None)
    parser.add_argument("--svd-n-components", type=int, default=None)
    parser.add_argument(
        "--svd-method",
        choices=["fast", "full", "adaptive", "none"],
        default="fast",
        help="Temporal SVD implementation. 'adaptive' picks the clutter cutoff "
        "per acquisition from the temporal spectral centroid (needs --frame-rate).",
    )
    parser.add_argument(
        "--knee-filter",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="In adaptive mode, drop per-acquisition detections below the z-score knee.",
    )
    parser.add_argument(
        "--tissue-freq",
        dest="tissue_freq_hz",
        type=float,
        default=100.0,
        help="Tissue/blood frequency boundary (Hz) for adaptive SVD.",
    )
    parser.add_argument(
        "--filter",
        dest="filter_method",
        choices=["svd", "none"],
        default="svd",
        help="Use SVD clutter filtering, or treat compound_image as already filtered.",
    )
    parser.add_argument("--temporal-sigma", type=float, default=0.0)
    parser.add_argument("--min-distance", type=int, default=2)
    parser.add_argument("--smoothing-sigma", type=float, default=1.0)
    parser.add_argument("--subpixel", choices=["parabolic", "centroid", "gaussian_fit"], default="centroid")
    parser.add_argument("--window-size", type=int, default=5)
    parser.add_argument("--patch-radius", type=int, default=3)
    parser.add_argument("--tracking", choices=["kalman", "greedy"], default="kalman")
    parser.add_argument("--frame-rate", dest="frame_rate_hz", type=float, default=None)
    parser.add_argument("--max-dist", type=float, nargs=3, default=None)
    parser.add_argument("--max-dist-mms", type=float, nargs=3, default=None)
    parser.add_argument("--max-gap", type=int, default=3)
    parser.add_argument("--min-track-length", type=int, default=5)
    parser.add_argument("--reversal-penalty", type=float, default=10.0)
    parser.add_argument("--max-cost", type=float, default=10.0)
    parser.add_argument("--smooth-sigma", type=float, default=2.0)
    parser.add_argument("--export-dir", default=None)
    parser.add_argument("--export-stem", default=None)
    parser.add_argument("--min-lengths", type=int, nargs="+", default=[5, 20, 50])


def cmd_beamform(args: argparse.Namespace) -> None:
    opts = make_beamform_options(args)
    beamform_mach(opts)


def cmd_track(args: argparse.Namespace) -> None:
    opts = make_tracking_options(args)
    run_tracking_outputs(opts)


def cmd_run(args: argparse.Namespace) -> None:
    opts = make_tracking_options(args)
    run_tracking_outputs(opts)


def cmd_export(args: argparse.Namespace) -> None:
    smoothed = smooth_tracks_pickle(
        Path(args.tracks).expanduser().resolve(),
        Path(args.smoothed).expanduser().resolve() if args.smoothed else None,
        sigma=args.smooth_sigma,
    )
    output_dir = Path(args.export_dir).expanduser().resolve()
    stem = args.export_stem or smoothed.stem
    for min_length in args.min_lengths:
        export_tracks_bin(smoothed, output_dir / f"{stem}_min{min_length}.bin", min_length)


def cmd_movie(args: argparse.Namespace) -> None:
    export_svd_movie(make_movie_options(args))


def cmd_movie_video(args: argparse.Namespace) -> None:
    export_svd_video(make_video_options(args))


def cmd_staged_movie(args: argparse.Namespace) -> None:
    export_staged_movie(make_staged_options(args))


def cmd_volume(args: argparse.Namespace) -> None:
    export_svd_volume(make_volume_options(args))


def cmd_track_viewer(args: argparse.Namespace) -> None:
    write_track_viewer(
        Path(args.tracks).expanduser().resolve(),
        Path(args.output_dir).expanduser().resolve(),
        min_length=args.min_length,
        sigma=args.sigma,
        use_smoothed=not args.raw,
        beamformed=Path(args.beamformed).expanduser().resolve() if args.beamformed else None,
        svd_cutoff=args.svd_cutoff,
    )


def cmd_launcher(args: argparse.Namespace) -> None:
    viewers = [parse_viewer_spec(spec) for spec in args.viewer]
    write_launcher(
        Path(args.output_dir).expanduser().resolve(),
        title=args.title,
        subtitle=args.subtitle,
        footer=args.footer,
        viewers=viewers,
    )


def cmd_doctor(args: argparse.Namespace) -> None:
    import h5py
    import numpy
    import scipy

    print("Standalone runtime imports OK")
    print(f"h5py: {h5py.__version__}")
    print(f"numpy: {numpy.__version__}")
    print(f"scipy: {scipy.__version__}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ultratrace-ulm")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("beamform", help="MACH-only beamform selected acquisitions.")
    add_beamform_args(p)
    p.set_defaults(func=cmd_beamform)

    p = sub.add_parser("track", help="Run streaming ULM tracking on a beamformed file.")
    add_tracking_args(p)
    p.set_defaults(func=cmd_track)

    p = sub.add_parser(
        "run",
        help="Track, smooth, and export from an existing beamformed file.",
        conflict_handler="resolve",
    )
    add_tracking_args(p, require_beamformed=True)
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("export", help="Smooth and export an existing track pickle.")
    p.add_argument("--tracks", required=True)
    p.add_argument("--smoothed", default=None)
    p.add_argument("--smooth-sigma", type=float, default=2.0)
    p.add_argument("--export-dir", required=True)
    p.add_argument("--export-stem", default=None)
    p.add_argument("--min-lengths", type=int, nargs="+", default=[5, 20, 50])
    p.set_defaults(func=cmd_export)

    p = sub.add_parser(
        "movie",
        help="Export a static SVD-filtered b-mode movie viewer with track overlay.",
    )
    p.add_argument("--beamformed", required=True, help="Beamformed ultratrace.")
    p.add_argument("--tracks", default=None, help="Optional ULM track pickle.")
    p.add_argument("--output-dir", required=True)
    p.add_argument("--acq-start", type=int, default=0)
    p.add_argument("--num-acqs", type=int, default=1)
    p.add_argument("--acq-step", type=int, default=1)
    p.add_argument("--svd-low-cutoff", type=float, default=0.1)
    p.add_argument("--svd-high-cutoff", type=float, default=None)
    p.add_argument("--svd-method", choices=["fast", "full"], default="fast")
    p.add_argument("--temporal-sigma", type=float, default=0.0)
    p.add_argument(
        "--projection",
        choices=["xz-mip", "xz-mean", "xz-plane", "xz-slab-mip"],
        default="xz-mip",
    )
    p.add_argument("--elev-index", type=int, default=None)
    p.add_argument("--elev-slabs", type=int, default=6)
    p.add_argument("--slab-cols", type=int, default=1)
    p.add_argument("--slab-gap-px", type=int, default=3)
    p.add_argument("--physical-aspect", action="store_true")
    p.add_argument("--dynamic-range-db", type=float, default=15.0)
    p.add_argument("--percentile", type=float, default=99.7)
    p.add_argument("--fps", type=float, default=30.0)
    p.add_argument("--track-min-length", type=int, default=5)
    p.add_argument("--tail-frames", type=int, default=18)
    p.add_argument("--max-frames", type=int, default=None)
    p.set_defaults(func=cmd_movie)

    p = sub.add_parser(
        "movie-video",
        help="Export an MP4 SVD b-mode movie with yellow current-frame bubble points.",
    )
    p.add_argument("--beamformed", required=True, help="Beamformed ultratrace.")
    p.add_argument("--tracks", default=None, help="Optional ULM track pickle.")
    p.add_argument("--output", required=True, help="Output .mp4 path.")
    p.add_argument("--acq-start", type=int, default=0)
    p.add_argument("--num-acqs", type=int, default=1)
    p.add_argument("--acq-step", type=int, default=1)
    p.add_argument("--svd-low-cutoff", type=float, default=0.1)
    p.add_argument("--svd-high-cutoff", type=float, default=None)
    p.add_argument("--svd-method", choices=["fast", "full"], default="fast")
    p.add_argument("--temporal-sigma", type=float, default=0.0)
    p.add_argument(
        "--projection",
        choices=["xz-mip", "xz-mean", "xz-plane", "xz-slab-mip"],
        default="xz-slab-mip",
    )
    p.add_argument("--elev-index", type=int, default=None)
    p.add_argument("--elev-slabs", type=int, default=6)
    p.add_argument("--slab-cols", type=int, default=1)
    p.add_argument("--slab-gap-px", type=int, default=3)
    p.add_argument("--physical-aspect", action="store_true")
    p.add_argument("--dynamic-range-db", type=float, default=15.0)
    p.add_argument("--percentile", type=float, default=99.7)
    p.add_argument("--fps", type=float, default=30.0)
    p.add_argument("--track-min-length", type=int, default=5)
    p.add_argument("--point-radius", type=float, default=2.4)
    p.add_argument("--max-frames", type=int, default=None)
    p.add_argument("--ffmpeg", default="ffmpeg")
    p.add_argument("--crf", type=int, default=18)
    p.add_argument("--preset", default="medium")
    p.set_defaults(func=cmd_movie_video)

    p = sub.add_parser(
        "staged-movie",
        help="Export a step-through raw, SVD, detection, and track movie viewer.",
    )
    p.add_argument("--beamformed", required=True, help="Beamformed ultratrace.")
    p.add_argument("--tracks", default=None, help="Optional ULM track pickle.")
    p.add_argument("--output-dir", required=True)
    p.add_argument("--acq-start", type=int, default=0)
    p.add_argument("--num-acqs", type=int, default=1)
    p.add_argument("--acq-step", type=int, default=1)
    p.add_argument("--svd-low-cutoff", type=float, default=0.1)
    p.add_argument("--svd-high-cutoff", type=float, default=None)
    p.add_argument("--svd-method", choices=["fast", "full"], default="fast")
    p.add_argument("--temporal-sigma", type=float, default=0.0)
    p.add_argument(
        "--projection",
        choices=["xz-mip", "xz-mean", "xz-plane", "xz-slab-mip"],
        default="xz-slab-mip",
    )
    p.add_argument("--elev-index", type=int, default=None)
    p.add_argument("--elev-slabs", type=int, default=6)
    p.add_argument("--slab-cols", type=int, default=1)
    p.add_argument("--slab-gap-px", type=int, default=3)
    p.add_argument("--physical-aspect", action="store_true")
    p.add_argument("--percentile", type=float, default=99.7)
    p.add_argument("--raw-dynamic-range-db", type=float, default=45.0)
    p.add_argument("--filtered-dynamic-range-db", type=float, default=15.0)
    p.add_argument("--detect-dynamic-range-db", type=float, default=10.0)
    p.add_argument("--fps", type=float, default=30.0)
    p.add_argument("--track-min-length", type=int, default=5)
    p.add_argument("--max-frames", type=int, default=None)
    p.set_defaults(func=cmd_staged_movie)

    p = sub.add_parser(
        "volume",
        help="Export a rotatable 3D SVD voxel viewer with track overlay.",
    )
    p.add_argument("--beamformed", required=True, help="Beamformed ultratrace.")
    p.add_argument("--tracks", default=None, help="Optional ULM track pickle.")
    p.add_argument("--output-dir", required=True)
    p.add_argument("--acq-start", type=int, default=0)
    p.add_argument("--num-acqs", type=int, default=1)
    p.add_argument("--acq-step", type=int, default=1)
    p.add_argument("--svd-low-cutoff", type=float, default=0.1)
    p.add_argument("--svd-high-cutoff", type=float, default=None)
    p.add_argument("--svd-method", choices=["fast", "full"], default="fast")
    p.add_argument("--temporal-sigma", type=float, default=0.0)
    p.add_argument("--dynamic-range-db", type=float, default=15.0)
    p.add_argument("--percentile", type=float, default=99.7)
    p.add_argument("--voxel-percentile", type=float, default=99.9)
    p.add_argument("--max-points-per-frame", type=int, default=8000)
    p.add_argument("--background-percentile", type=float, default=99.8)
    p.add_argument("--background-dynamic-range-db", type=float, default=45.0)
    p.add_argument("--background-max-points-per-frame", type=int, default=18000)
    p.add_argument("--background-intro-seconds", type=float, default=1.5)
    p.add_argument("--subtraction-fade-seconds", type=float, default=1.0)
    p.add_argument("--fps", type=float, default=30.0)
    p.add_argument("--track-min-length", type=int, default=5)
    p.add_argument("--tail-frames", type=int, default=18)
    p.add_argument("--max-frames", type=int, default=None)
    p.set_defaults(func=cmd_volume)

    p = sub.add_parser(
        "track-viewer",
        help="Export the animated 3D track viewer (Three.js point-flow) bundle.",
    )
    p.add_argument("--tracks", required=True, help="ULM track pickle.")
    p.add_argument("--output-dir", required=True)
    p.add_argument("--min-length", type=int, default=35)
    p.add_argument("--sigma", type=float, default=10.0, help="Gaussian sigma for velocity smoothing.")
    p.add_argument("--raw", action="store_true", help="Use raw tracks instead of smoothed.")
    p.add_argument(
        "--beamformed",
        default=None,
        help="Optional beamformed H5 for per-point B-mode intensity lookup.",
    )
    p.add_argument(
        "--svd-cutoff",
        type=float,
        default=0.0,
        help="SVD low cutoff for intensity lookup (0 = raw magnitude).",
    )
    p.set_defaults(func=cmd_track_viewer)

    p = sub.add_parser(
        "launcher",
        help="Write a landing page (index.html + viewers.json) linking viewer bundles.",
    )
    p.add_argument("--output-dir", required=True)
    p.add_argument("--title", default="Ultratrace ULM Viewers")
    p.add_argument("--subtitle", default="")
    p.add_argument("--footer", default="")
    p.add_argument(
        "--viewer",
        action="append",
        default=[],
        metavar="HREF|TITLE|DESC|EMOJI",
        help="Repeatable viewer card: relative href plus optional title, description, emoji.",
    )
    p.set_defaults(func=cmd_launcher)

    p = sub.add_parser("doctor", help="Check runtime imports.")
    p.set_defaults(func=cmd_doctor)
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
