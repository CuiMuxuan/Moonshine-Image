from __future__ import annotations

import argparse
import json
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path


class EventSequenceError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect(database_path: Path | str, timeout: float = 5.0) -> sqlite3.Connection:
    connection = sqlite3.connect(
        str(database_path),
        timeout=timeout,
        isolation_level=None,
    )
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA synchronous = FULL")
    connection.execute(f"PRAGMA busy_timeout = {max(0, int(timeout * 1000))}")
    return connection


def _rollback(connection: sqlite3.Connection) -> None:
    if connection.in_transaction:
        connection.execute("ROLLBACK")


def initialize_database(database_path: Path | str) -> None:
    connection = connect(database_path)
    try:
        connection.execute("PRAGMA journal_mode = WAL")
        if connection.execute("PRAGMA user_version").fetchone()[0] >= 1:
            return

        connection.execute("BEGIN IMMEDIATE")
        try:
            connection.execute(
                """
                CREATE TABLE jobs (
                    job_id TEXT PRIMARY KEY,
                    request_hash TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (
                        status IN ('queued', 'running', 'interrupted')
                    ),
                    write_started INTEGER NOT NULL DEFAULT 0 CHECK (
                        write_started IN (0, 1)
                    ),
                    recovery_disposition TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE job_events (
                    job_id TEXT NOT NULL,
                    seq INTEGER NOT NULL CHECK (seq >= 0),
                    event_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (job_id, seq),
                    FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE CASCADE
                )
                """
            )
            connection.execute("PRAGMA user_version = 1")
            connection.execute("COMMIT")
        except BaseException:
            _rollback(connection)
            raise
    finally:
        connection.close()


