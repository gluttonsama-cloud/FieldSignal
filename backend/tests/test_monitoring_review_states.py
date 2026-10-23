"""P0 regressions: synthetic observations, isolated SQLite, no external sources."""
import copy
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Barrier
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.adapters.local_bundle import geometry_sha256
from app.adapters.storage import SQLiteStore
from app.application.service import FieldService, ServiceError
from app.domain.detection import eligible, evaluate, qualification
from app.domain.models import FollowUpVisitCreate, VisitCreate, VisitPlanUpdate
from app.main import create_app


class FixedDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        value=cls(2026,10,15,12,tzinfo=timezone.utc)
        return value.astimezone(tz) if tz else value.replace(tzinfo=None)


class MonitoringReviewStateTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='fieldsignal-p0-synthetic-')
        self.addCleanup(self.temp.cleanup)
        for name in ['app.application.service.datetime','app.domain.models.datetime','app.domain.detection.datetime']:
            clock=patch(name,FixedDatetime);clock.start();self.addCleanup(clock.stop)
        self.now=FixedDatetime.now(timezone.utc)
        self.db=Path(self.temp.name)/'synthetic.sqlite3'
        self.app=create_app(self.db,True)
        self.service=self.app.state.service
        self.client=TestClient(self.app);self.addCleanup(self.client.close)
        self.parcel=self.post('/api/v1/parcels',{'name':'Synthetic P0 test, not a farm','season':'2026-2027','geometry':{'type':'Polygon','coordinates':[[[0,0],[.002,0],[.002,.002],[0,.002],[0,0]]]}})

    def post(self,url,body,key=None):
        response=self.client.post(url,json=body,headers={} if key is None else {'Idempotency-Key':key})
        self.assertEqual(response.status_code,201,response.text)
        return response.json()

    def rows(self,table): return self.client.get('/api/v1/'+table).json()

    def fixture(self):
        parcel_id=self.post('/api/v1/dev/fixtures',{})['parcel_id']
        run=self.post(f'/api/v1/parcels/{parcel_id}/analyses',{})
        return parcel_id,run

    def visit(self,parcel_id,risk_id=None):
        return self.post('/api/v1/visits',{'parcel_id':parcel_id,'risk_id':risk_id,'due_date':'2026-10-15'})

    def report(self,visit,label='uncertain'):
        body={'observed_at':self.now.isoformat(),'label':label,'note':'Synthetic report, not adjudicated','photo_ids':[],'client_submission_id':'report-'+visit['id']}
        return self.post(f"/api/v1/visits/{visit['id']}/verifications",body)

    def follow_up(self,report,key=None):
        return self.post(f"/api/v1/verifications/{report['id']}/follow-up-visits",{'due_date':'2026-10-16'},key)

    def observation(self,index,declared=False,source='sentinel2',days=None):
        days=1+7*index if days is None else days
        row={'observed_at':(self.now-timedelta(days=days)).isoformat(),'source':source,'source_record_id':f'synthetic-{source}-{index}',
             'features':{'ndvi':.35 if index==0 else .7},'quality':{'usable':True,'valid_fraction':.9,'cloud_fraction':.02},
             'provenance':{'provider':'synthetic-test-only','collection':'synthetic-s2','item_id':f'synthetic-item-{index}','processing_version':'synthetic-v1'}}
        if source=='weather':
            row['features']={'precipitation_mm':2.0};row['quality']={'usable':True,'valid_fraction':1.0}
        if declared:
            row['provenance'].update({'usage_scope':'parcel','parcel_geometry_sha256':geometry_sha256(self.parcel['geometry']),
                'parcel_mask_sha256':'a'*64,'asset_checksums':{'mask':'a'*64,'red':'b'*64,'nir':'c'*64,'scl':'d'*64,'stac':'e'*64},
                'spatial_support':{'kind':'parcel','crs':'EPSG:32631','bounds':[0,0,100,100],'pixel_size_m':10.0,'scl_pixel_size_m':20.0,'total_pixels':100,'valid_pixels':90}})
        return row

    def import_observations(self,declared=False):
        return [self.post(f"/api/v1/parcels/{self.parcel['id']}/observations",self.observation(i,declared)) for i in range(7)]

    def test_unverified_metrics_can_be_explored_but_never_create_monitoring_candidates(self):
        observations=self.import_observations()
        run=self.post(f"/api/v1/parcels/{self.parcel['id']}/analyses",{})
        self.assertIsNone(run['risk_id'],'Unverified numeric inputs must not create a formal candidate')
        self.assertEqual(run['status'],'preview_only')
        self.assertEqual(run['preview_status'],'candidate')
        self.assertEqual(run['mode'],'preview')
        self.assertEqual(run['qualification_status'],'unverified')
        self.assertFalse(run['monitoring_eligible'])
        self.assertEqual(run['observation_count'],7)
        self.assertEqual(run['preview_evidence']['latest_observation_id'],observations[0]['id'])
        self.assertEqual(self.rows('risks'),[])
        self.assertEqual(self.rows('visits'),[])
        self.assertEqual(self.rows('dashboard')['open_risk_count'],0)
        self.assertEqual(self.client.get(f"/api/v1/parcels/{self.parcel['id']}/analyses").json(),[run])

    def test_hash_and_geometry_declarations_do_not_self_attest_source_truth(self):
        self.import_observations(declared=True)
        run=self.post(f"/api/v1/parcels/{self.parcel['id']}/analyses",{})
        self.assertIsNone(run['risk_id'],'Matching hashes are declarations, not independent qualification')
        self.assertEqual(run['qualification_status'],'declared_only')
        self.assertIn('source_not_verified',run['qualification_reasons'])
        self.assertFalse(run['monitoring_eligible'])
        self.assertEqual(run['preview_status'],'candidate')
        forged=self.observation(10,True)
        forged['provenance']['qualification_status']='verified'
        rejected=self.client.post(f"/api/v1/parcels/{self.parcel['id']}/observations",json=forged)
        self.assertEqual(rejected.status_code,422)

    def test_detector_default_never_qualifies_unverified_or_declared_input(self):
        for declared in [False,True]:
            self.assertFalse(eligible(self.observation(0,declared)))
        observations=[dict(self.observation(i),id=str(i)) for i in range(7)]
        self.assertIsNone(evaluate(observations,'statistical',self.now)['risk'])

    def test_declared_only_requires_all_bindings_without_granting_monitoring(self):
        row=self.observation(0,True)
        digest=geometry_sha256(self.parcel['geometry'])
        changes=[('usage_scope','unverified'),('parcel_geometry_sha256','f'*64),('parcel_mask_sha256',None),('asset_checksums',{}),
                 ('spatial_support',{'kind':'parcel'}),('spatial_support',dict(row['provenance']['spatial_support'],valid_pixels=101)),
                 ('spatial_support',dict(row['provenance']['spatial_support'],valid_pixels=1))]
        for key,value in changes:
            with self.subTest(field=key,value=value):
                bad=copy.deepcopy(row);bad['provenance'][key]=value
                trust=qualification([bad],digest)
                self.assertEqual(trust['qualification_status'],'unverified')
                self.assertFalse(trust['monitoring_eligible'])
        # One declaration cannot qualify an otherwise unbound time series.
        self.assertEqual(qualification([row,self.observation(1)],digest)['qualification_status'],'unverified')

    def test_preview_without_decline_is_not_promoted_to_healthy_monitoring(self):
        for i in range(7):
            row=self.observation(i,True);row['features']['ndvi']=.7
            self.post(f"/api/v1/parcels/{self.parcel['id']}/observations",row)
        run=self.post(f"/api/v1/parcels/{self.parcel['id']}/analyses",{})
        self.assertEqual(run['status'],'preview_only')
        self.assertEqual(run['preview_status'],'not_flagged')
        self.assertIsNone(run['preview_evidence'])
        self.assertFalse(run['monitoring_eligible'])
        parcel=self.rows('dashboard')['parcels'][0]
        self.assertEqual(parcel['optical_data_status'],'available')
        self.assertEqual(parcel['monitoring_status'],'preview_only')
        self.assertEqual(parcel['qualification_status'],'declared_only')

    def test_empty_and_stale_preview_runs_explain_why_monitoring_is_blocked(self):
        path=f"/api/v1/parcels/{self.parcel['id']}/analyses"
        empty=self.post(path,{})
        self.assertEqual(empty['status'],'blocked')
        self.assertEqual(empty['preview_status'],'insufficient_data')
        self.assertIsNone(empty['risk_id'])
        self.post(f"/api/v1/parcels/{self.parcel['id']}/observations",self.observation(0,days=30))
        stale=self.post(path,{})
        self.assertEqual(stale['status'],'blocked')
        self.assertEqual(stale['preview_status'],'stale')
        self.assertIsNone(stale['risk_id'])

    def test_fixture_demo_is_explicit_and_cannot_qualify_a_real_parcel(self):
        parcel_id,run=self.fixture()
        self.assertEqual(run['status'],'candidate')
        self.assertEqual(run['mode'],'fixture_demo')
        self.assertEqual(run['qualification_status'],'fixture_demo')
        self.assertFalse(run['monitoring_eligible'])
        self.assertIsNone(run['preview_status'])
        self.assertTrue(run['risk_id'])
        risk=self.rows('risks')[0]
        self.assertEqual(risk['mode'],'fixture_demo')
        self.assertEqual(risk['disposition'],'unresolved')
        self.assertFalse(risk['monitoring_eligible'])
        row=self.observation(0);row['data_origin']='fixture'
        self.assertEqual(self.client.post(f"/api/v1/parcels/{self.parcel['id']}/observations",json=row).status_code,422)
        self.assertNotEqual(parcel_id,self.parcel['id'])

    def test_client_cannot_grant_analysis_or_report_dispositions(self):
        path=f"/api/v1/parcels/{self.parcel['id']}/analyses"
        for field,value in [('mode','fixture_demo'),('monitoring_eligible',True),('qualification_status','verified')]:
            with self.subTest(field=field):
                response=self.client.post(path,json={field:value})
                self.assertEqual(response.status_code,422,response.text)
        visit=self.visit(self.parcel['id'])
        payload={'observed_at':self.now.isoformat(),'label':'normal','note':'Synthetic test','disposition':'resolved'}
        response=self.client.post(f"/api/v1/visits/{visit['id']}/verifications",json=payload)
        self.assertEqual(response.status_code,422,response.text)
        self.assertEqual(self.rows('verifications'),[])
        self.assertEqual(self.rows('visits')[0]['status'],'pending')

    def test_all_field_labels_complete_only_the_visit_and_remain_unadjudicated(self):
        parcel_id,run=self.fixture()
        for label in ['uncertain','disease_suspected','normal','waterlogging','frost','other']:
            with self.subTest(label=label):
                visit=self.visit(parcel_id,run['risk_id'])
                report=self.report(visit,label)
                risk=self.rows('risks')[0]
                self.assertEqual(risk['status'],'review_required','A field report is not adjudication')
                self.assertEqual(risk['disposition'],'unresolved')
                self.assertEqual(report['disposition'],'review_required')
                self.assertEqual(report['label_source'],'field_report_unadjudicated')
                self.assertEqual(report['risk_id'],risk['id'])
                self.assertEqual(next(v for v in self.rows('visits') if v['id']==visit['id'])['status'],'completed')
                self.assertEqual(self.rows('dashboard')['open_risk_count'],1)
                rerun=self.post(f'/api/v1/parcels/{parcel_id}/analyses',{})
                self.assertEqual(rerun['risk_id'],risk['id'])
                self.assertEqual(self.rows('risks')[0]['status'],'review_required')
        self.assertEqual(self.rows('dashboard')['review_required_count'],6)

    def test_legacy_verified_projection_is_unresolved_without_rewriting_saved_bytes(self):
        parcel_id,run=self.fixture();visit=self.visit(parcel_id,run['risk_id']);report=self.report(visit)
        with self.service.store.connect(write=True) as c:
            risk=self.service.store.get(c,'risks',run['risk_id'])
            risk['status']='verified';risk.pop('disposition',None)
            self.service.store.update(c,'risks',risk)
            for key in ['disposition','risk_id']: report.pop(key,None)
            self.service.store.update(c,'verifications',report)
            before={table:[tuple(r) for r in c.execute(f'SELECT * FROM {table} ORDER BY id')] for table in ['risks','visits','verifications']}
        live=self.rows('risks')[0]
        self.assertEqual(live['status'],'review_required')
        self.assertEqual(live['legacy_status'],'verified')
        self.assertEqual(live['disposition'],'unresolved')
        self.assertEqual(self.rows('verifications')[0]['disposition'],'review_required')
        self.assertEqual(self.rows('verifications')[0]['risk_id'],live['id'])
        self.assertEqual(self.rows('dashboard')['open_risk_count'],1)
        with self.service.store.connect() as c:
            for table,snapshot in before.items():
                self.assertEqual([tuple(r) for r in c.execute(f'SELECT * FROM {table} ORDER BY id')],snapshot)
            self.assertEqual(c.execute('PRAGMA user_version').fetchone()[0],3)

    def test_follow_up_preserves_event_link_and_blocks_duplicates_across_entrypoints(self):
        parcel_id,run=self.fixture();original=self.visit(parcel_id,run['risk_id']);source=self.report(original)
        follow=self.follow_up(source,'follow-root')
        self.assertEqual(follow['risk_id'],run['risk_id'])
        self.assertEqual(follow['source_verification_id'],source['id'])
        duplicate=self.client.post('/api/v1/visits',json={'parcel_id':parcel_id,'risk_id':run['risk_id'],'due_date':'2026-10-16'})
        self.assertEqual(duplicate.status_code,409)
        follow_report=self.report(follow,'normal')
        self.assertEqual(follow_report['risk_id'],run['risk_id'])
        self.assertEqual(follow_report['source_verification_id'],source['id'])
        chained=self.follow_up(follow_report)
        self.assertEqual(chained['risk_id'],run['risk_id'])
        duplicate=self.client.post(f"/api/v1/verifications/{source['id']}/follow-up-visits",json={'due_date':'2026-10-17'})
        self.assertEqual(duplicate.status_code,409)
        # Replay keeps its original snapshot despite a newer pending descendant.
        self.assertEqual(self.follow_up(source,'follow-root'),follow)
        self.assertEqual(self.rows('dashboard')['open_risk_count'],1)

    def test_legacy_null_risk_follow_up_cannot_bypass_pending_event_guard(self):
        parcel_id,run=self.fixture();source=self.report(self.visit(parcel_id,run['risk_id']))
        legacy=self.follow_up(source)
        with self.service.store.connect(write=True) as c:
            legacy['risk_id']=None
            self.service.store.update(c,'visits',legacy,risk_id=None)
        duplicate=self.client.post('/api/v1/visits',json={'parcel_id':parcel_id,'risk_id':run['risk_id'],'due_date':'2026-10-16'})
        self.assertEqual(duplicate.status_code,409)
        result=self.report(legacy)
        self.assertEqual(result['risk_id'],run['risk_id'])
        self.assertEqual(self.rows('risks')[0]['verification_id'],result['id'])

    def test_pending_follow_up_chain_cannot_branch_without_a_satellite_candidate(self):
        source=self.report(self.visit(self.parcel['id']))
        first=self.follow_up(source)
        descendant=self.report(first)
        pending=self.follow_up(descendant)
        self.assertIsNone(pending['risk_id'])
        duplicate=self.client.post(f"/api/v1/verifications/{source['id']}/follow-up-visits",json={'due_date':'2026-10-17'})
        self.assertEqual(duplicate.status_code,409)
        self.assertEqual(duplicate.json()['error']['code'],'duplicate_follow_up_visit')

    def test_ordinary_and_source_linked_visit_concurrency_has_one_pending_winner(self):
        parcel_id,run=self.fixture();source=self.report(self.visit(parcel_id,run['risk_id']))
        services=[FieldService(SQLiteStore(self.db)) for _ in range(6)]
        barrier=Barrier(len(services))
        def create(args):
            index,service=args;barrier.wait(timeout=10)
            try:
                if index%2:
                    return service.create_visit(VisitCreate(parcel_id=parcel_id,risk_id=run['risk_id'],due_date='2026-10-16'))
                return service.create_follow_up_visit(source['id'],FollowUpVisitCreate(due_date='2026-10-16'))
            except ServiceError as exc: return exc.status,exc.code
        with ThreadPoolExecutor(max_workers=6) as pool:
            results=list(pool.map(create,enumerate(services)))
        self.assertEqual(sum(isinstance(r,dict) for r in results),1,results)
        self.assertTrue(all(isinstance(r,dict) or r[0]==409 for r in results),results)
        pending=[v for v in self.rows('visits') if v['status']=='pending']
        self.assertEqual(len(pending),1)
        self.assertEqual(pending[0]['risk_id'],run['risk_id'])

    def test_mismatched_source_event_is_rejected_without_a_visit_or_receipt(self):
        source=self.report(self.visit(self.parcel['id']))
        _,run=self.fixture()
        with self.service.store.connect(write=True) as c:
            self.service.store.update(c,'verifications',{**source,'risk_id':run['risk_id']})
        response=self.client.post(f"/api/v1/verifications/{source['id']}/follow-up-visits",json={'due_date':'2026-10-16'},headers={'Idempotency-Key':'reject-mismatch'})
        self.assertEqual(response.status_code,422)
        self.assertEqual(response.json()['error']['code'],'invalid_follow_up_source')
        with self.service.store.connect() as c:
            self.assertIsNone(self.service.store.receipt(c,'reject-mismatch'))
            self.assertEqual(c.execute('SELECT COUNT(*) FROM visits').fetchone()[0],1)

    def test_legacy_follow_up_receipt_remains_exact_after_read_projection(self):
        parcel_id,run=self.fixture();source=self.report(self.visit(parcel_id,run['risk_id']))
        follow=self.follow_up(source,'legacy-follow')
        with self.service.store.connect(write=True) as c:
            follow['risk_id']=None
            self.service.store.update(c,'visits',follow,risk_id=None)
            c.execute('UPDATE idempotency_receipts SET response_json=? WHERE key=?',(json.dumps(follow),'legacy-follow'))
            before=tuple(c.execute('SELECT request_json,response_json FROM idempotency_receipts WHERE key=?',('legacy-follow',)).fetchone())
        live=next(v for v in self.rows('visits') if v['id']==follow['id'])
        self.assertEqual(live['risk_id'],run['risk_id'])
        self.assertEqual(self.follow_up(source,'legacy-follow'),follow)
        with self.service.store.connect() as c:
            self.assertEqual(tuple(c.execute('SELECT request_json,response_json FROM idempotency_receipts WHERE key=?',('legacy-follow',)).fetchone()),before)
            self.assertIsNone(self.service.store.get(c,'visits',follow['id'])['risk_id'])

    def test_new_legacy_follow_up_plan_receipt_matches_projected_event_identity(self):
        parcel_id,run=self.fixture();source=self.report(self.visit(parcel_id,run['risk_id']))
        follow=self.follow_up(source,'legacy-plan-create')
        with self.service.store.connect(write=True) as c:
            follow['risk_id']=None
            self.service.store.update(c,'visits',follow,risk_id=None)
            c.execute('UPDATE idempotency_receipts SET response_json=? WHERE key=?',(json.dumps(follow),'legacy-plan-create'))
            creation_before=tuple(c.execute('SELECT * FROM idempotency_receipts WHERE key=?',('legacy-plan-create',)).fetchone())
        original=next(v for v in self.rows('visits') if v['id']==follow['id'])
        payload=VisitPlanUpdate(expected_revision=0,due_date='2026-10-17',assignee='Synthetic revised')
        updated=self.service.update_visit_plan(follow['id'],payload,'new-legacy-plan')
        self.assertEqual(updated['risk_id'],original['risk_id'])
        self.assertEqual(updated['source_verification_id'],original['source_verification_id'])
        self.assertEqual(updated['plan_revision'],1)
        self.assertEqual(updated,next(v for v in self.rows('visits') if v['id']==follow['id']))
        self.assertEqual(self.service.update_visit_plan(follow['id'],payload,'new-legacy-plan'),updated)
        with self.service.store.connect() as c:
            self.assertIsNone(self.service.store.get(c,'visits',follow['id'])['risk_id'])
            self.assertIsNone(c.execute('SELECT risk_id FROM visits WHERE id=?',(follow['id'],)).fetchone()['risk_id'])
            self.assertEqual(tuple(c.execute('SELECT * FROM idempotency_receipts WHERE key=?',('legacy-plan-create',)).fetchone()),creation_before)
            self.assertEqual(json.loads(self.service.store.receipt(c,'new-legacy-plan')['response_json']),updated)

    def test_historical_legacy_follow_up_plan_receipt_is_not_rewritten(self):
        parcel_id,run=self.fixture();source=self.report(self.visit(parcel_id,run['risk_id']))
        follow=self.follow_up(source)
        with self.service.store.connect(write=True) as c:
            follow['risk_id']=None
            self.service.store.update(c,'visits',follow,risk_id=None)
        payload=VisitPlanUpdate(expected_revision=0,due_date='2026-10-17')
        historical=self.service.update_visit_plan(follow['id'],payload,'historical-plan')
        historical['risk_id']=None
        with self.service.store.connect(write=True) as c:
            c.execute('UPDATE idempotency_receipts SET response_json=? WHERE key=?',(json.dumps(historical),'historical-plan'))
            before=tuple(c.execute('SELECT * FROM idempotency_receipts WHERE key=?',('historical-plan',)).fetchone())
        self.assertEqual(next(v for v in self.rows('visits') if v['id']==follow['id'])['risk_id'],run['risk_id'])
        self.assertEqual(self.service.update_visit_plan(follow['id'],payload,'historical-plan'),historical)
        with self.service.store.connect() as c:
            self.assertEqual(tuple(c.execute('SELECT * FROM idempotency_receipts WHERE key=?',('historical-plan',)).fetchone()),before)

    def test_legacy_chained_follow_ups_recover_event_without_rewriting_ancestors(self):
        parcel_id,run=self.fixture();source=self.report(self.visit(parcel_id,run['risk_id']))
        ancestor=self.follow_up(source);report=self.report(ancestor)
        with self.service.store.connect(write=True) as c:
            ancestor=self.service.store.get(c,'visits',ancestor['id']);ancestor['risk_id']=None
            self.service.store.update(c,'visits',ancestor,risk_id=None)
            report.pop('risk_id');report.pop('source_verification_id');report.pop('disposition')
            self.service.store.update(c,'verifications',report)
            before=tuple(c.execute('SELECT data FROM visits WHERE id=?',(ancestor['id'],)).fetchone())
        descendant=self.follow_up(report)
        self.assertEqual(descendant['risk_id'],run['risk_id'])
        result=self.report(descendant)
        self.assertEqual(result['risk_id'],run['risk_id'])
        self.assertEqual(result['source_verification_id'],report['id'])
        with self.service.store.connect() as c:
            self.assertEqual(tuple(c.execute('SELECT data FROM visits WHERE id=?',(ancestor['id'],)).fetchone()),before)

    def test_cyclic_follow_up_source_fails_closed_without_new_work(self):
        visit=self.visit(self.parcel['id']);report=self.report(visit)
        with self.service.store.connect(write=True) as c:
            original=self.service.store.get(c,'visits',visit['id'])
            self.service.store.update(c,'visits',{**original,'source_verification_id':report['id']})
        response=self.client.post(f"/api/v1/verifications/{report['id']}/follow-up-visits",json={'due_date':'2026-10-16'})
        self.assertEqual(response.status_code,422)
        self.assertEqual(response.json()['error']['code'],'invalid_follow_up_source')
        with self.service.store.connect() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM visits').fetchone()[0],1)

    def test_plain_report_without_candidate_still_appears_in_review_count(self):
        report=self.report(self.visit(self.parcel['id']))
        self.assertEqual(report['disposition'],'review_required')
        self.assertIsNone(report['risk_id'])
        dashboard=self.rows('dashboard')
        self.assertEqual(dashboard['review_required_count'],1)
        self.assertEqual(dashboard['open_risk_count'],0)
        self.assertEqual(dashboard['parcels'][0]['review_required_count'],1)

    def test_fresh_weather_cannot_refresh_stale_or_missing_optical(self):
        path=f"/api/v1/parcels/{self.parcel['id']}/observations"
        weather=self.post(path,self.observation(0,source='weather'))
        parcel=self.rows('dashboard')['parcels'][0]
        self.assertEqual(parcel['data_status'],'missing')
        self.assertEqual(parcel['optical_data_status'],'missing')
        self.assertEqual(parcel['weather_data_status'],'available')
        self.assertIsNone(parcel['latest_optical_observed_at'])
        self.assertEqual(parcel['latest_weather_observed_at'],weather['observed_at'])
        optical=self.post(path,self.observation(0,days=30))
        parcel=self.rows('dashboard')['parcels'][0]
        self.assertEqual(parcel['data_status'],'stale')
        self.assertEqual(parcel['optical_data_status'],'stale')
        self.assertEqual(parcel['weather_data_status'],'available')
        self.assertEqual(parcel['latest_observed_at'],optical['observed_at'])
        self.assertEqual(parcel['monitoring_status'],'blocked')

    def test_low_quality_optical_is_not_replaced_by_fresh_weather(self):
        path=f"/api/v1/parcels/{self.parcel['id']}/observations"
        bad=self.observation(0);bad['quality']['cloud_fraction']=.99
        self.post(path,bad);self.post(path,self.observation(0,source='weather'))
        parcel=self.rows('dashboard')['parcels'][0]
        self.assertEqual(parcel['optical_data_status'],'quality_limited')
        self.assertEqual(parcel['weather_data_status'],'available')
        self.assertFalse(parcel['monitoring_eligible'])


if __name__=='__main__': unittest.main()
