"""Synthetic SQLite files only: no running/default application database."""
from contextlib import closing
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from app.adapters.storage import SQLiteStore

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts' / 'backup-local.py'
spec = importlib.util.spec_from_file_location('backup_local', SCRIPT)
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class BackupTests(unittest.TestCase):
    def test_wal_snapshot_preserves_all_tables_photo_bytes_and_receipts_as_a_standalone_file(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); source = root / 'synthetic.sqlite3'; target = root / 'snapshot.sqlite3'
            SQLiteStore(source)
            with closing(sqlite3.connect(source)) as writer:
                writer.execute('PRAGMA foreign_keys=ON'); writer.execute('PRAGMA wal_autocheckpoint=0')
                writer.execute('INSERT INTO parcels VALUES (?,?)', ('p1', json.dumps({'id': 'p1', 'name': '合成地块'})))
                writer.execute('INSERT INTO visits VALUES (?,?,?,?,?)', ('v1', 'p1', None, 'completed', '{}'))
                photo = b'synthetic-photo-\x00\xff-bytes'
                writer.execute('INSERT INTO photos VALUES (?,?,?,?,?)', ('photo1', 'v1', hashlib.sha256(photo).hexdigest(), photo, '{}'))
                writer.execute('INSERT INTO verifications VALUES (?,?,?,?)', ('record1', 'v1', 'p1', '{"note":"synthetic"}'))
                writer.execute('INSERT INTO idempotency_receipts VALUES (?,?,?,?,?)', ('key1', 'create_visit', 'p1', '{}', '{"id":"v1"}'))
                writer.commit()
                wal = Path(str(source) + '-wal'); self.assertGreater(wal.stat().st_size, 0)
                before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in (source, wal)}
                expected = {name: writer.execute(f'SELECT * FROM {name} ORDER BY 1').fetchall() for name, in writer.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                digest = backup.backup_database(source, target)
                self.assertEqual(digest, hashlib.sha256(target.read_bytes()).hexdigest())
                self.assertEqual(before, {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in before})
                independent = root / 'independent'; independent.mkdir(); moved = independent / 'copy.sqlite3'; target.rename(moved)
                with closing(sqlite3.connect(moved.as_uri() + '?mode=ro', uri=True)) as restored:
                    self.assertEqual(restored.execute('PRAGMA integrity_check').fetchall(), [('ok',)])
                    self.assertEqual(restored.execute('PRAGMA foreign_key_check').fetchall(), [])
                    self.assertEqual(restored.execute('PRAGMA user_version').fetchone()[0], 3)
                    for table, rows in expected.items(): self.assertEqual(restored.execute(f'SELECT * FROM {table} ORDER BY 1').fetchall(), rows)
                    self.assertEqual(restored.execute('SELECT blob FROM photos').fetchone()[0], photo)
                self.assertEqual(list(independent.iterdir()), [moved])
                if os.name == 'posix': self.assertEqual(moved.stat().st_mode & 0o777, 0o600)
                # A write committed after the read transaction starts must not
                # split its event and matching receipt across snapshot versions.
                connect = sqlite3.connect
                class SourceConnection(sqlite3.Connection):
                    def backup(self, *args, **kwargs):
                        writer.execute('INSERT INTO events VALUES (?,?,?)', ('later-event', 'p1', '{}'))
                        writer.execute('INSERT INTO idempotency_receipts VALUES (?,?,?,?,?)', ('later-key', 'add_event', 'p1', '{}', '{}'))
                        writer.commit()
                        return super().backup(*args, **kwargs)
                def connecting(database, **kwargs):
                    if database == source.as_uri() + '?mode=ro': kwargs['factory'] = SourceConnection
                    return connect(database, **kwargs)
                second = root / 'concurrent.sqlite3'
                with patch.object(backup.sqlite3, 'connect', side_effect=connecting): backup.backup_database(source, second)
                with closing(connect(second)) as snapshot:
                    self.assertEqual(snapshot.execute('SELECT COUNT(*) FROM events').fetchone()[0], 0)
                    self.assertEqual(snapshot.execute('SELECT COUNT(*) FROM idempotency_receipts').fetchone()[0], 1)
                self.assertEqual(writer.execute('SELECT COUNT(*) FROM events').fetchone()[0], 1)
                self.assertEqual(writer.execute('SELECT COUNT(*) FROM idempotency_receipts').fetchone()[0], 2)

    def test_refusals_and_publish_failure_preserve_existing_files_and_leave_no_partial_target(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); source = root / 'source.sqlite3'; target = root / 'target.sqlite3'; SQLiteStore(source)
            for suffix in ('', '-wal', '-shm', '-journal'):
                existing = Path(str(target) + suffix); existing.write_bytes(b'existing must remain')
                with self.subTest(suffix=suffix), self.assertRaises(FileExistsError): backup.backup_database(source, target)
                self.assertEqual(existing.read_bytes(), b'existing must remain'); existing.unlink()
            target.symlink_to(root / 'absent.sqlite3')
            with self.assertRaises(FileExistsError): backup.backup_database(source, target)
            self.assertTrue(target.is_symlink()); target.unlink()
            bad = root / 'bad.sqlite3'; bad.write_bytes(b'not a database')
            for invalid in [root / 'missing.sqlite3', bad]:
                with self.subTest(source=invalid), self.assertRaises((OSError, sqlite3.Error)): backup.backup_database(invalid, target)
                self.assertFalse(target.exists())
            with self.assertRaises(ValueError): backup.backup_database(source, root / 'unsafe.backup')
            with patch.object(backup.time, 'monotonic', side_effect=[0, 100]):
                with self.assertRaises(TimeoutError): backup.backup_database(source, target, timeout=1)
            def competing_target(_temporary, destination):
                Path(destination).write_bytes(b'created by another process')
                raise FileExistsError('target appeared')
            with patch.object(backup.os, 'link', side_effect=competing_target):
                with self.assertRaises(FileExistsError): backup.backup_database(source, target)
            self.assertEqual(target.read_bytes(), b'created by another process')
            self.assertEqual(list(root.glob('.fieldsignal-backup-*')), [])
            result = subprocess.run([sys.executable, str(SCRIPT), '--database', str(source), '--output', str(target)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1); self.assertNotIn('已生成', result.stdout); self.assertIn('备份未完成', result.stderr)
