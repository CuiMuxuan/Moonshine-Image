import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Optional


SAM_VIDEO_TASK_STATUSES = {
    "queued",
    "frame_loading",
    "prompt_encoding",
    "propagating",
    "writing_masks",
    "completed",
    "failed",
    "canceled",
}


@dataclass
class SamVideoTask:
    task_id: str
    request: Any
    status: str = "queued"
    phase: str = "queued"
    message: str = "SAM2 视频传播任务已创建"
    current: int = 0
    total: int = 0
    progress: float = 0.0
    error: str = ""
    result: Optional[dict] = None
    canceled: bool = False
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    completed_at: Optional[float] = None

    def to_dict(self, *, include_result: bool = False) -> dict:
        payload = {
            "taskId": self.task_id,
            "status": self.status,
            "phase": self.phase,
            "message": self.message,
            "current": self.current,
            "total": self.total,
            "progress": self.progress,
            "error": self.error,
            "canceled": self.canceled,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "completedAt": self.completed_at,
        }
        if include_result:
            payload["result"] = self.result
        return payload


class SamVideoTaskManager:
    def __init__(self):
        self._tasks: dict[str, SamVideoTask] = {}
        self._lock = threading.RLock()

    def create_task(self, request: Any) -> SamVideoTask:
        task = SamVideoTask(task_id=uuid.uuid4().hex, request=request)
        with self._lock:
            self._tasks[task.task_id] = task
        return task

    def get_task(self, task_id: str) -> Optional[SamVideoTask]:
        with self._lock:
            return self._tasks.get(task_id)

    def cancel_task(self, task_id: str) -> Optional[SamVideoTask]:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return None
            task.canceled = True
            task.updated_at = time.time()
            if task.status in {"queued"}:
                task.status = "canceled"
                task.phase = "canceled"
                task.message = "SAM2 视频传播任务已取消"
                task.completed_at = task.updated_at
            return task

    def update_progress(
        self,
        task_id: str,
        *,
        status: str,
        phase: Optional[str] = None,
        message: str = "",
        current: int = 0,
        total: int = 0,
        progress: Optional[float] = None,
    ) -> None:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task or task.status in {"completed", "failed", "canceled"}:
                return
            safe_total = max(0, int(total or 0))
            safe_current = max(0, int(current or 0))
            if safe_total > 0:
                safe_current = min(safe_current, safe_total)
            task.status = status if status in SAM_VIDEO_TASK_STATUSES else task.status
            task.phase = phase or task.status
            task.message = message or task.message
            task.current = safe_current
            task.total = safe_total
            if progress is None:
                task.progress = (
                    max(0.0, min(1.0, safe_current / safe_total)) if safe_total > 0 else task.progress
                )
            else:
                task.progress = max(0.0, min(1.0, float(progress)))
            task.updated_at = time.time()

    def finish_task(self, task_id: str, result: dict) -> None:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return
            task.result = result
            task.status = "completed"
            task.phase = "completed"
            task.message = "SAM2 视频传播任务已完成"
            task.progress = 1.0
            task.updated_at = time.time()
            task.completed_at = task.updated_at

    def fail_task(self, task_id: str, error: str) -> None:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return
            if task.canceled:
                task.status = "canceled"
                task.phase = "canceled"
                task.message = "SAM2 视频传播任务已取消"
            else:
                task.status = "failed"
                task.phase = "failed"
                task.message = error or "SAM2 视频传播任务失败"
                task.error = error or task.message
            task.updated_at = time.time()
            task.completed_at = task.updated_at

    def make_progress_callback(self, task_id: str) -> Callable[..., None]:
        def callback(**payload: Any) -> None:
            task = self.get_task(task_id)
            if task and task.canceled:
                raise RuntimeError("SAM2 video propagation task canceled.")
            self.update_progress(task_id, **payload)

        return callback


sam_video_task_manager = SamVideoTaskManager()
