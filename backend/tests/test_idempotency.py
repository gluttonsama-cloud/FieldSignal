"""Durable create retry guarantees through the real API and SQLite adapter."""
import json
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from threading import Barrier
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.adapters.storage import MIGRATIONS, SQLiteStore
from app.main import create_app


class LoseCommittedResponse:
    """Run the entire ASGI request, then drop its response before the client sees it."""
    def __init__(self,app):
        self.app=app
        self.messages=[]

    async def __call__(self,scope,receive,send):
        async def discard(message): self.messages.append(message)
        await self.app(scope,receive,discard)
        raise ConnectionResetError('committed response lost')

    def response(self):
        status=next(message['status'] for message in self.messages if message['type']=='http.response.start')
        body=b''.join(message.get('body',b'') for message in self.messages if message['type']=='http.response.body')
        return status,json.loads(body)


class IdempotencyTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db=Path(self.temp.name)/'retry.db'
        self.app=create_app(self.db,False)
        self.client=self.new_client(self.app)
        self.parcel_body={'name':'测试地块','season':'2019-2020','geometry':{'type':'Polygon','coordinates':[[[112.4,30.7],[112.402,30.7],[112.402,30.702],[112.4,30.702],[112.4,30.7]]]}}
        self.event_body={'occurred_on':'2020-03-01','kind':'drainage','note':'现场农事记录'}

    def new_client(self,app):
        client=TestClient(app)
        self.addCleanup(client.close)
        return client

    def post(self,url,body,key=None,client=None):
        headers={} if key is None else {'Idempotency-Key':key}
        return (client or self.client).post(url,json=body,headers=headers)

    def parcel(self):
        response=self.post('/api/v1/parcels',self.parcel_body)
        self.assertEqual(response.status_code,201,response.text)
        return response.json()['id']

    def visit_body(self,linked=False):
        if not linked: return {'parcel_id':self.parcel(),'due_date':'2020-03-01'}
        # Generate an actual candidate through the fixture/analysis API, on a
        # stable date with enough seasonal history regardless of the run date.
        with patch('app.application.service.datetime',wraps=datetime) as service_clock,patch('app.domain.detection.datetime',wraps=datetime) as detection_clock:
            service_clock.now.return_value=detection_clock.now.return_value=datetime(2020,3,1,tzinfo=timezone.utc)
            client=self.new_client(create_app(self.db,True))
            seed=self.post('/api/v1/dev/fixtures',{},client=client)
            self.assertEqual(seed.status_code,201,seed.text)
            parcel_id=seed.json()['parcel_id']
            run=self.post(f'/api/v1/parcels/{parcel_id}/analyses',{},client=client)
            self.assertEqual(run.status_code,201,run.text)
            self.assertEqual(run.json()['status'],'candidate')
        return {'parcel_id':parcel_id,'risk_id':run.json()['risk_id'],'due_date':'2020-03-01'}

    def count(self,table):
        with sqlite3.connect(self.db) as c:
            return c.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]

    def assert_conflict(self,response):
        self.assertEqual(response.status_code,409,response.text)
        self.assertEqual(response.json()['error']['code'],'idempotency_conflict')

    def assert_lost_response_retry(self,url,body,key,table):
        dropped=LoseCommittedResponse(self.app)
        with self.assertRaisesRegex(ConnectionResetError,'committed response lost'):
            self.post(url,body,key,self.new_client(dropped))
        self.assertEqual(self.count(table),1)
        self.assertEqual(self.count('idempotency_receipts'),1)
        status,original=dropped.response()
        self.assertEqual(status,201)
        # A fresh application/store proves the receipt is not process-local state.
        reopened=self.new_client(create_app(self.db,False))
        for client in [reopened,self.client,reopened]:
            response=self.post(url,body,key,client)
            self.assertEqual(response.status_code,status,response.text)
            self.assertEqual(response.json(),original)
        self.assertEqual(self.count(table),1)
        self.assertEqual(self.count('idempotency_receipts'),1)

    def test_parcel_committed_response_lost_retries_after_reopen(self):
        self.assert_lost_response_retry('/api/v1/parcels',self.parcel_body,'parcel-lost-response','parcels')

    def test_event_committed_response_lost_retries_after_reopen(self):
        url=f'/api/v1/parcels/{self.parcel()}/events'
        self.assert_lost_response_retry(url,self.event_body,'event-lost-response','events')

    def test_manual_visit_committed_response_lost_retries_after_reopen(self):
        self.assert_lost_response_retry('/api/v1/visits',self.visit_body(),'visit-lost-response','visits')

    def test_parcel_request_binding_uses_validated_defaults_and_sorted_json(self):
        first=self.post('/api/v1/parcels',self.parcel_body,'normalized-parcel')
        normalized={**self.parcel_body,'name':'  测试地块  ','region':'shayang','crop':'oilseed_rape','sowing_date':None,'cultivar':None,'boundary_source':'user_provided','boundary_reference':None}
        normalized['geometry']={'coordinates':self.parcel_body['geometry']['coordinates']}
        normalized=dict(reversed(list(normalized.items())))
        retry=self.post('/api/v1/parcels',normalized,'normalized-parcel')
        self.assertEqual(first.status_code,201,first.text)
        self.assertEqual(retry.status_code,201,retry.text)
        self.assertEqual(first.json(),retry.json())
        self.assertEqual(self.count('parcels'),1)

    def test_event_request_binding_uses_validated_text(self):
        url=f'/api/v1/parcels/{self.parcel()}/events'
        first=self.post(url,self.event_body,'normalized-event')
        retry=self.post(url,{'note':'  现场农事记录  ','kind':'drainage','occurred_on':'2020-03-01'},'normalized-event')
        self.assertEqual(first.status_code,201,first.text)
        self.assertEqual(retry.status_code,201,retry.text)
        self.assertEqual(first.json(),retry.json())

    def test_visit_request_binding_uses_validated_defaults_and_text(self):
        body={**self.visit_body(),'assignee':'张三','note':'日常巡田'}
        first=self.post('/api/v1/visits',body,'normalized-visit')
        retry=self.post('/api/v1/visits',dict(reversed(list({**body,'risk_id':None,'assignee':'  张三  ','note':'  日常巡田  '}.items()))),'normalized-visit')
        self.assertEqual(first.status_code,201,first.text)
        self.assertEqual(retry.status_code,201,retry.text)
        self.assertEqual(first.json(),retry.json())
        self.assertEqual(self.count('visits'),1)

    def test_visit_changed_target_risk_or_content_conflicts_before_validation(self):
        body=self.visit_body(linked=True)
        first=self.post('/api/v1/visits',body,'visit-content')
        self.assertEqual(first.status_code,201,first.text)
        for altered in [{'parcel_id':self.parcel()},{'parcel_id':'missing'},{'risk_id':None},{'risk_id':'missing'},{'due_date':'2020-03-02'},{'assignee':'张三'},{'note':'变更备注'}]:
            with self.subTest(altered=altered):
                self.assert_conflict(self.post('/api/v1/visits',{**body,**altered},'visit-content'))
        self.assertEqual(self.count('visits'),1)
        self.assertEqual(self.count('idempotency_receipts'),1)

    def test_linked_visit_replays_after_completion_and_preserves_no_key_guards(self):
        body=self.visit_body(linked=True)
        first=self.post('/api/v1/visits',body,'linked-visit')
        self.assertEqual(first.status_code,201,first.text)
        for key in [None,'different-visit']:
            duplicate=self.post('/api/v1/visits',body,key)
            self.assertEqual(duplicate.status_code,409,duplicate.text)
            self.assertEqual(duplicate.json()['error']['code'],'duplicate_visit')
        self.assertEqual(self.client.get('/api/v1/risks').json()[0]['status'],'assigned')
        verified=self.post(f"/api/v1/visits/{first.json()['id']}/verifications",{'observed_at':'2020-03-01T00:00:00Z','label':'uncertain','note':'测试核验'})
        self.assertEqual(verified.status_code,201,verified.text)
        reopened=self.new_client(create_app(self.db,False))
        retry=self.post('/api/v1/visits',body,'linked-visit',reopened)
        self.assertEqual(retry.status_code,201,retry.text)
        self.assertEqual(retry.json(),first.json())
        self.assertEqual(reopened.get('/api/v1/visits').json()[0]['status'],'completed')
        self.assertEqual(reopened.get('/api/v1/risks').json()[0]['status'],'verified')
        for key in [None,'different-visit']:
            rejected=self.post('/api/v1/visits',body,key)
            self.assertEqual(rejected.status_code,409,rejected.text)
            self.assertEqual(rejected.json()['error']['code'],'risk_verified')
        self.assertEqual(self.count('visits'),1)
        self.assertEqual(self.count('idempotency_receipts'),1)

    def test_changed_parcel_content_conflicts_but_new_key_allows_intentional_create(self):
        first=self.post('/api/v1/parcels',self.parcel_body,'parcel-content')
        self.assertEqual(first.status_code,201,first.text)
        self.assert_conflict(self.post('/api/v1/parcels',{**self.parcel_body,'name':'不同地块'},'parcel-content'))
        second=self.post('/api/v1/parcels',self.parcel_body,'another-parcel')
        self.assertEqual(second.status_code,201,second.text)
        self.assertNotEqual(first.json()['id'],second.json()['id'])
        self.assertEqual(self.count('parcels'),2)

    def test_changed_event_content_conflicts_but_new_key_allows_intentional_create(self):
        url=f'/api/v1/parcels/{self.parcel()}/events'
        first=self.post(url,self.event_body,'event-content')
        self.assertEqual(first.status_code,201,first.text)
        for altered in [{'note':'新内容'},{'kind':'other'},{'occurred_on':'2020-03-02'}]:
            self.assert_conflict(self.post(url,{**self.event_body,**altered},'event-content'))
        second=self.post(url,self.event_body,'another-event')
        self.assertEqual(second.status_code,201,second.text)
        self.assertNotEqual(first.json()['id'],second.json()['id'])
        self.assertEqual(self.count('events'),2)

    def test_key_is_global_and_bound_to_operation_and_target(self):
        first=self.post('/api/v1/parcels',self.parcel_body,'parcel-key')
        self.assertEqual(first.status_code,201,first.text)
        p1,p2=first.json()['id'],self.parcel()
        url=f'/api/v1/parcels/{p1}/events'
        self.assert_conflict(self.post(url,self.event_body,'parcel-key'))
        event=self.post(url,self.event_body,'event-key')
        self.assertEqual(event.status_code,201,event.text)
        self.assert_conflict(self.post('/api/v1/parcels',self.parcel_body,'event-key'))
        for target in [p2,'missing']:
            self.assert_conflict(self.post(f'/api/v1/parcels/{target}/events',self.event_body,'event-key'))
        visit_body={'parcel_id':p1,'due_date':'2020-03-01'}
        for key in ['parcel-key','event-key']:
            self.assert_conflict(self.post('/api/v1/visits',visit_body,key))
        self.assertEqual(self.post('/api/v1/visits',visit_body,'visit-key').status_code,201)
        self.assert_conflict(self.post('/api/v1/parcels',self.parcel_body,'visit-key'))
        self.assert_conflict(self.post(url,self.event_body,'visit-key'))
        self.assertEqual(self.count('parcels'),2)
        self.assertEqual(self.count('events'),1)
        self.assertEqual(self.count('visits'),1)
        self.assertEqual(self.count('idempotency_receipts'),3)

    def concurrent_posts(self,url,bodies,key):
        # Independent stores and connections, synchronized at the API boundary.
        clients=[self.new_client(create_app(self.db,False)) for _ in bodies]
        barrier=Barrier(len(bodies))
        def submit(args):
            client,body=args
            barrier.wait(timeout=10)
            return self.post(url,body,key,client)
        with ThreadPoolExecutor(max_workers=len(bodies)) as pool:
            return list(pool.map(submit,zip(clients,bodies)))

    def test_concurrent_parcel_retries_across_separate_stores_create_once(self):
        responses=self.concurrent_posts('/api/v1/parcels',[self.parcel_body]*6,'concurrent-parcel')
        self.assertEqual([r.status_code for r in responses],[201]*6)
        self.assertTrue(all(r.json()==responses[0].json() for r in responses))
        self.assertEqual(self.count('parcels'),1)
        self.assertEqual(self.count('idempotency_receipts'),1)

    def test_concurrent_event_retries_across_separate_stores_create_once(self):
        url=f'/api/v1/parcels/{self.parcel()}/events'
        responses=self.concurrent_posts(url,[self.event_body]*6,'concurrent-event')
        self.assertEqual([r.status_code for r in responses],[201]*6)
        self.assertTrue(all(r.json()==responses[0].json() for r in responses))
        self.assertEqual(self.count('events'),1)
        self.assertEqual(self.count('idempotency_receipts'),1)

    def test_concurrent_visit_retries_across_separate_stores_create_once(self):
        for linked in [False,True]:
            with self.subTest(linked=linked):
                body=self.visit_body(linked=linked)
                before=self.count('visits')
                receipts=self.count('idempotency_receipts')
                responses=self.concurrent_posts('/api/v1/visits',[body]*6,f'concurrent-visit-{linked}')
                self.assertEqual([r.status_code for r in responses],[201]*6)
                self.assertTrue(all(r.json()==responses[0].json() for r in responses))
                self.assertEqual(self.count('visits'),before+1)
                self.assertEqual(self.count('idempotency_receipts'),receipts+1)

    def test_concurrent_changed_payload_has_one_winner_and_one_conflict(self):
        for url,body,field,table in [('/api/v1/parcels',self.parcel_body,'name','parcels'),(f'/api/v1/parcels/{self.parcel()}/events',self.event_body,'note','events'),('/api/v1/visits',self.visit_body(),'note','visits')]:
            with self.subTest(table=table):
                before=self.count(table)
                responses=self.concurrent_posts(url,[body,{**body,field:'不同内容'}],f'racing-{table}')
                self.assertEqual(sorted(r.status_code for r in responses),[201,409])
                self.assert_conflict(next(r for r in responses if r.status_code==409))
                self.assertEqual(self.count(table),before+1)

    def test_failure_after_receipt_insert_rolls_back_both_record_and_receipt(self):
        store=self.app.state.service.store
        insert=store.insert_receipt
        def fail_after_receipt(*args):
            insert(*args)
            raise RuntimeError('injected failure after receipt write')
        for url,body,table in [('/api/v1/parcels',self.parcel_body,'parcels'),(f'/api/v1/parcels/{self.parcel()}/events',self.event_body,'events'),('/api/v1/visits',self.visit_body(linked=True),'visits')]:
            with self.subTest(table=table):
                before=self.count(table)
                receipts=self.count('idempotency_receipts')
                key=f'rollback-{table}'
                with patch.object(store,'insert_receipt',side_effect=fail_after_receipt):
                    with self.assertRaisesRegex(RuntimeError,'injected failure'):
                        self.post(url,body,key)
                self.assertEqual(self.count(table),before)
                self.assertEqual(self.count('idempotency_receipts'),receipts)
                if table=='visits': self.assertEqual(self.client.get('/api/v1/risks').json()[0]['status'],'open')
                retry=self.post(url,body,key,self.new_client(create_app(self.db,False)))
                self.assertEqual(retry.status_code,201,retry.text)
                self.assertEqual(self.count(table),before+1)
                self.assertEqual(self.count('idempotency_receipts'),receipts+1)
                if table=='visits': self.assertEqual(self.client.get('/api/v1/risks').json()[0]['status'],'assigned')

    def test_business_and_validation_failures_do_not_consume_key(self):
        p=self.parcel();url=f'/api/v1/parcels/{p}/events'
        missing=self.post('/api/v1/parcels/missing/events',self.event_body,'retry-failure')
        self.assertEqual(missing.status_code,404)
        outside=self.post(url,{**self.event_body,'occurred_on':'2018-01-01'},'retry-failure')
        self.assertEqual(outside.status_code,422)
        invalid=self.post(url,{**self.event_body,'note':''},'retry-failure')
        self.assertEqual(invalid.status_code,422)
        self.assertEqual(self.count('events'),0)
        self.assertEqual(self.count('idempotency_receipts'),0)
        self.assertEqual(self.post(url,self.event_body,'retry-failure').status_code,201)
        body=self.visit_body(linked=True)
        for altered,status in [({'parcel_id':'missing'},404),({'risk_id':'missing'},404),({'parcel_id':p},422),({'due_date':'invalid'},422)]:
            with self.subTest(altered=altered):
                response=self.post('/api/v1/visits',{**body,**altered},'retry-visit-failure')
                self.assertEqual(response.status_code,status,response.text)
        self.assertEqual(self.count('visits'),0)
        self.assertEqual(self.count('idempotency_receipts'),1)
        self.assertEqual(self.client.get('/api/v1/risks').json()[0]['status'],'open')
        self.assertEqual(self.post('/api/v1/visits',body,'retry-visit-failure').status_code,201)

    def test_no_header_preserves_create_each_time_behavior_without_receipts(self):
        first=self.post('/api/v1/parcels',self.parcel_body)
        second=self.post('/api/v1/parcels',self.parcel_body)
        self.assertEqual([first.status_code,second.status_code],[201,201])
        self.assertNotEqual(first.json()['id'],second.json()['id'])
        url=f"/api/v1/parcels/{first.json()['id']}/events"
        one,two=self.post(url,self.event_body),self.post(url,self.event_body)
        self.assertEqual([one.status_code,two.status_code],[201,201])
        self.assertNotEqual(one.json()['id'],two.json()['id'])
        # Planning dates may be outside a historic season; actual observation
        # dates remain subject to the separate verification season validation.
        visit_body={'parcel_id':first.json()['id'],'due_date':'2026-10-15'}
        one,two=self.post('/api/v1/visits',visit_body),self.post('/api/v1/visits',visit_body)
        self.assertEqual([one.status_code,two.status_code],[201,201])
        self.assertNotEqual(one.json()['id'],two.json()['id'])
        self.assertIsNone(one.json()['risk_id'])
        self.assertEqual(self.count('parcels'),2)
        self.assertEqual(self.count('events'),2)
        self.assertEqual(self.count('visits'),2)
        self.assertEqual(self.count('idempotency_receipts'),0)

    def test_keys_reject_empty_unsafe_oversized_or_duplicate_headers_without_writes(self):
        urls=[('/api/v1/parcels',self.parcel_body,'parcels'),(f'/api/v1/parcels/{self.parcel()}/events',self.event_body,'events'),('/api/v1/visits',self.visit_body(),'visits')]
        for url,body,table in urls:
            before=self.count(table)
            for key in ['', ' ', 'two words', 'a/b', 'a,b', 'a"b', 'a\nb', 'a\rb', 'a\tb', '\x00', 'x'*129]:
                with self.subTest(url=url,key=repr(key)):
                    response=self.post(url,body,key)
                    self.assertEqual(response.status_code,422,response.text)
                    self.assertEqual(response.json()['error']['code'],'invalid_idempotency_key')
            for headers in [[('Idempotency-Key','one'),('Idempotency-Key','two')],[(b'Idempotency-Key',b'\xff')]]:
                response=self.client.post(url,json=body,headers=headers)
                self.assertEqual(response.status_code,422,response.text)
                self.assertEqual(response.json()['error']['code'],'invalid_idempotency_key')
            self.assertEqual(self.count(table),before)
        self.assertEqual(self.count('idempotency_receipts'),0)

    def test_allowed_key_boundaries_are_case_sensitive(self):
        for key in ['a','A','x'*128,'parcel.2020_03:local-1']:
            response=self.post('/api/v1/parcels',self.parcel_body,key)
            self.assertEqual(response.status_code,201,response.text)
            self.assertEqual(self.post('/api/v1/parcels',self.parcel_body,key).json(),response.json())
        self.assertEqual(self.count('parcels'),4)


class SchemaMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db=Path(self.temp.name)/'schema.db'

    def make_v2(self):
        with sqlite3.connect(self.db) as c:
            c.executescript(MIGRATIONS[1]+MIGRATIONS[2])
            c.execute('PRAGMA user_version=2')
            c.execute('INSERT INTO parcels (id,data) VALUES (?,?)',('parcel_existing','{"id":"parcel_existing","name":"原有地块"}'))
            c.execute('INSERT INTO source_imports (id,data) VALUES (?,?)',('import_existing','{"id":"import_existing","note":"retain"}'))

    def test_v2_additive_migration_preserves_existing_rows_and_reopens(self):
        self.make_v2()
        with sqlite3.connect(self.db) as c:
            previous=c.execute('SELECT type,name,sql FROM sqlite_master ORDER BY name').fetchall()
        for _ in range(2):
            store=SQLiteStore(self.db)
            with store.connect() as c:
                self.assertEqual(c.execute('PRAGMA user_version').fetchone()[0],3)
                self.assertEqual(store.get(c,'parcels','parcel_existing')['name'],'原有地块')
                self.assertEqual(store.get(c,'source_imports','import_existing')['note'],'retain')
                self.assertEqual(c.execute('SELECT COUNT(*) FROM idempotency_receipts').fetchone()[0],0)
                current=[tuple(row) for row in c.execute("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE '%idempotency_receipts%' ORDER BY name")]
                self.assertEqual(current,previous)

    def test_new_database_and_older_known_schema_advance_to_v3(self):
        for version in [0,1]:
            path=Path(self.temp.name)/f'v{version}.db'
            if version:
                with sqlite3.connect(path) as c:
                    c.executescript(MIGRATIONS[1])
                    c.execute('PRAGMA user_version=1')
            store=SQLiteStore(path)
            with store.connect() as c:
                self.assertEqual(c.execute('PRAGMA user_version').fetchone()[0],3)
                self.assertEqual(c.execute('SELECT COUNT(*) FROM source_imports').fetchone()[0],0)
                self.assertEqual(c.execute('SELECT COUNT(*) FROM idempotency_receipts').fetchone()[0],0)

    def test_concurrent_initialization_and_v2_migration_are_serialized(self):
        self.make_v2()
        for path in [self.db,*(Path(self.temp.name)/f'fresh-{i}.db' for i in range(5))]:
            with self.subTest(path=path.name):
                barrier=Barrier(6)
                def initialize(_):
                    barrier.wait(timeout=10)
                    store=SQLiteStore(path)
                    with store.connect() as c:
                        return c.execute('PRAGMA user_version').fetchone()[0]
                with ThreadPoolExecutor(max_workers=6) as pool:
                    self.assertEqual(list(pool.map(initialize,range(6))),[3]*6)
        with sqlite3.connect(self.db) as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM parcels').fetchone()[0],1)

    def test_newer_schema_is_rejected_without_downgrading_or_creating_tables(self):
        with sqlite3.connect(self.db) as c:
            c.execute('PRAGMA user_version=4')
            c.execute('CREATE TABLE future_data (value TEXT)')
            c.execute("INSERT INTO future_data VALUES ('keep')")
        with self.assertRaisesRegex(RuntimeError,'Unsupported database schema version 4'):
            SQLiteStore(self.db)
        with sqlite3.connect(self.db) as c:
            self.assertEqual(c.execute('PRAGMA user_version').fetchone()[0],4)
            self.assertEqual(c.execute('SELECT value FROM future_data').fetchall(),[('keep',)])
            self.assertEqual(c.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall(),[('future_data',)])

    def test_failed_migration_rolls_back_schema_and_version(self):
        self.make_v2()
        with patch.dict(MIGRATIONS,{3:'CREATE TABLE partial_migration (id TEXT); INVALID SQL;'}):
            with self.assertRaises(sqlite3.OperationalError): SQLiteStore(self.db)
        with sqlite3.connect(self.db) as c:
            self.assertEqual(c.execute('PRAGMA user_version').fetchone()[0],2)
            self.assertIsNone(c.execute("SELECT name FROM sqlite_master WHERE name='partial_migration'").fetchone())
            self.assertEqual(c.execute('SELECT COUNT(*) FROM parcels').fetchone()[0],1)
        SQLiteStore(self.db)
        with sqlite3.connect(self.db) as c:
            self.assertEqual(c.execute('PRAGMA user_version').fetchone()[0],3)


if __name__=='__main__': unittest.main()
