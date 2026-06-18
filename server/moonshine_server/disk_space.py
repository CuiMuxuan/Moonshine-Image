import os
import shutil
from dataclasses import dataclass
from pathlib import Path


DEFAULT_DISK_SPACE_SAFETY_BYTES = 64 * 1024 * 1024


class DiskSpaceError(RuntimeError):
    pass


@dataclass(frozen=True)
class DiskSpaceCheckResult:
    path: Path
    free_bytes: int
    required_bytes: int
    payload_bytes: int
    safety_bytes: int


def format_bytes(value: int | float) -> str:
    size = float(max(0, int(value or 0)))
    units = ("B", "KB", "MB", "GB", "TB")
    unit_index = 0
    while size >= 1024 and unit_index < len(units) - 1:
        size /= 1024
        unit_index += 1
    if unit_index == 0:
        return f"{int(size)} {units[unit_index]}"
    return f"{size:.1f} {units[unit_index]}"


def resolve_disk_check_path(target_path: str | Path) -> Path:
    path = Path(target_path or ".").expanduser()
    if path.suffix:
        path = path.parent
    path.mkdir(parents=True, exist_ok=True)
    return path.resolve()


def get_free_disk_bytes(target_path: str | Path) -> tuple[Path, int]:
    path = resolve_disk_check_path(target_path)
    usage = shutil.disk_usage(path)
    return path, int(usage.free)


def ensure_disk_space(
    target_path: str | Path,
    payload_bytes: int | float,
    *,
    safety_bytes: int | float = DEFAULT_DISK_SPACE_SAFETY_BYTES,
    operation: str = "写入文件",
) -> DiskSpaceCheckResult:
    normalized_payload = max(0, int(payload_bytes or 0))
    normalized_safety = max(0, int(safety_bytes or 0))
    required_bytes = normalized_payload + normalized_safety
    path, free_bytes = get_free_disk_bytes(target_path)
    if free_bytes < required_bytes:
        raise DiskSpaceError(
            f"{operation}磁盘空间不足。"
            f"预计至少需要 {format_bytes(required_bytes)}，"
            f"当前可用 {format_bytes(free_bytes)}。"
            "请清理磁盘空间或在全局设置中更换输出/临时目录后重试。"
        )
    return DiskSpaceCheckResult(
        path=path,
        free_bytes=free_bytes,
        required_bytes=required_bytes,
        payload_bytes=normalized_payload,
        safety_bytes=normalized_safety,
    )


def file_size_or_zero(path: str | Path) -> int:
    try:
        return int(os.path.getsize(path))
    except OSError:
        return 0
