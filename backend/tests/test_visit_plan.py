import concurrent.futures
from datetime import date
import tempfile
from pathlib import Path
import unittest
from app.adapters.storage import SQLiteStore
from app.application.service import FieldService, ServiceError
from app.domain.models import ParcelCreate, VisitCreate, VisitPlanUpdate, VerificationCreate
from pydantic import ValidationError


class VisitPlanTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.store=SQLiteStore(Path(self.temp.name)/'synthetic.sqlite3'); self.service=FieldService(self.store)
        self.parcel=self.service.create_parcel(ParcelCreate(name='合成地块',season='2026-2027',geometry={'coordinates':[[[112,30],[112.001,30],[112.001,30.001],[112,30]]]}))
        self.visit=self.service.create_visit(VisitCreate(parcel_id=self.parcel['id'],due_date=date(2026,10,18),assignee='原执行人',note='原始核查提示'),'create-key')

    def tearDown(self): self.temp.cleanup()

    def plan(self,revision=0,day='2025-01-01',assignee='调整执行人'):
        return VisitPlanUpdate(expected_revision=revision,due_date=day,assignee=assignee)

    def test_update_preserves_identity_evidence_and_replays_without_second_change(self):
        # Legacy tasks have no plan revision; the first edit must work without migration.
        with self.store.connect(write=True) as c:
            legacy=self.store.get(c,'visits',self.visit['id']); legacy.pop('plan_revision'); self.store.update(c,'visits',legacy)
            self.store.insert(c,'photos',{'id':'photo','visit_id':legacy['id'],'state':'staged'},visit_id=legacy['id'],sha256='synthetic',blob=b'original-photo')
        result=self.service.update_visit_plan(self.visit['id'],self.plan(),'update-key')
        reopened=FieldService(SQLiteStore(self.store.path))
        self.assertEqual(reopened.update_visit_plan(self.visit['id'],self.plan(),'update-key'),result)
        self.assertEqual(result['plan_revision'],1); self.assertEqual(result['due_date'],'2025-01-01')
        for key in ('id','parcel_id','risk_id','note','created_at','data_origin','status'): self.assertEqual(result[key],self.visit[key])
        self.assertEqual(self.service.photo('photo')[1],b'original-photo')
        self.assertEqual(len(self.service.list('visits')),1)
        with self.store.connect() as c: self.assertEqual(c.execute('SELECT COUNT(*) FROM idempotency_receipts').fetchone()[0],2)
        # The creation receipt remains its original snapshot, not an updated task view.
        created=self.service.create_visit(VisitCreate(parcel_id=self.parcel['id'],due_date=date(2026,10,18),assignee='原执行人',note='原始核查提示'),'create-key')
        self.assertEqual(created,self.visit)
        with self.assertRaises(ServiceError) as conflict: reopened.update_visit_plan(self.visit['id'],self.plan(day='2025-02-01'),'update-key')
        self.assertEqual(conflict.exception.code,'idempotency_conflict')

    def test_stale_concurrent_and_completed_edits_never_overwrite_a_newer_task(self):
        def update(key):
            try: return self.service.update_visit_plan(self.visit['id'],self.plan(assignee=key),key)
            except ServiceError as error: return error.code
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(update,['tab-a','tab-b']))
        self.assertEqual(sum(isinstance(value,dict) for value in results),1); self.assertIn('visit_plan_conflict',results)
        winner=next(value for value in results if isinstance(value,dict)); key=winner['assignee']
        latest=self.service.update_visit_plan(self.visit['id'],self.plan(1,assignee='later'),'later-key')
        with self.assertRaises(ServiceError) as replay: self.service.update_visit_plan(self.visit['id'],self.plan(assignee=key),key)
        self.assertEqual(replay.exception.code,'visit_plan_conflict')
        self.assertEqual(self.service.list('visits')[0],latest)
        self.service.verify(self.visit['id'],VerificationCreate(observed_at='2026-10-17T12:00:00Z',label='uncertain',note='合成核查',client_submission_id='synthetic-submission'))
        completed=self.service.list('visits')[0]
        for payload,request_key in [(self.plan(2),'after-completed'),(self.plan(1,assignee='later'),'later-key')]:
            with self.assertRaises(ServiceError) as error: self.service.update_visit_plan(self.visit['id'],payload,request_key)
            self.assertEqual(error.exception.code,'visit_completed')
        self.assertEqual(self.service.list('visits')[0],completed)

    def test_update_contract_rejects_attempts_to_rebind_or_change_evidence(self):
        body={'expected_revision':0,'due_date':'2026-10-18'}
        for field in ('parcel_id','risk_id','status','note','client_submission_id','observed_at'):
            with self.subTest(field=field),self.assertRaises(ValidationError): VisitPlanUpdate.model_validate({**body,field:'changed'})
        for revision in (-1,'0',True):
            with self.subTest(revision=revision),self.assertRaises(ValidationError): VisitPlanUpdate.model_validate({**body,'expected_revision':revision})
