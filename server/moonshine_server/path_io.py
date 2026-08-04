"""Unicode-safe filesystem adapters for native image, video, and model APIs."""

from __future__ import annotations

import os
import shutil
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, TypeVar


PathInput = str | os.PathLike[str]
T = TypeVar("T")


def to_path(value: PathInput) -> Path:
    """Return a user supplied path as an expanded ``Path`` object."""

    raw_value = os.fspath(value)
    if isinstance(raw_value, bytes):
        raise TypeError("bytes paths are not supported; pass a Unicode path instead")
    return Path(raw_value).expanduser()


def read_image_file(path: PathInput, flags: int | None = None):
    """Read an image through Python's Unicode file APIs, then decode in OpenCV.

    OpenCV receives bytes rather than the filesystem path. This keeps path
    handling in Python while preserving OpenCV's normal decode flags.
    """

    import cv2
    import numpy as np

    image_path = to_path(path)
    try:
        payload = image_path.read_bytes()
    except OSError:
        return None
    if not payload:
        return None

    encoded = np.frombuffer(payload, dtype=np.uint8)
    try:
        return cv2.imdecode(
            encoded,
            cv2.IMREAD_UNCHANGED if flags is None else flags,
        )
    except cv2.error:
        return None


def write_image_file(
    path: PathInput,
    image: Any,
    params: Iterable[int] | None = None,
    *,
    create_parent: bool = False,
) -> bool:
    """Encode an image in OpenCV and write the bytes through ``Path``."""

    import cv2

    image_path = to_path(path)
    extension = image_path.suffix.lower() or ".png"
    encoded_params = [] if params is None else list(params)
    try:
        ok, encoded = cv2.imencode(extension, image, encoded_params)
    except cv2.error:
        return False
    if not ok:
        return False

    try:
        if create_parent:
            image_path.parent.mkdir(parents=True, exist_ok=True)
        image_path.write_bytes(encoded.tobytes())
    except OSError:
        return False
    return True


def load_with_binary_path(
    loader: Callable[..., T],
    path: PathInput,
    *args: Any,
    **kwargs: Any,
) -> T:
    """Call a loader with a Python-opened binary file object.

    This is useful for libraries whose path handling is implemented in a
    native layer but which also accept file-like objects.
    """

    with to_path(path).open("rb") as handle:
        return loader(handle, *args, **kwargs)


def load_torch_checkpoint(path: PathInput, *args: Any, **kwargs: Any) -> Any:
    """Load a Torch checkpoint from a Unicode-safe Python file object."""

    import torch

    return load_with_binary_path(torch.load, path, *args, **kwargs)


def load_torchscript(path: PathInput, *args: Any, **kwargs: Any) -> Any:
    """Load a TorchScript module from a Unicode-safe Python file object."""

    import torch

    return load_with_binary_path(torch.jit.load, path, *args, **kwargs)


def _is_ascii_path(path: Path) -> bool:
    try:
        str(path).encode("ascii")
    except UnicodeEncodeError:
        return False
    return True


def _make_ascii_temp_copy(source: Path) -> tuple[Path, Path]:
    """Copy ``source`` to an ASCII-only temporary path and return its root."""

    candidate_dirs: list[Path | None] = [None]
    if os.name == "nt":
        candidate_dirs.extend((Path("C:/Temp"), Path("C:/Windows/Temp")))

    for candidate_dir in candidate_dirs:
        temporary_root: Path | None = None
        try:
            if candidate_dir is not None and not candidate_dir.is_dir():
                continue
            temporary_root = Path(
                tempfile.mkdtemp(
                    prefix="moonshine-video-",
                    dir=str(candidate_dir) if candidate_dir is not None else None,
                )
            )
            if not _is_ascii_path(temporary_root):
                shutil.rmtree(temporary_root, ignore_errors=True)
                continue

            suffix = source.suffix.lower()
            if not suffix or not suffix.isascii():
                suffix = ".bin"
            staged_path = temporary_root / f"input{suffix}"
            shutil.copyfile(source, staged_path)
            return staged_path, temporary_root
        except OSError:
            if temporary_root is not None:
                shutil.rmtree(temporary_root, ignore_errors=True)

    raise OSError(
        "Unable to create an ASCII-only temporary path for native video decoding: "
        f"{source}"
    )


@contextmanager
def stage_ascii_path(path: PathInput) -> Iterator[Path]:
    """Temporarily expose a file through an ASCII-only path when required.

    Python's filesystem APIs already handle Unicode paths. This helper is for
    native consumers that still require an ASCII filename, such as a video
    decoder hidden behind a third-party predictor. Directories are left in
    place because their contents are enumerated through Python APIs by the
    callers currently supported here.
    """

    source = to_path(path)
    if _is_ascii_path(source) or not source.is_file():
        yield source
        return

    staged_path, temporary_root = _make_ascii_temp_copy(source)
    try:
        yield staged_path
    finally:
        shutil.rmtree(temporary_root, ignore_errors=True)


@contextmanager
def open_video_capture(path: PathInput) -> Iterator[Any]:
    """Open a video, retrying through an ASCII temporary path if necessary."""

    import cv2

    video_path = to_path(path)
    capture = cv2.VideoCapture(str(video_path))
    temporary_root: Path | None = None

    if not capture.isOpened():
        capture.release()
        staged_path, temporary_root = _make_ascii_temp_copy(video_path)
        capture = cv2.VideoCapture(str(staged_path))

    if not capture.isOpened():
        capture.release()
        if temporary_root is not None:
            shutil.rmtree(temporary_root, ignore_errors=True)
        raise OSError(f"Failed to open video: {video_path}")

    try:
        yield capture
    finally:
        capture.release()
        if temporary_root is not None:
            shutil.rmtree(temporary_root, ignore_errors=True)
