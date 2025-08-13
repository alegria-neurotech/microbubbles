from __future__ import annotations

from pathlib import Path

import h5py
import numpy as np


def acq_keys(h5: h5py.File) -> list[int]:
    if "acquisitions" not in h5:
        raise KeyError("Expected H5 group 'acquisitions'")
    return sorted(int(k) for k in h5["acquisitions"].keys() if str(k).isdigit())


def select_acquisitions(
    keys: list[int],
    acq_start: int | None,
    num_acqs: int | None,
    acq_step: int,
) -> list[int]:
    if acq_step < 1:
        raise ValueError("--acq-step must be >= 1")
    start = 0 if acq_start is None else int(acq_start)
    selected = keys[start::acq_step]
    if num_acqs is not None:
        selected = selected[: int(num_acqs)]
    if not selected:
        raise ValueError("No acquisitions selected")
    return selected


def find_dataset(group: h5py.Group, names: list[str]) -> h5py.Dataset:
    for name in names:
        if name in group:
            obj = group[name]
            if isinstance(obj, h5py.Dataset):
                return obj
    for child in group.values():
        if isinstance(child, h5py.Group):
            try:
                return find_dataset(child, names)
            except KeyError:
                pass
    raise KeyError(f"Could not find any dataset named {names}")


def compound_dataset(h5: h5py.File, acq_id: int) -> h5py.Dataset:
    group = h5[f"acquisitions/{acq_id}"]
    return find_dataset(group, ["compound_image"])


def load_compound(h5: h5py.File, acq_id: int) -> np.ndarray:
    compound = np.asarray(compound_dataset(h5, acq_id))
    if compound.ndim == 3:
        compound = compound[:, None, :, :]
    if compound.ndim != 4:
        raise ValueError(
            f"Expected compound image with shape (frames,elev,z,x) or (frames,z,x); "
            f"got {compound.shape}"
        )
    return np.asarray(compound, dtype=np.complex64)


def _to_mm(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=np.float32)
    finite = values[np.isfinite(values)]
    if finite.size and float(np.nanmax(np.abs(finite))) < 2.0:
        values = values * 1000.0
    return values


def _normalize_grid_axis(axis: np.ndarray, spatial_shape: tuple[int, int, int]) -> np.ndarray:
    axis = np.squeeze(_to_mm(axis))
    elev, z, x = spatial_shape

    if axis.shape == spatial_shape:
        return axis.astype(np.float32, copy=False)
    if axis.ndim == 3 and axis.shape == (z, elev, x):
        return axis.transpose(1, 0, 2).astype(np.float32, copy=False)
    if axis.ndim == 2 and axis.shape == (z, x):
        return np.broadcast_to(axis[None, :, :], spatial_shape).astype(np.float32, copy=False)
    if axis.ndim == 1:
        if axis.size == elev:
            return np.broadcast_to(axis[:, None, None], spatial_shape).astype(np.float32, copy=False)
        if axis.size == z:
            return np.broadcast_to(axis[None, :, None], spatial_shape).astype(np.float32, copy=False)
        if axis.size == x:
            return np.broadcast_to(axis[None, None, :], spatial_shape).astype(np.float32, copy=False)

    raise ValueError(f"Could not reshape grid axis {axis.shape} to spatial shape {spatial_shape}")


def grid_arrays(h5: h5py.File, acq_id: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    group = h5[f"acquisitions/{acq_id}"]
    spatial_shape = load_compound(h5, acq_id).shape[1:]
    x_raw = find_dataset(group, ["x"])[()]
    z_raw = find_dataset(group, ["z"])[()]
    try:
        y_raw = find_dataset(group, ["y"])[()]
    except KeyError:
        y_raw = np.zeros(spatial_shape[0], dtype=np.float32)
    return (
        _normalize_grid_axis(x_raw, spatial_shape),
        _normalize_grid_axis(y_raw, spatial_shape),
        _normalize_grid_axis(z_raw, spatial_shape),
    )


def axis_bounds(grid_x: np.ndarray, grid_y: np.ndarray, grid_z: np.ndarray) -> dict:
    return {
        "x": [float(np.nanmin(grid_x)), float(np.nanmax(grid_x))],
        "y": [float(np.nanmin(grid_y)), float(np.nanmax(grid_y))],
        "z": [float(np.nanmin(grid_z)), float(np.nanmax(grid_z))],
    }


def open_h5(path: str | Path) -> h5py.File:
    return h5py.File(Path(path).expanduser().resolve(), "r")