def migrate_to_v2(
    database_path: Path | str,
    *,
    inject_failure: bool = False,
) -> None:
    connection = connect(database_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        try:
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version != 1:
                raise RuntimeError(f"expected schema version 1, received {version}")
            connection.execute(
                "ALTER TABLE jobs ADD COLUMN policy_snapshot TEXT NOT NULL DEFAULT '{}'"
            )
            connection.execute(
                "CREATE INDEX jobs_status_idx ON jobs(status, updated_at)"
            )
            if inject_failure:
                connection.execute("INSERT INTO missing_migration_table VALUES (1)")
            connection.execute("PRAGMA user_version = 2")
            connection.execute("COMMIT")
        except BaseException:
            _rollback(connection)
            raise
    finally:
        connection.close()


def _append_event(
    connection: sqlite3.Connection,
    job_id: str,
    event_type: str,
    payload: dict[str, object],
    *,
    expected_seq: int | None = None,
) -> int:
    row = connection.execute(
        "SELECT COALESCE(MAX(seq), -1) + 1 FROM job_events WHERE job_id = ?",
        (job_id,),
    ).fetchone()
    next_seq = int(row[0])
    if expected_seq is not None and expected_seq != next_seq:
        raise EventSequenceError(
            f"expected event sequence {expected_seq}, next sequence is {next_seq}"
        )
    connection.execute(
        """
        INSERT INTO job_events (job_id, seq, event_type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (job_id, next_seq, event_type, json.dumps(payload, sort_keys=True), utc_now()),
    )
    return next_seq


def submit_job(
    database_path: Path | str,
    job_id: str,
    request_hash: str,
    *,
    timeout: float = 5.0,
) -> None:
    connection = connect(database_path, timeout=timeout)
    try:
        connection.execute("BEGIN IMMEDIATE")
        try:
            now = utc_now()
            connection.execute(
                """
                INSERT INTO jobs (
                    job_id, request_hash, status, write_started,
                    recovery_disposition, created_at, updated_at
                ) VALUES (?, ?, 'queued', 0, NULL, ?, ?)
                """,
                (job_id, request_hash, now, now),
            )
            _append_event(connection, job_id, "job.queued", {})
            connection.execute("COMMIT")
        except BaseException:
            _rollback(connection)
            raise
    finally:
        connection.close()


def mark_running_with_write_started(
    database_path: Path | str,
    job_id: str,
) -> None:
    connection = connect(database_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        try:
            cursor = connection.execute(
                """
                UPDATE jobs
                SET status = 'running', write_started = 1, updated_at = ?
                WHERE job_id = ? AND status = 'queued'
                """,
                (utc_now(), job_id),
            )
            if cursor.rowcount != 1:
                raise RuntimeError(f"job {job_id} is not queued")
            _append_event(connection, job_id, "job.write_started", {})
            connection.execute("COMMIT")
        except BaseException:
            _rollback(connection)
            raise
    finally:
        connection.close()


def append_job_event(
    database_path: Path | str,
    job_id: str,
    event_type: str,
    *,
    expected_seq: int,
) -> int:
    connection = connect(database_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        try:
            sequence = _append_event(
                connection,
                job_id,
                event_type,
                {},
                expected_seq=expected_seq,
            )
            connection.execute("COMMIT")
            return sequence
        except BaseException:
            _rollback(connection)
            raise
    finally:
        connection.close()


def recover_started_writes(database_path: Path | str) -> dict[str, list[str]]:
    connection = connect(database_path)
    interrupted: list[str] = []
    try:
        connection.execute("BEGIN IMMEDIATE")
        try:
            rows = connection.execute(
                """
                SELECT job_id FROM jobs
                WHERE status = 'running' AND write_started = 1
                ORDER BY job_id
                """
            ).fetchall()
            for row in rows:
                job_id = str(row["job_id"])
                connection.execute(
                    """
                    UPDATE jobs
                    SET status = 'interrupted',
                        recovery_disposition = 'manual_confirmation_required',
                        updated_at = ?
                    WHERE job_id = ?
                    """,
                    (utc_now(), job_id),
                )
                _append_event(
                    connection,
                    job_id,
                    "job.interrupted",
                    {"automatic_replay": False},
                )
                interrupted.append(job_id)
            connection.execute("COMMIT")
        except BaseException:
            _rollback(connection)
            raise
    finally:
        connection.close()
    return {"interrupted_job_ids": interrupted, "replay_job_ids": []}


def _crash_before_commit(database_path: Path, job_id: str) -> None:
    connection = connect(database_path)
    connection.execute("BEGIN IMMEDIATE")
    now = utc_now()
    connection.execute(
        """
        INSERT INTO jobs (
            job_id, request_hash, status, write_started,
            recovery_disposition, created_at, updated_at
        ) VALUES (?, 'crash-request', 'queued', 0, NULL, ?, ?)
        """,
        (job_id, now, now),
    )
    _append_event(connection, job_id, "job.queued", {})
    os._exit(91)


def _commit_running_then_crash(database_path: Path, job_id: str) -> None:
    submit_job(database_path, job_id, "started-write-request")
    mark_running_with_write_started(database_path, job_id)
    os._exit(92)


def _hold_writer_lock(database_path: Path, ready_path: Path, seconds: float) -> None:
    connection = connect(database_path, timeout=0.0)
    connection.execute("BEGIN IMMEDIATE")
    ready_path.write_text("locked", encoding="utf-8")
    time.sleep(seconds)
    connection.execute("ROLLBACK")
    connection.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    crash_before = subparsers.add_parser("crash-before-commit")
    crash_before.add_argument("database", type=Path)
    crash_before.add_argument("job_id")

    crash_running = subparsers.add_parser("commit-running-then-crash")
    crash_running.add_argument("database", type=Path)
    crash_running.add_argument("job_id")

    hold_lock = subparsers.add_parser("hold-lock")
    hold_lock.add_argument("database", type=Path)
    hold_lock.add_argument("ready", type=Path)
    hold_lock.add_argument("seconds", type=float)

    args = parser.parse_args()
    if args.command == "crash-before-commit":
        _crash_before_commit(args.database, args.job_id)
    elif args.command == "commit-running-then-crash":
        _commit_running_then_crash(args.database, args.job_id)
    else:
        _hold_writer_lock(args.database, args.ready, args.seconds)


if __name__ == "__main__":
    main()
