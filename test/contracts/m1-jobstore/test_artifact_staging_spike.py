from __future__ import annotations

import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from artifact_staging_spike import (
    ArtifactIntegrityError,
    cleanup_staging_orphan,
    publish_artifact,
    reconcile_receipt,
    scan_reconciliation,
    stage_artifact,
)


HELPER = Path(__file__).with_name("artifact_staging_spike.py")


class ArtifactStagingSpikeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name)

    def run_worker(self, command: str, size: int) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(HELPER), command, str(self.root), str(size)],
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
        )

    def test_staged_part_is_invisible_until_verified_atomic_publish(self) -> None:
        payload = b"complete-artifact" * 4096
        intent = stage_artifact(
            self.root,
            "job-1",
            "artifact-1",
            "artifacts/result.bin",
            payload,
        )
        final_path = self.root / "artifacts/result.bin"
        self.assertFalse(final_path.exists())
        self.assertEqual(len(list((self.root / ".staging").rglob("*.part"))), 1)

        result = publish_artifact(self.root, intent)
        self.assertEqual(result["status"], "published")
        self.assertEqual(final_path.read_bytes(), payload)
        self.assertEqual(list((self.root / ".staging").rglob("*.part")), [])

    def test_existing_final_is_never_overwritten(self) -> None:
        final_path = self.root / "artifacts/result.bin"
        final_path.parent.mkdir(parents=True)
        final_path.write_bytes(b"existing-user-bytes")
        intent = stage_artifact(
            self.root,
            "job-2",
            "artifact-2",
            "artifacts/result.bin",
            b"replacement-bytes",
        )

        result = publish_artifact(self.root, intent)
        self.assertEqual(result["status"], "conflict_existing")
        self.assertEqual(final_path.read_bytes(), b"existing-user-bytes")
        self.assertTrue(next((self.root / ".staging").rglob("*.part")).exists())

    def test_crash_before_publish_is_orphaned_and_cleanup_is_idempotent(self) -> None:
        result = self.run_worker("crash-before-publish", 128 * 1024)
        self.assertEqual(result.returncode, 91, result.stderr)
        self.assertFalse((self.root / "artifacts/output.bin").exists())

        scan = scan_reconciliation(self.root)
        self.assertEqual([entry["status"] for entry in scan], ["staging_orphan"])
        self.assertFalse(scan[0]["automatic_republish"])
        intent = next((self.root / ".staging").rglob("*.intent.json"))
        self.assertEqual(cleanup_staging_orphan(self.root, intent), "cleaned")
        self.assertEqual(cleanup_staging_orphan(self.root, intent), "cleaned")
        self.assertEqual(scan_reconciliation(self.root)[0]["status"], "cleaned")

    def test_crash_after_rename_requires_receipt_reconciliation_without_republish(self) -> None:
        result = self.run_worker("crash-after-rename", 192 * 1024)
        self.assertEqual(result.returncode, 92, result.stderr)
        final_path = self.root / "artifacts/output.bin"
        self.assertEqual(final_path.read_bytes(), b"x" * (192 * 1024))

        scan = scan_reconciliation(self.root)
        self.assertEqual([entry["status"] for entry in scan], ["receipt_required"])
        self.assertFalse(scan[0]["automatic_republish"])
        intent = next((self.root / ".staging").rglob("*.intent.json"))
        self.assertEqual(reconcile_receipt(self.root, intent), "published")
        self.assertEqual(reconcile_receipt(self.root, intent), "published")
        self.assertEqual(final_path.read_bytes(), b"x" * (192 * 1024))

    def test_final_path_never_exposes_partial_bytes_during_slow_publish(self) -> None:
        size = 512 * 1024
        process = subprocess.Popen(
            [sys.executable, str(HELPER), "slow-publish", str(self.root), str(size)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.addCleanup(lambda: process.poll() is None and process.kill())
        final_path = self.root / "artifacts/output.bin"
        observed_sizes: list[int] = []
        while process.poll() is None:
            if final_path.exists():
                observed_sizes.append(len(final_path.read_bytes()))
            time.sleep(0.005)
        self.assertEqual(process.returncode, 0)
        self.assertEqual(final_path.read_bytes(), b"x" * size)
        self.assertTrue(all(observed_size == size for observed_size in observed_sizes))

    def test_hash_or_size_mismatch_blocks_publish(self) -> None:
        intent = stage_artifact(
            self.root,
            "job-3",
            "artifact-3",
            "artifacts/result.bin",
            b"expected-bytes",
        )
        staging_path = next((self.root / ".staging").rglob("*.part"))
        staging_path.write_bytes(b"tampered")
        with self.assertRaises(ArtifactIntegrityError):
            publish_artifact(self.root, intent)
        self.assertFalse((self.root / "artifacts/result.bin").exists())

    def test_published_receipt_does_not_hide_later_integrity_conflict(self) -> None:
        intent = stage_artifact(
            self.root,
            "job-4",
            "artifact-4",
            "artifacts/result.bin",
            b"verified-before-publish",
        )
        self.assertEqual(publish_artifact(self.root, intent)["status"], "published")
        (self.root / "artifacts/result.bin").write_bytes(b"tampered-after-publish")

        scan = scan_reconciliation(self.root)
        self.assertEqual([entry["status"] for entry in scan], ["integrity_conflict"])
        self.assertFalse(scan[0]["automatic_republish"])

    def test_all_paths_are_contained_before_any_filesystem_write(self) -> None:
        cases = [
            ("job", "../../escape-job", "artifact", "artifacts/result.bin"),
            ("artifact", "job", "../../../escape-artifact", "artifacts/result.bin"),
            ("final", "job", "artifact", "../escape-final.bin"),
        ]
        for label, job_id, artifact_id, final_path in cases:
            with self.subTest(label=label):
                case_parent = self.root / label
                case_root = case_parent / "root"
                case_root.mkdir(parents=True)
                with self.assertRaises(ValueError):
                    stage_artifact(
                        case_root,
                        job_id,
                        artifact_id,
                        final_path,
                        b"must-not-be-written",
                    )
                self.assertFalse((case_root / ".staging").exists())
                self.assertEqual(
                    [path.name for path in case_parent.iterdir() if path.name != "root"],
                    [],
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
