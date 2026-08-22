from __future__ import annotations

from collections import Counter
from typing import Any, Mapping, Sequence


TERMINAL_STATUSES = frozenset({"succeeded", "failed", "cancelled"})
PENDING_CLEANUP_STATES = frozenset({"staging_orphan", "receipt_required"})
KNOWN_EVENT_TYPES = frozenset(
    {
        "accepted",
        "started",
        "cancel_requested",
        "succeeded",
        "failed",
        "cancelled",
        "artifact_published",
        "recovery_failed",
    }
)
KNOWN_CLEANUP_STATES = frozenset({"staging_orphan", "receipt_required", "reconciled"})


def build_job_observability_summary(
    job: Mapping[str, Any],
    events: Sequence[Mapping[str, Any]],
    artifacts: Sequence[Mapping[str, Any]],
    cleanup_ledger: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Project lifecycle evidence into a bounded, path-free summary."""

    status = job.get("status") if job.get("status") in {
        "queued",
        "running",
        "cancelling",
        "succeeded",
        "failed",
        "cancelled",
    } else "unknown"
    event_counts = Counter(
        event.get("event_type")
        for event in events
        if event.get("event_type") in KNOWN_EVENT_TYPES
    )
    cleanup_counts = Counter(
        item.get("state")
        for item in cleanup_ledger
        if item.get("state") in KNOWN_CLEANUP_STATES
    )
    artifact_bytes = sum(
        item.get("size_bytes", 0)
        for item in artifacts
        if isinstance(item.get("size_bytes"), int)
        and not isinstance(item.get("size_bytes"), bool)
        and item.get("size_bytes", 0) >= 0
    )
    error = job.get("error")
    error_code = error.get("code") if isinstance(error, Mapping) else None

    return {
        "schema_version": "job-observability/v1",
        "job_id": job.get("job_id"),
        "status": status,
        "terminal": status in TERMINAL_STATUSES,
        "event_count": sum(event_counts.values()),
        "event_types": dict(sorted(event_counts.items())),
        "artifact_count": len(artifacts),
        "artifact_bytes": artifact_bytes,
        "cleanup_counts": dict(sorted(cleanup_counts.items())),
        "cleanup_pending": any(
            state in PENDING_CLEANUP_STATES for state in cleanup_counts
        ),
        "error_code": error_code if isinstance(error_code, str) else None,
        "created_at": job.get("created_at"),
        "updated_at": job.get("updated_at"),
    }
