"""SQLite development adapter. JSON payloads plus relational integrity, no spatial SQL."""
import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path

TABLES={'parcels','observations','analyses','risks','visits','verifications','events','photos','source_imports'}
SCHEMA='''
CREATE TABLE IF NOT EXISTS parcels (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, parcel_id TEXT NOT NULL REFERENCES parcels(id), source TEXT NOT NULL, source_record_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(parcel_id,source,source_record_id));
CREATE INDEX IF NOT EXISTS observations_parcel ON observations(parcel_id);
CREATE TABLE IF NOT EXISTS analyses (id TEXT PRIMARY KEY, parcel_id TEXT NOT NULL REFERENCES parcels(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS risks (id TEXT PRIMARY KEY, parcel_id TEXT NOT NULL REFERENCES parcels(id), observation_id TEXT NOT NULL REFERENCES observations(id), method TEXT NOT NULL, model_version TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(parcel_id,observation_id,method,model_version));
CREATE TABLE IF NOT EXISTS visits (id TEXT PRIMARY KEY, parcel_id TEXT NOT NULL REFERENCES parcels(id), risk_id TEXT REFERENCES risks(id), status TEXT NOT NULL, data TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_risk_visit ON visits(risk_id) WHERE status='pending' AND risk_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, visit_id TEXT NOT NULL REFERENCES visits(id), sha256 TEXT NOT NULL, blob BLOB NOT NULL, data TEXT NOT NULL, UNIQUE(visit_id,sha256));
CREATE TABLE IF NOT EXISTS verifications (id TEXT PRIMARY KEY, visit_id TEXT NOT NULL UNIQUE REFERENCES visits(id), parcel_id TEXT NOT NULL REFERENCES parcels(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, parcel_id TEXT NOT NULL REFERENCES parcels(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS source_imports (id TEXT PRIMARY KEY, data TEXT NOT NULL);
PRAGMA user_version=2;
'''

class SQLiteStore:
    def __init__(self,path):
        self.path=str(path)
        Path(path).parent.mkdir(parents=True,exist_ok=True)
        with self.connect() as c: c.executescript(SCHEMA)

    @contextmanager
    def connect(self,write=False):
        c=sqlite3.connect(self.path,timeout=10)
        c.row_factory=sqlite3.Row
        c.execute('PRAGMA foreign_keys=ON')
        c.execute('PRAGMA journal_mode=WAL')
        try:
            if write: c.execute('BEGIN IMMEDIATE')
            yield c
            c.commit()
        except Exception:
            c.rollback();raise
        finally: c.close()

    @staticmethod
    def get(c,table,entity_id):
        assert table in TABLES
        row=c.execute(f'SELECT data FROM {table} WHERE id=?',(entity_id,)).fetchone()
        return json.loads(row['data']) if row else None

    @staticmethod
    def all(c,table,parcel_id=None):
        assert table in TABLES
        sql=f'SELECT data FROM {table}'
        params=()
        if parcel_id is not None:
            assert table not in {'parcels','photos'}
            sql+=' WHERE parcel_id=?';params=(parcel_id,)
        return [json.loads(row['data']) for row in c.execute(sql,params).fetchall()]

    @staticmethod
    def insert(c,table,data,**indexed):
        assert table in TABLES
        fields={'id':data['id'],**indexed,'data':json.dumps(data,ensure_ascii=False,allow_nan=False)}
        c.execute(f'INSERT INTO {table} ({",".join(fields)}) VALUES ({",".join("?" for _ in fields)})',tuple(fields.values()))
        return data

    @staticmethod
    def update(c,table,data,**indexed):
        assert table in TABLES
        fields={**indexed,'data':json.dumps(data,ensure_ascii=False,allow_nan=False)}
        c.execute(f'UPDATE {table} SET {",".join(f"{f}=?" for f in fields)} WHERE id=?',(*fields.values(),data['id']))
