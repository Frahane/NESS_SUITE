import importlib
import io
import json
import os
import sqlite3
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, closing
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier
from unittest.mock import patch

from werkzeug.test import Client


REPORT = b"Synthetic report\n"
SECOND_REPORT = b"Second synthetic file\n"


class BurnSingleDownloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        stack = ExitStack()
        cls.addClassCleanup(stack.close)
        cls.root = Path(stack.enter_context(TemporaryDirectory()))
        cls.db_path = cls.root / "ness.sqlite"
        stack.enter_context(patch.dict(os.environ, {
            "DB_PATH": str(cls.db_path),
            "BURN_STORAGE_DIR": str(cls.root / "burn"),
            "BURN_MAX_DL_FREE": "1",
            "STORAGE_DIR": str(cls.root / "storage"),
            "STORAGE_BACKEND": "local",
        }))
        cls.suite = importlib.import_module("app")
        cls.suite.init_db()
        cls.client_sequence = 0

    def setUp(self):
        type(self).client_sequence += 1
        self.ip = f"192.0.2.{self.client_sequence}"
        self.client = Client(self.suite.app)
        response = self.client.post("/api/burn/create", data={
            "plan": "free",
            "file": (io.BytesIO(REPORT), "report.txt"),
            "allow_view": "0",
        }, environ_overrides={"REMOTE_ADDR": self.ip})
        self.assertEqual(response.status_code, 200)
        self.token = response.json["token"]
        self.file_url = f"/api/burn/{self.token}/file/0"
        self.file_path = self.root / "burn" / self.token / "report.txt"

    def test_only_one_concurrent_request_receives_the_file(self):
        file_checked = Barrier(2, timeout=5)
        file_read = Barrier(2, timeout=5)
        is_file = Path.is_file
        read_bytes = Path.read_bytes

        def synchronized_is_file(path):
            result = is_file(path)
            if path == self.file_path:
                file_checked.wait()
            return result

        def synchronized_read(path):
            data = read_bytes(path)
            if path == self.file_path:
                file_read.wait()
            return data

        def download():
            return Client(self.suite.app).get(self.file_url)

        with ExitStack() as stack:
            stack.enter_context(patch.object(Path, "is_file", synchronized_is_file))
            stack.enter_context(patch.object(Path, "read_bytes", synchronized_read))
            pool = stack.enter_context(ThreadPoolExecutor(max_workers=2))
            requests = [pool.submit(download) for _ in range(2)]
            responses = [request.result(timeout=10) for request in requests]

        statuses = sorted(response.status_code for response in responses)
        self.assertEqual(statuses, [200, 410])
        self.assertEqual(next(r.data for r in responses if r.status_code == 200), REPORT)
        self.assertFalse(self.file_path.exists())

    def test_failed_read_leaves_download_available(self):
        with patch.object(Path, "read_bytes", side_effect=FileNotFoundError):
            self.assertEqual(self.client.get(self.file_url).status_code, 404)

        response = self.client.get(self.file_url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, REPORT)

    def test_failed_removal_is_retried_without_reopening_access(self):
        with patch.object(self.suite.burn_product.shutil, "rmtree"):
            self.assertEqual(self.client.get(self.file_url).status_code, 200)

        self.assertTrue(self.file_path.exists())
        self.assertEqual(self.client.get(self.file_url).status_code, 404)

        self.suite.burn_product.cleanup_burn_expired()

        self.assertFalse(self.file_path.exists())
        with sqlite3.connect(self.db_path) as db:
            row = db.execute(
                "SELECT status, download_count, files_json FROM burn_drops WHERE public_token = ?",
                (self.token,),
            ).fetchone()
        self.assertEqual(row, ("burned", 1, "[]"))

    def _set_quota(self, limit, used=0):
        with closing(sqlite3.connect(self.db_path)) as db:
            db.execute(
                "UPDATE burn_drops SET max_downloads = ?, download_count = ?, burn_after = 0 WHERE public_token = ?",
                (limit, used, self.token),
            )
            db.commit()

    def _row(self):
        with closing(sqlite3.connect(self.db_path)) as db:
            db.row_factory = sqlite3.Row
            return db.execute(
                "SELECT * FROM burn_drops WHERE public_token = ?", (self.token,)
            ).fetchone()

    def _unlock(self):
        response = self.client.post(
            f"/api/burn/{self.token}/unlock",
            environ_overrides={"REMOTE_ADDR": self.ip},
        )
        self.assertEqual(response.status_code, 200)
        return response.json["view_token"]

    def _add_pack_file(self):
        other = self.file_path.with_name("second.txt")
        other.write_bytes(SECOND_REPORT)
        row = self._row()
        files = json.loads(row["files_json"])
        files.append({"filename": "second.txt", "size": len(SECOND_REPORT), "content_type": "text/plain"})
        with closing(sqlite3.connect(self.db_path)) as db:
            db.execute("UPDATE burn_drops SET files_json = ? WHERE id = ?", (json.dumps(files), row["id"]))
            db.commit()
        return other

    def _parallel_downloads(self, sessions):
        files_read = Barrier(len(sessions), timeout=5)
        read_bytes = Path.read_bytes

        def synchronized_read(path):
            data = read_bytes(path)
            if path == self.file_path:
                files_read.wait()
            return data

        def download(session):
            return Client(self.suite.app).get(
                self.file_url,
                query_string={"view_token": session},
                environ_overrides={"REMOTE_ADDR": self.ip},
            )

        with ExitStack() as stack:
            stack.enter_context(patch.object(Path, "read_bytes", synchronized_read))
            pool = stack.enter_context(ThreadPoolExecutor(max_workers=len(sessions)))
            futures = [pool.submit(download, session) for session in sessions]
            return [future.result(timeout=10) for future in futures]

    def test_independent_sessions_increment_from_the_current_database_value(self):
        self._set_quota(3)
        sessions = [self._unlock(), self._unlock()]
        responses = self._parallel_downloads(sessions)
        self.assertEqual([response.status_code for response in responses], [200, 200])
        self.assertEqual(self._row()["download_count"], 2)
        self.assertTrue(self.file_path.exists())

    def test_independent_sessions_cannot_both_claim_the_last_unit(self):
        self._set_quota(3, used=2)
        responses = self._parallel_downloads([self._unlock(), self._unlock()])
        self.assertEqual(sorted(response.status_code for response in responses), [200, 410])
        row = self._row()
        self.assertEqual(row["download_count"], 3)
        self.assertEqual(row["status"], "burned")

    def test_parallel_files_in_one_session_consume_one_unit(self):
        self._set_quota(3)
        session = self._unlock()
        responses = self._parallel_downloads([session, session])
        self.assertEqual([response.status_code for response in responses], [200, 200])
        self.assertEqual(self._row()["download_count"], 1)

    def test_two_distinct_files_in_one_session_consume_one_unit(self):
        self._set_quota(3)
        self._add_pack_file()
        session = self._unlock()
        for index in range(2):
            response = self.client.get(
                f"/api/burn/{self.token}/file/{index}", query_string={"view_token": session}
            )
            self.assertEqual(response.status_code, 200)
        self.assertEqual(self._row()["download_count"], 1)


    def test_last_unit_session_finishes_multi_file_pack(self):
        """Only the final session can finish, even after periodic cleanup runs."""
        self._set_quota(2)
        other = self._add_pack_file()
        earlier, session, uncharged = self._unlock(), self._unlock(), self._unlock()
        for view_token in (earlier, session):
            response = self.client.post(self.file_url, data={"view_token": view_token})
            self.assertEqual((response.status_code, response.data), (200, REPORT))

        self.assertEqual(self._row()["download_count"], 2)
        self.assertEqual(self._row()["status"], "burned")
        self.suite.burn_product.cleanup_burn_expired()
        self.assertTrue(self.file_path.exists())
        second_url = f"/api/burn/{self.token}/file/1"
        for view_token in (earlier, uncharged, "unissued-token", ""):
            response = self.client.post(second_url, data={"view_token": view_token})
            self.assertEqual(response.status_code, 404)
        self.assertEqual(self.client.post(f"/api/burn/{self.token}/unlock").status_code, 404)
        response = self.client.post(second_url, data={"view_token": session})
        self.assertEqual((response.status_code, response.data), (200, SECOND_REPORT))
        self.assertEqual(self._row()["download_count"], 2)

        self.suite.burn_product._VIEW_SESSIONS[session]["exp"] = 0
        self.assertEqual(self.client.post(second_url, data={"view_token": session}).status_code, 404)
        self.suite.burn_product.cleanup_burn_expired()
        self.assertFalse(self.file_path.exists())
        self.assertFalse(other.exists())

    def test_missing_or_invalid_session_preserves_the_final_pack_unit(self):
        self._set_quota(1)
        other = self._add_pack_file()
        for view_token in ("", "unissued-token"):
            with self.subTest(view_token=view_token):
                denied = self.client.get(self.file_url, query_string={"view_token": view_token})
                self.assertEqual(denied.status_code, 403)
                self.assertIn("start a download session", denied.json["error"])
                row = self._row()
                self.assertEqual((row["download_count"], row["status"]), (0, "active"))
                self.assertTrue(self.file_path.exists())
                self.assertTrue(other.exists())

        session = self._unlock()
        for index, data in enumerate((REPORT, SECOND_REPORT)):
            response = self.client.post(
                f"/api/burn/{self.token}/file/{index}", data={"view_token": session}
            )
            self.assertEqual((response.status_code, response.data), (200, data))
        self.assertEqual(self._row()["download_count"], 1)

    def test_tokenless_pack_claim_rechecks_quota_after_a_concurrent_claim(self):
        self._set_quota(3)
        self._add_pack_file()
        initial = self.client.get(self.file_url, environ_overrides={"REMOTE_ADDR": self.ip})
        self.assertEqual(initial.status_code, 200)
        self.assertEqual(self._row()["download_count"], 1)

        session = self._unlock()
        second_url = f"/api/burn/{self.token}/file/1"
        read_bytes = Path.read_bytes

        def read_during_charge(path):
            data = read_bytes(path)
            if path == self.file_path:
                with ThreadPoolExecutor(max_workers=1) as pool:
                    claim = pool.submit(
                        Client(self.suite.app).post, second_url, data={"view_token": session}
                    ).result(timeout=5)
                self.assertEqual((claim.status_code, claim.data), (200, SECOND_REPORT))
            return data

        with patch.object(Path, "read_bytes", read_during_charge):
            denied = self.client.get(
                self.file_url, environ_overrides={"REMOTE_ADDR": "198.51.100.1"}
            )
        self.assertEqual(denied.status_code, 403)
        row = self._row()
        self.assertEqual((row["download_count"], row["status"]), (2, "active"))
        coalesced = self.client.get(second_url, environ_overrides={"REMOTE_ADDR": self.ip})
        self.assertEqual((coalesced.status_code, coalesced.data), (200, SECOND_REPORT))
        self.assertEqual(self._row()["download_count"], 2)

    def test_passwordless_client_bursts_keep_the_existing_coalescing_rule(self):
        self._set_quota(3)
        for _ in range(2):
            response = self.client.get(self.file_url, environ_overrides={"REMOTE_ADDR": self.ip})
            self.assertEqual(response.status_code, 200)
        self.assertEqual(self._row()["download_count"], 1)
        response = self.client.get(self.file_url, environ_overrides={"REMOTE_ADDR": "198.51.100.1"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._row()["download_count"], 2)

    def test_failed_multi_file_read_does_not_charge_the_session(self):
        self._set_quota(3)
        session = self._unlock()
        with patch.object(Path, "read_bytes", side_effect=FileNotFoundError):
            response = self.client.get(self.file_url, query_string={"view_token": session})
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self._row()["download_count"], 0)
        self.assertFalse(self.suite.burn_product._VIEW_SESSIONS[session]["dl_charged"])
        self.assertEqual(self.client.get(self.file_url, query_string={"view_token": session}).status_code, 200)
        self.assertEqual(self._row()["download_count"], 1)

    def test_failed_commit_rolls_back_before_marking_a_session_charged(self):
        self._set_quota(3)
        session = self._unlock()
        burn = self.suite.burn_product
        observed_markers = []
        with closing(sqlite3.connect(self.db_path)) as db:
            db.row_factory = sqlite3.Row
            row = db.execute("SELECT * FROM burn_drops WHERE public_token = ?", (self.token,)).fetchone()

            class FailedCommit:
                def execute(self, *args):
                    return db.execute(*args)

                def rollback(self):
                    return db.rollback()

                def commit(self):
                    observed_markers.append(burn._VIEW_SESSIONS[session]["dl_charged"])
                    raise sqlite3.OperationalError("Synthetic commit failure")

            with self.assertRaises(sqlite3.OperationalError):
                burn._charge_download_once(FailedCommit(), row, session, self.token)
            self.assertEqual(observed_markers, [False])
            self.assertEqual(db.execute("SELECT download_count FROM burn_drops WHERE id = ?", (row["id"],)).fetchone()[0], 0)
            self.assertFalse(burn._VIEW_SESSIONS[session]["dl_charged"])
            self.assertEqual(burn._charge_download_once(db, row, session, self.token), (1, False))

    def test_rejected_claim_keeps_the_session_uncharged(self):
        self._set_quota(3)
        session = self._unlock()
        row = self._row()
        self._set_quota(3, used=3)
        with closing(sqlite3.connect(self.db_path)) as db:
            db.row_factory = sqlite3.Row
            result = self.suite.burn_product._charge_download_once(db, row, session, self.token)
        self.assertEqual(result, (None, False))
        self.assertEqual(self._row()["download_count"], 3)
        self.assertFalse(self.suite.burn_product._VIEW_SESSIONS[session]["dl_charged"])

    def _invalidate_during_read(self, column, value, session):
        read_bytes = Path.read_bytes

        def invalidate(path):
            data = read_bytes(path)
            if path == self.file_path:
                with closing(sqlite3.connect(self.db_path)) as db:
                    if column == "expires_at":
                        db.execute("UPDATE burn_drops SET expires_at = ? WHERE public_token = ?", (value, self.token))
                    else:
                        db.execute("UPDATE burn_drops SET status = ? WHERE public_token = ?", (value, self.token))
                    db.commit()
            return data

        with patch.object(Path, "read_bytes", invalidate):
            return self.client.get(self.file_url, query_string={"view_token": session})

    def test_expiry_after_file_read_prevents_a_new_claim(self):
        self._set_quota(3)
        response = self._invalidate_during_read("expires_at", "2000-01-01T00:00:00+00:00", self._unlock())
        self.assertEqual(response.status_code, 410)
        self.assertEqual(self._row()["download_count"], 0)

    def test_status_change_after_file_read_prevents_a_new_claim(self):
        self._set_quota(3)
        response = self._invalidate_during_read("status", "burned", self._unlock())
        self.assertEqual(response.status_code, 410)
        self.assertEqual(self._row()["download_count"], 0)

    def test_already_charged_session_rechecks_availability_after_file_read(self):
        self._set_quota(3)
        session = self._unlock()
        self.assertEqual(self.client.get(self.file_url, query_string={"view_token": session}).status_code, 200)
        response = self._invalidate_during_read("status", "burned", session)
        self.assertEqual(response.status_code, 410)
        self.assertEqual(self._row()["download_count"], 1)

    def test_exhaustion_preserves_current_immediate_destruction_policy(self):
        self._set_quota(3, used=2)
        session = self._unlock()
        self.assertEqual(self.client.get(self.file_url, query_string={"view_token": session}).status_code, 200)
        self.assertFalse(self.file_path.exists())
        self.assertEqual(self.client.get(self.file_url, query_string={"view_token": session}).status_code, 404)


    def test_last_claim_is_closed_before_filesystem_cleanup(self):
        self._set_quota(3, used=2)
        session = self._unlock()
        row = self._row()
        with closing(sqlite3.connect(self.db_path)) as db:
            db.row_factory = sqlite3.Row
            self.assertEqual(self.suite.burn_product._charge_download_once(db, row, session, self.token), (3, True))
        self.assertEqual(self._row()["status"], "burned")
        self.assertTrue(self.file_path.exists())
        self.suite.burn_product.cleanup_burn_expired()
        self.assertFalse(self.file_path.exists())
        self.assertEqual(self._row()["files_json"], "[]")


    def test_passwordless_window_can_charge_again_after_expiry(self):
        self._set_quota(3)
        self.assertEqual(self.client.get(self.file_url, environ_overrides={"REMOTE_ADDR": self.ip}).status_code, 200)
        key = f"anon-dl:{self.token}:{self.ip}"
        self.suite.burn_product._VIEW_SESSIONS[key]["exp"] = 0
        self.assertEqual(self.client.get(self.file_url, environ_overrides={"REMOTE_ADDR": self.ip}).status_code, 200)
        self.assertEqual(self._row()["download_count"], 2)

    def test_failed_passwordless_commit_does_not_publish_a_charged_marker(self):
        self._set_quota(3)
        burn = self.suite.burn_product
        key = f"anon-dl:{self.token}:{self.ip}"
        with self.suite.app.test_request_context(self.file_url, environ_overrides={"REMOTE_ADDR": self.ip}):
            with closing(sqlite3.connect(self.db_path)) as db:
                db.row_factory = sqlite3.Row
                row = db.execute("SELECT * FROM burn_drops WHERE public_token = ?", (self.token,)).fetchone()

                class FailedCommit:
                    def execute(self, *args):
                        return db.execute(*args)

                    def rollback(self):
                        return db.rollback()

                    def commit(self):
                        raise sqlite3.OperationalError("Synthetic passwordless commit failure")

                with self.assertRaises(sqlite3.OperationalError):
                    burn._charge_download_once(FailedCommit(), row, "", self.token)
                self.assertNotIn(key, burn._VIEW_SESSIONS)
                self.assertEqual(db.execute("SELECT download_count FROM burn_drops WHERE id = ?", (row["id"],)).fetchone()[0], 0)
                self.assertEqual(burn._charge_download_once(db, row, "", self.token), (1, False))
                self.assertTrue(burn._VIEW_SESSIONS[key]["dl_charged"])



if __name__ == "__main__":
    unittest.main()
