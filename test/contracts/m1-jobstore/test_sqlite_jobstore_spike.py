from __future__ import annotations

import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from sqlite_jobstore_spike import (
    EventSequenceError,
    append_job_event,
    connect,
    initialize_database,
    migrate_to_v2,
    recover_started_writes,
    submit_job,
)


HELPER = Path(__file__).with_name("sqlite_jobstore_spike.py")


class SqliteJobStoreSpikeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.database = Path(self.temporary_directory.name) / "jobstore.sqlite3"
        initialize_database(self.database)

    def run_worker(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(HELPER), *arguments],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )

    def test_single_writer_lock_rejects_competing_write_then_releases(self) -> None:
        ready = Path(self.temporary_directory.name) / "writer-ready"
        process = subprocess.Popen(
            [
                sys.executable,
                str(HELPER),
                "hold-lock",
                str(self.database),
                str(ready),
                "1.0",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.addCleanup(lambda: process.poll() is None and process.kill())

        deadline = time.monotonic() + 5
        while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(ready.exists(), "writer process did not acquire the lock")

        with self.assertRaisesRegex(sqlite3.OperationalError, "locked"):
            submit_job(
                self.database,
                "competing-job",
                "competing-request",
                timeout=0.05,
            )

        self.assertEqual(process.wait(timeout=5), 0)
        submit_job(self.database, "after-release", "after-release-request")

    def test_crash_before_commit_leaves_no_partial_job_or_event(self) -> None:
        result = self.run_worker(
            "crash-before-commit",
            str(self.database),
            "uncommitted-job",
        )
        self.assertEqual(result.returncode, 91, result.stderr)

        connection = connect(self.database)
        try:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 0)
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM job_events").fetchone()[0],
                0,
            )
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        finally:
            connection.close()

    def test_started_write_crash_requires_confirmation_and_never_auto_replays(self) -> None:
        result = self.run_worker(
            "commit-running-then-crash",
            str(self.database),
            "started-write-job",
        )
        self.assertEqual(result.returncode, 92, result.stderr)

        first_scan = recover_started_writes(self.database)
        second_scan = recover_started_writes(self.database)
        self.assertEqual(first_scan["interrupted_job_ids"], ["started-write-job"])
        self.assertEqual(first_scan["replay_job_ids"], [])
        self.assertEqual(second_scan, {"interrupted_job_ids": [], "replay_job_ids": []})

        connection = connect(self.database)
        try:
            job = connection.execute(
                """
                SELECT status, write_started, recovery_disposition
                FROM jobs WHERE job_id = 'started-write-job'
                """
            ).fetchone()
            self.assertEqual(tuple(job), ("interrupted", 1, "manual_confirmation_required"))
            events = connection.execute(
                """
                SELECT seq, event_type FROM job_events
                WHERE job_id = 'started-write-job' ORDER BY seq
                """
            ).fetchall()
            self.assertEqual(
                [tuple(event) for event in events],
                [
                    (0, "job.queued"),
                    (1, "job.write_started"),
                    (2, "job.interrupted"),
                ],
            )
        finally:
            connection.close()

    def test_failed_migration_rolls_back_schema_and_version(self) -> None:
        with self.assertRaisesRegex(sqlite3.OperationalError, "missing_migration_table"):
            migrate_to_v2(self.database, inject_failure=True)

        connection = connect(self.database)
        try:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 1)
            columns = {
                row["name"] for row in connection.execute("PRAGMA table_info(jobs)").fetchall()
            }
            self.assertNotIn("policy_snapshot", columns)
            index_names = {
                row["name"] for row in connection.execute("PRAGMA index_list(jobs)").fetchall()
            }
            self.assertNotIn("jobs_status_idx", index_names)
        finally:
            connection.close()

        migrate_to_v2(self.database)
        connection = connect(self.database)
        try:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 2)
            columns = {
                row["name"] for row in connection.execute("PRAGMA table_info(jobs)").fetchall()
            }
            self.assertIn("policy_snapshot", columns)
        finally:
            connection.close()

    def test_event_sequence_gap_is_rejected_without_partial_append(self) -> None:
        submit_job(self.database, "event-job", "event-request")
        with self.assertRaisesRegex(EventSequenceError, "next sequence is 1"):
            append_job_event(
                self.database,
                "event-job",
                "job.invalid_gap",
                expected_seq=2,
            )

        connection = connect(self.database)
        try:
            sequences = connection.execute(
                "SELECT seq FROM job_events WHERE job_id = 'event-job' ORDER BY seq"
            ).fetchall()
            self.assertEqual([row[0] for row in sequences], [0])
        finally:
            connection.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
