"""Synthetic, local-only regressions for source-linked manual follow-up visits."""
import io
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from threading import Barrier
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError

from app.adapters.storage import SQLiteStore
from app.application.service import FieldService, ServiceError
from app.domain.models import FollowUpVisitCreate, VisitCreate
from app.main import create_app


class FollowUpVisitTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db=Path(self.temp.name)/'synthetic-follow-ups.sqlite3'
        self.app=create_app(self.db,True)
        self.service=self.app.state.service
        self.store=self.service.store
        self.client=self.new_client(self.app)
        self.parcel=self.new_parcel('合成地块')
        self.original,self.source=self.saved_verification(self.parcel['id'])
        self.body={'due_date':'2020-03-02','assignee':'合成执行人','note':'人工安排复查，不代表诊断'}

    def new_client(self,app):
        client=TestClient(app)
        self.addCleanup(client.close)
        return client

    def post(self,url,body,key=None,client=None):
        return (client or self.client).post(url,json=body,headers={} if key is None else {'Idempotency-Key':key})

    def new_parcel(self,name):
        response=self.post('/api/v1/parcels',{'name':name,'season':'2019-2020','geometry':{'coordinates':[[[112,30],[112.001,30],[112.001,30.001],[112,30]]]}})
        self.assertEqual(response.status_code,201,response.text)
        return response.json()

    def saved_verification(self,parcel_id,risk_id=None,with_photo=False):
        response=self.post('/api/v1/visits',{'parcel_id':parcel_id,'risk_id':risk_id,'due_date':'2020-03-01'})
        self.assertEqual(response.status_code,201,response.text)
        visit=response.json()
        photos=[self.upload_photo(visit['id'])['id']] if with_photo else []
        response=self.complete(visit['id'],photo_ids=photos)
        self.assertEqual(response.status_code,201,response.text)
        return visit,response.json()

    def upload_photo(self,visit_id,color='green'):
        out=io.BytesIO()
        Image.new('RGB',(20,20),color).save(out,format='PNG')
        response=self.client.post(f'/api/v1/visits/{visit_id}/photos',content=out.getvalue(),headers={'Content-Type':'image/png'})
        self.assertEqual(response.status_code,201,response.text)
        return response.json()

    def complete(self,visit_id,**changes):
        body={'observed_at':'2020-03-01T08:00:00Z','label':'uncertain','note':'合成现场报告，未裁定','photo_ids':[],'client_submission_id':f'submit-{visit_id}'}
        return self.post(f'/api/v1/visits/{visit_id}/verifications',{**body,**changes})

    def follow_up(self,source=None,body=None,key=None,client=None):
        return self.post(f"/api/v1/verifications/{source or self.source['id']}/follow-up-visits",self.body if body is None else body,key,client)

    def count(self,table):
        with self.store.connect() as c:
            return c.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]

    def assert_error(self,response,status,code):
        self.assertEqual(response.status_code,status,response.text)
        self.assertEqual(response.json()['error']['code'],code)

    def test_http_contract_persists_server_owned_lineage_and_origin(self):
        response=self.follow_up(key='follow-up-create')
        self.assertEqual(response.status_code,201,response.text)
        follow_up=response.json()
        self.assertEqual(follow_up['source_verification_id'],self.source['id'])
        self.assertEqual(follow_up['parcel_id'],self.parcel['id'])
        self.assertIsNone(follow_up['risk_id'])
        self.assertEqual(follow_up['status'],'pending')
        self.assertEqual(follow_up['plan_revision'],0)
        self.assertEqual(follow_up['data_origin'],self.parcel['data_origin'])
        for field,value in self.body.items(): self.assertEqual(follow_up[field],value)
        reopened=self.new_client(create_app(self.db,False))
        persisted=next(v for v in reopened.get('/api/v1/visits').json() if v['id']==follow_up['id'])
        self.assertEqual(persisted,follow_up)
        with self.store.connect() as c:
            row=c.execute('SELECT parcel_id,risk_id,status,data FROM visits WHERE id=?',(follow_up['id'],)).fetchone()
            self.assertEqual((row['parcel_id'],row['risk_id'],row['status']),(self.parcel['id'],None,'pending'))
            self.assertEqual(json.loads(row['data']),follow_up)
            receipt=self.store.receipt(c,'follow-up-create')
            self.assertEqual(receipt['operation'],'create_follow_up_visit')
            self.assertEqual(receipt['target'],self.source['id'])
            self.assertEqual(c.execute('PRAGMA user_version').fetchone()[0],3)
        operation=self.client.get('/openapi.json').json()['paths']['/api/v1/verifications/{verification_id}/follow-up-visits']['post']
        self.assertIn('201',operation['responses'])
        self.assertTrue(any(p['name']=='Idempotency-Key' for p in operation['parameters']))

    def test_typed_payload_forbids_forged_identity_and_unknown_fields(self):
        for field,value in [('parcel_id',self.parcel['id']),('risk_id',None),('source_verification_id',self.source['id']),('status','completed'),('data_origin','fixture'),('plan_revision',99),('unknown','x')]:
            with self.subTest(field=field):
                self.assert_error(self.follow_up(body={**self.body,field:value}),422,'validation_error')
        for change in [{'due_date':'not-a-date'},{'due_date':None},{'assignee':'a'*101},{'note':'a'*2001}]:
            with self.subTest(change=change):
                self.assert_error(self.follow_up(body={**self.body,**change}),422,'validation_error')
        with self.assertRaises(ValidationError): FollowUpVisitCreate.model_validate({})
        self.assertEqual(self.count('visits'),1)
        self.assertEqual(self.count('idempotency_receipts'),0)
        valid=self.follow_up(body={'due_date':'2020-03-02','assignee':'a'*100,'note':'n'*2000})
        self.assertEqual(valid.status_code,201,valid.text)

    def test_defaults_and_whitespace_have_one_canonical_request(self):
        initial=self.follow_up(body={'due_date':'2020-03-02','note':'人工安排'},key='normalized')
        retry=self.follow_up(body={'note':'  人工安排  ','assignee':None,'due_date':'2020-03-02'},key='normalized')
        self.assertEqual(initial.status_code,201,initial.text)
        self.assertEqual(retry.status_code,201,retry.text)
        self.assertEqual(retry.json(),initial.json())
        self.assertIsNone(initial.json()['assignee'])
        self.assertEqual(self.count('visits'),2)

    def test_legacy_visit_request_and_stored_receipt_remain_exactly_compatible(self):
        # This literal is the historical create_visit canonical format. Adding
        # even a null lineage field would invalidate already committed receipts.
        parcel_id=self.parcel['id']
        canonical='{"assignee":null,"due_date":"2020-03-03","note":null,"parcel_id":"'+parcel_id+'","risk_id":null}'
        payload=VisitCreate(parcel_id=parcel_id,due_date='2020-03-03')
        self.assertEqual(FieldService.idempotency_request(payload,'legacy'),canonical)
        self.assertEqual(set(payload.model_dump()),{'parcel_id','risk_id','due_date','assignee','note'})
        legacy={'id':'visit_historical_receipt','parcel_id':parcel_id,'risk_id':None,'due_date':'2020-03-03','assignee':None,'note':None,'status':'pending','data_origin':'user','created_at':'2020-03-01T09:00:00+00:00'}
        with self.store.connect(write=True) as c:
            self.store.insert(c,'visits',legacy,parcel_id=parcel_id,risk_id=None,status='pending')
            self.store.insert_receipt(c,'legacy','create_visit',parcel_id,canonical,legacy)
            before=c.execute("SELECT request_json,response_json FROM idempotency_receipts WHERE key='legacy'").fetchone()
            before=tuple(before)
        reopened=self.new_client(create_app(self.db,False))
        retry=self.post('/api/v1/visits',{'parcel_id':parcel_id,'due_date':'2020-03-03'},'legacy',reopened)
        self.assertEqual(retry.status_code,201,retry.text)
        self.assertEqual(retry.json(),legacy)
        self.assertNotIn('source_verification_id',retry.json())
        self.assertNotIn('plan_revision',retry.json())
        with self.store.connect() as c:
            self.assertEqual(tuple(c.execute("SELECT request_json,response_json FROM idempotency_receipts WHERE key='legacy'").fetchone()),before)
        fresh=self.post('/api/v1/visits',{'parcel_id':parcel_id,'due_date':'2020-03-04'})
        self.assertEqual(fresh.status_code,201,fresh.text)
        self.assertNotIn('source_verification_id',fresh.json())
        self.assert_error(self.post('/api/v1/visits',{'parcel_id':parcel_id,'due_date':'2020-03-04','source_verification_id':self.source['id']}),422,'validation_error')

    def test_one_pending_per_source_and_completion_allows_explicit_new_follow_up(self):
        created=self.follow_up(key='first').json()
        for key in [None,'second']:
            self.assert_error(self.follow_up(key=key),409,'duplicate_follow_up_visit')
        self.assertEqual(self.count('idempotency_receipts'),1)
        completed=self.complete(created['id'])
        self.assertEqual(completed.status_code,201,completed.text)
        reopened=self.new_client(create_app(self.db,False))
        replay=self.follow_up(key='first',client=reopened)
        self.assertEqual(replay.status_code,201,replay.text)
        self.assertEqual(replay.json(),created)
        self.assertEqual(replay.json()['status'],'pending')  # immutable creation snapshot
        live=next(v for v in reopened.get('/api/v1/visits').json() if v['id']==created['id'])
        self.assertEqual(live['status'],'completed')
        next_visit=self.follow_up(key='second',client=reopened)
        self.assertEqual(next_visit.status_code,201,next_visit.text)
        self.assertNotEqual(next_visit.json()['id'],created['id'])
        self.assertEqual(next_visit.json()['source_verification_id'],self.source['id'])
        self.assertEqual(self.count('visits'),3)
        self.assertEqual(self.count('idempotency_receipts'),2)
        self.assertEqual(self.follow_up(key='first',client=reopened).json(),created)

    def test_committed_http_response_lost_replays_after_database_reopen(self):
        messages=[]
        app=self.app
        async def drop_response(scope,receive,send):
            async def discard(message): messages.append(message)
            await app(scope,receive,discard)
            raise ConnectionResetError('synthetic committed response lost')
        with self.assertRaisesRegex(ConnectionResetError,'synthetic committed response lost'):
            self.follow_up(key='lost-response',client=self.new_client(drop_response))
        self.assertEqual(self.count('visits'),2)
        self.assertEqual(self.count('idempotency_receipts'),1)
        self.assertEqual(next(m['status'] for m in messages if m['type']=='http.response.start'),201)
        original=json.loads(b''.join(m.get('body',b'') for m in messages if m['type']=='http.response.body'))
        reopened=self.new_client(create_app(self.db,False))
        retry=self.follow_up(key='lost-response',client=reopened)
        self.assertEqual(retry.status_code,201,retry.text)
        self.assertEqual(retry.json(),original)
        self.assertEqual(self.count('visits'),2)
        self.assertEqual(self.count('idempotency_receipts'),1)

    def test_receipt_binds_content_source_and_operation_before_source_lookup(self):
        created=self.follow_up(key='bound')
        self.assertEqual(created.status_code,201,created.text)
        for altered in [{'due_date':'2020-03-03'},{'assignee':'different'},{'note':'different'}]:
            self.assert_error(self.follow_up(body={**self.body,**altered},key='bound'),409,'idempotency_conflict')
        _,other_source=self.saved_verification(self.parcel['id'])
        for source in [other_source['id'],'missing']:
            self.assert_error(self.follow_up(source=source,key='bound'),409,'idempotency_conflict')
        self.assert_error(self.post('/api/v1/visits',{'parcel_id':self.parcel['id'],'due_date':'2020-03-02'},'bound'),409,'idempotency_conflict')
        self.assertEqual(self.post('/api/v1/visits',{'parcel_id':self.parcel['id'],'due_date':'2020-03-02'},'ordinary').status_code,201)
        self.assert_error(self.follow_up(key='ordinary'),409,'idempotency_conflict')
        # Even identical normalized JSON and target must use the correct operation.
        with self.store.connect(write=True) as c:
            self.store.insert_receipt(c,'operation-only','create_visit',self.source['id'],FieldService.idempotency_request(FollowUpVisitCreate(**self.body),'operation-only'),created.json())
        self.assert_error(self.follow_up(key='operation-only'),409,'idempotency_conflict')

    def concurrent_create(self,keys,bodies=None):
        services=[FieldService(SQLiteStore(self.db)) for _ in keys]
        barrier=Barrier(len(keys))
        def create(args):
            service,key,body=args
            barrier.wait(timeout=10)
            try: return service.create_follow_up_visit(self.source['id'],FollowUpVisitCreate(**body),key)
            except ServiceError as exc: return exc.status,exc.code
        with ThreadPoolExecutor(max_workers=len(keys)) as pool:
            return list(pool.map(create,zip(services,keys,bodies or [self.body]*len(keys))))

    def test_concurrent_same_key_retries_create_one_visit_and_one_receipt(self):
        results=self.concurrent_create(['same-key']*6)
        self.assertTrue(all(isinstance(row,dict) for row in results),results)
        self.assertTrue(all(row==results[0] for row in results))
        self.assertEqual(self.count('visits'),2)
        self.assertEqual(self.count('idempotency_receipts'),1)

    def test_concurrent_distinct_keys_or_no_keys_have_one_pending_winner(self):
        results=self.concurrent_create([None,None,'one','two','three','four'])
        self.assertEqual(sum(isinstance(row,dict) for row in results),1,results)
        self.assertEqual(results.count((409,'duplicate_follow_up_visit')),5,results)
        self.assertEqual(self.count('visits'),2)
        self.assertIn(self.count('idempotency_receipts'),[0,1])

    def test_concurrent_changed_content_on_same_key_conflicts(self):
        results=self.concurrent_create(['same','same'],[self.body,{**self.body,'note':'other'}])
        self.assertEqual(sum(isinstance(row,dict) for row in results),1,results)
        self.assertIn((409,'idempotency_conflict'),results)
        self.assertEqual(self.count('visits'),2)
        self.assertEqual(self.count('idempotency_receipts'),1)

    def test_receipt_failure_rolls_back_visit_and_allows_clean_retry(self):
        insert=self.store.insert_receipt
        def insert_then_fail(*args):
            insert(*args)
            raise RuntimeError('synthetic receipt failure')
        with patch.object(self.store,'insert_receipt',side_effect=insert_then_fail):
            with self.assertRaisesRegex(RuntimeError,'synthetic receipt failure'):
                self.service.create_follow_up_visit(self.source['id'],FollowUpVisitCreate(**self.body),'rollback')
        self.assertEqual(self.count('visits'),1)
        self.assertEqual(self.count('idempotency_receipts'),0)
        self.assertEqual(self.follow_up(key='rollback').status_code,201)

    def test_sources_and_parcels_are_isolated_in_pending_guard(self):
        _,same_parcel_source=self.saved_verification(self.parcel['id'])
        other=self.new_parcel('另一合成地块')
        _,other_source=self.saved_verification(other['id'])
        for source,parcel in [(self.source,self.parcel),(same_parcel_source,self.parcel),(other_source,other)]:
            result=self.follow_up(source=source['id'])
            self.assertEqual(result.status_code,201,result.text)
            self.assertEqual(result.json()['parcel_id'],parcel['id'])
            self.assertEqual(result.json()['source_verification_id'],source['id'])
        self.assertEqual(sum(v['status']=='pending' for v in self.service.list('visits')),3)
        self.assert_error(self.follow_up(),409,'duplicate_follow_up_visit')

    def test_missing_and_inconsistent_source_are_rejected_without_writes(self):
        self.assert_error(self.follow_up(source='missing',key='bad'),404,'not_found')
        other=self.new_parcel('交叉地块')
        mutations=[
            ('verifications',self.source['id'],{'parcel_id':other['id']},{}),
            ('verifications',self.source['id'],{'visit_id':'missing'},{}),
            ('verifications',self.source['id'],{'id':'wrong'},{}),
            ('verifications',self.source['id'],{'observed_at':'2020-03-01T08:00:00'},{}),
            ('verifications',self.source['id'],{'observed_at':'broken'},{}),
            ('verifications',self.source['id'],{'data_origin':'fixture'},{}),
            ('verifications',self.source['id'],{}, {'parcel_id':other['id']}),
            ('visits',self.original['id'],{'status':'pending'},{}),
            ('visits',self.original['id'],{}, {'status':'pending'}),
            ('visits',self.original['id'],{'parcel_id':other['id']},{}),
            ('visits',self.original['id'],{}, {'parcel_id':other['id']}),
        ]
        for table,key,changes,indexed in mutations:
            with self.subTest(table=table,changes=changes,indexed=indexed):
                with self.store.connect(write=True) as c:
                    original=self.store.get(c,table,key)
                    c.execute(f'UPDATE {table} SET data=? WHERE id=?',(json.dumps({**original,**changes},ensure_ascii=False),key))
                    for column,value in indexed.items():
                        c.execute(f'UPDATE {table} SET {column}=? WHERE id=?',(value,key))
                try:
                    self.assert_error(self.follow_up(key='bad'),422,'invalid_follow_up_source')
                    self.assertEqual(self.count('visits'),1)
                    self.assertEqual(self.count('idempotency_receipts'),0)
                finally:
                    with self.store.connect(write=True) as c:
                        # An altered JSON id cannot be restored through update().
                        c.execute(f'UPDATE {table} SET data=? WHERE id=?',(json.dumps(original,ensure_ascii=False),key))
                        for column in indexed:
                            c.execute(f'UPDATE {table} SET {column}=? WHERE id=?',(original[column],key))

    def test_plan_and_completion_preserve_lineage_and_creation_snapshot(self):
        created=self.follow_up(key='original-create').json()
        update=self.post(f"/api/v1/visits/{created['id']}/plan",{'expected_revision':0,'due_date':'2020-03-05','assignee':'调整执行人'},'plan')
        self.assertEqual(update.status_code,200,update.text)
        changed=update.json()
        self.assertEqual(changed['plan_revision'],1)
        for field in ['id','parcel_id','risk_id','source_verification_id','note','data_origin','created_at']:
            self.assertEqual(changed[field],created[field])
        self.assertEqual(self.follow_up(key='original-create').json(),created)
        result=self.complete(created['id'])
        self.assertEqual(result.status_code,201,result.text)
        replay=self.complete(created['id'])
        self.assertEqual(replay.status_code,201,replay.text)
        self.assertEqual(replay.json(),result.json())
        self.assert_error(self.complete(created['id'],note='different'),409,'idempotency_conflict')
        live=next(v for v in self.service.list('visits') if v['id']==created['id'])
        for field in ['id','parcel_id','risk_id','source_verification_id','note','data_origin','created_at','plan_revision','due_date','assignee']:
            self.assertEqual(live[field],changed[field])
        self.assertEqual(live['status'],'completed')
        self.assertEqual(self.follow_up(key='original-create').json(),created)

    def test_follow_up_observation_compares_aware_instants_and_keeps_season_checks(self):
        # Existing evidence may use a non-UTC offset. Compare instants, never
        # strings or local wall times, without rewriting the source record.
        with self.store.connect(write=True) as c:
            self.store.update(c,'verifications',{**self.source,'observed_at':'2020-03-01T03:00:00-05:00'})
        created=self.follow_up().json()
        self.assert_error(self.complete(created['id'],observed_at='2020-03-01T02:59:59-05:00'),422,'verification_before_source')
        self.assert_error(self.complete(created['id'],observed_at='2019-06-30T15:59:59Z'),422,'outside_season')
        self.assert_error(self.complete(created['id'],observed_at='2020-03-01T08:00:00'),422,'validation_error')
        self.assertEqual(self.count('verifications'),1)
        self.assertEqual(next(v for v in self.service.list('visits') if v['id']==created['id'])['status'],'pending')
        # Equal instants are valid even when their local dates/times differ.
        equal=self.complete(created['id'],observed_at='2020-03-01T03:00:00-05:00')
        self.assertEqual(equal.status_code,201,equal.text)
        self.assertEqual(equal.json()['observed_at'],self.source['observed_at'])

    def test_completion_revalidates_source_and_rejects_cross_parcel_lineage(self):
        other=self.new_parcel('另一合成地块')
        _,other_source=self.saved_verification(other['id'])
        created=self.follow_up().json()
        with self.store.connect(write=True) as c:
            self.store.update(c,'visits',{**created,'source_verification_id':other_source['id']})
        self.assert_error(self.complete(created['id']),422,'invalid_follow_up_source')
        self.assertEqual(self.count('verifications'),2)
        # Reads must not fabricate a valid event link for the corrupted source.
        self.assert_error(self.client.get('/api/v1/visits'),422,'invalid_follow_up_source')
        with self.store.connect() as c:
            self.assertEqual(self.store.get(c,'visits',created['id'])['status'],'pending')

    def test_follow_up_keeps_unresolved_event_and_original_evidence(self):
        with patch('app.application.service.datetime',wraps=datetime) as service_clock,patch('app.domain.detection.datetime',wraps=datetime) as detection_clock:
            service_clock.now.return_value=detection_clock.now.return_value=datetime(2020,3,1,tzinfo=timezone.utc)
            seed=self.post('/api/v1/dev/fixtures',{}).json()
            run=self.post(f"/api/v1/parcels/{seed['parcel_id']}/analyses",{}).json()
        self.assertEqual(run['status'],'candidate')
        original,source=self.saved_verification(seed['parcel_id'],run['risk_id'],with_photo=True)
        with self.store.connect() as c:
            snapshots={table:[tuple(row) for row in c.execute(f'SELECT * FROM {table} ORDER BY id')] for table in ['risks','observations','verifications','photos']}
            original_visit=tuple(c.execute('SELECT * FROM visits WHERE id=?',(original['id'],)).fetchone())
        created=self.follow_up(source=source['id'],key='fixture-follow-up')
        self.assertEqual(created.status_code,201,created.text)
        self.assertEqual(created.json()['data_origin'],'fixture')
        self.assertEqual(created.json()['risk_id'],run['risk_id'])
        # Reusing the original photo is not permitted and does not change it.
        self.assert_error(self.complete(created.json()['id'],photo_ids=source['photo_ids']),422,'photo_mismatch')
        new_photo=self.upload_photo(created.json()['id'],'blue')
        result=self.complete(created.json()['id'],label='normal',photo_ids=[new_photo['id']])
        self.assertEqual(result.status_code,201,result.text)
        with self.store.connect() as c:
            for table in ['observations']:
                self.assertEqual([tuple(row) for row in c.execute(f'SELECT * FROM {table} ORDER BY id')],snapshots[table])
            for table in ['verifications','photos']:
                for row in snapshots[table]:
                    self.assertEqual(tuple(c.execute(f'SELECT * FROM {table} WHERE id=?',(row[0],)).fetchone()),row)
            self.assertEqual(tuple(c.execute('SELECT * FROM visits WHERE id=?',(original['id'],)).fetchone()),original_visit)
            risk=self.store.get(c,'risks',run['risk_id'])
            self.assertEqual(risk['status'],'review_required')
            self.assertEqual(risk['disposition'],'unresolved')
            self.assertEqual(risk['verification_id'],result.json()['id'])
        # Completed follow-up verifications can themselves be an explicit source.
        chained=self.follow_up(source=result.json()['id'])
        self.assertEqual(chained.status_code,201,chained.text)
        self.assertEqual(chained.json()['source_verification_id'],result.json()['id'])

    def test_invalid_or_duplicate_idempotency_headers_are_rejected(self):
        url=f"/api/v1/verifications/{self.source['id']}/follow-up-visits"
        for key in ['','contains space','x'*129,'not/allowed']:
            self.assert_error(self.follow_up(key=key),422,'invalid_idempotency_key')
        response=self.client.post(url,json=self.body,headers=[('Idempotency-Key','first'),('Idempotency-Key','second')])
        self.assert_error(response,422,'invalid_idempotency_key')
        self.assertEqual(self.count('visits'),1)
        self.assertEqual(self.count('idempotency_receipts'),0)


if __name__=='__main__': unittest.main()
