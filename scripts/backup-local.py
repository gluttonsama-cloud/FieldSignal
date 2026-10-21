#!/usr/bin/env python3
"""Explicit local SQLite backup; no upload, restore, migration or overwrite."""
import argparse
from contextlib import closing
import hashlib
import math
import os
from pathlib import Path
import sqlite3
import tempfile
import time


def backup_database(database: Path, output: Path, timeout: float = 30) -> str:
    source = database.expanduser().resolve(strict=True)
    target = output.expanduser().absolute()
    if not source.is_file():
        raise ValueError('源数据库须为现有文件。')
    if target.suffix != '.sqlite3':
        raise ValueError('备份文件须使用 .sqlite3 后缀，以免被源码打包或提交。')
    def require_new_target():
        for candidate in [target, *(Path(str(target) + suffix) for suffix in ('-wal', '-shm', '-journal'))]:
            if candidate.exists() or candidate.is_symlink():
                raise FileExistsError('目标或其 SQLite 侧文件已存在；请指定新的文件名，不会覆盖任何已有文件。')

    require_new_target()
    if not target.parent.is_dir():
        raise ValueError('目标目录不存在；请先选择或建立私有备份目录。')
    if not math.isfinite(timeout) or not 0 < timeout <= 3600:
        raise ValueError('timeout 须大于 0 且不超过 3600 秒。')
    deadline = time.monotonic() + timeout

    def progress(_status, _remaining, _total):
        if time.monotonic() >= deadline:
            raise TimeoutError('备份超时，未发布目标；请稍后重试或增加 --timeout。')

    # Keep WAL-visible committed data. immutable=1 would ignore a live WAL.
    # Read-only database access can still use/create SQLite's shared-memory side file.
    with tempfile.TemporaryDirectory(prefix='.fieldsignal-backup-', dir=target.parent) as folder:
        temporary = Path(folder) / 'snapshot.sqlite3'
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=min(timeout, 5))) as src:
            src.execute('PRAGMA query_only=ON')
            src.execute('BEGIN')
            tables = {row[0] for row in src.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {'parcels', 'visits', 'verifications', 'photos'} <= tables:
                raise ValueError('未识别为 FieldSignal 数据库，未创建备份。')
            with closing(sqlite3.connect(temporary)) as dest:
                src.backup(dest, pages=128, progress=progress, sleep=.05)
                dest.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
                if dest.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise ValueError('备份完整性检查未通过，未发布目标。')
                if dest.execute('PRAGMA foreign_key_check').fetchone() is not None:
                    raise ValueError('备份关联检查未通过，未发布目标。')
                if dest.execute('PRAGMA journal_mode=DELETE').fetchone()[0] != 'delete':
                    raise ValueError('未能生成独立单文件备份，未发布目标。')
                dest.commit()
        with closing(sqlite3.connect(temporary.as_uri() + '?mode=ro', uri=True)) as verified:
            verified.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
            if verified.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
                raise ValueError('备份关闭后重新读取失败，未发布目标。')
        with temporary.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            os.fsync(stream.fileno())
        # Same-filesystem hard link publishes only a completed file. Unlike
        # replace/rename, it atomically fails if another file now owns this name.
        require_new_target()
        os.link(temporary, target)
    return digest


def main():
    parser = argparse.ArgumentParser(description='将现有 FieldSignal 服务端数据库备份到新的本机 .sqlite3 文件；不会覆盖、恢复或外传。')
    parser.add_argument('--database', type=Path, required=True, help='实际运行数据库路径；不会自动寻找或创建源库')
    parser.add_argument('--output', type=Path, required=True, help='现有私有目录中的新 .sqlite3 文件')
    parser.add_argument('--timeout', type=float, default=30, help='复制/检查超时预算，默认 30 秒；持续占用时可稍后重试')
    args = parser.parse_args()
    try:
        digest = backup_database(args.database, args.output, args.timeout)
    except (OSError, ValueError, sqlite3.Error) as error:
        parser.exit(1, f'备份未完成：{error}\n')
    print(f'已生成服务端数据库备份：{args.output}\nSHA-256：{digest}\n包含服务端照片；不含浏览器未提交草稿和原始导入文件。文件未加密，请勿上传代码仓库或发给未授权人员。')


if __name__ == '__main__':
    main()
