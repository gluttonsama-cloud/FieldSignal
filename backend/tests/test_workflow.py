"""Small integration suite: business guarantees, not mocked endpoint counts."""
import io
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timedelta, timezone
from pathlib import Path
from PIL import Image
from fastapi.testclient import TestClient
from app.main import create_app
from app.domain.detection import evaluate

UTC=timezone.utc

class FixedDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        value=cls(2026,10,15,1,0,0,tzinfo=UTC)
        return value.astimezone(tz) if tz else value.replace(tzinfo=None)

class WorkflowTests(unittest.TestCase):
    def setUp(self):
        # Stable seasonal/time-quality regressions, independent of the run date.
        self.clock_patches=[patch(name,FixedDatetime) for name in ['app.application.service.datetime','app.domain.models.datetime','app.domain.detection.datetime']]
        for clock in self.clock_patches: clock.start()
        self.temp=tempfile.TemporaryDirectory()
        self.db=Path(self.temp.name)/'test.db'
        self.client=TestClient(create_app(self.db,True))
        self.now=FixedDatetime.now(UTC)
        self.year=self.now.year if self.now.month>=7 else self.now.year-1

    def tearDown(self):
        self.client.close();self.temp.cleanup()
        for clock in self.clock_patches: clock.stop()

    def parcel(self,name='测试地块'):
        response=self.client.post('/api/v1/parcels',json={'name':name,'season':f'{self.year}-{self.year+1}','geometry':{'type':'Polygon','coordinates':[[[112.4,30.7],[112.402,30.7],[112.402,30.702],[112.4,30.702],[112.4,30.7]]]}})
        self.assertEqual(response.status_code,201,response.text)
        return response.json()

    def observation(self,days=1,value=.7,**overrides):
        data={'observed_at':(self.now-timedelta(days=days)).isoformat(),'source':'sentinel2','source_record_id':f's2-{days}','features':{'ndvi':value},'quality':{'usable':True,'valid_fraction':.9,'cloud_fraction':.03},'provenance':{'provider':'test-only','collection':'test-s2','item_id':f'item-{days}','processing_version':'test-v1'}}
        data.update(overrides);return data

    def fixture_risk(self):
        seed=self.client.post('/api/v1/dev/fixtures').json()
        p=seed['parcel_id']
        run=self.client.post(f'/api/v1/parcels/{p}/analyses',json={}).json()
        self.assertEqual(run['status'],'candidate')
        return p,run['risk_id']

    def visit(self,parcel_id,risk_id=None):
        response=self.client.post('/api/v1/visits',json={'parcel_id':parcel_id,'risk_id':risk_id,'due_date':self.now.date().isoformat()})
        self.assertEqual(response.status_code,201,response.text);return response.json()

    def test_empty_default_and_fixture_opt_in(self):
        c=TestClient(create_app(Path(self.temp.name)/'empty.db',False))
        self.assertEqual(c.get('/api/v1/dashboard').json()['parcel_count'],0)
        self.assertEqual(c.post('/api/v1/dev/fixtures').status_code,404)
        self.assertEqual(c.get('/api/v1/risks').json(),[])
        c.close()

    def test_closed_loop_and_retry_without_duplicates(self):
        parcel,risk=self.fixture_risk()
        run=self.client.post(f'/api/v1/parcels/{parcel}/analyses',json={}).json()
        self.assertEqual(run['risk_id'],risk)
        self.assertEqual(len(self.client.get('/api/v1/risks').json()),1)
        v=self.visit(parcel,risk)
        self.assertEqual(self.client.post('/api/v1/visits',json={'parcel_id':parcel,'risk_id':risk,'due_date':self.now.date().isoformat()}).status_code,409)
        payload={'observed_at':self.now.isoformat(),'label':'uncertain','note':'测试人工记录，不是真实地块事件','photo_ids':[],'client_submission_id':'unique-submit-001'}
        response=self.client.post(f"/api/v1/visits/{v['id']}/verifications",json=payload)
        self.assertEqual(response.status_code,201,response.text)
        retry=self.client.post(f"/api/v1/visits/{v['id']}/verifications",json=payload)
        self.assertEqual(response.json()['id'],retry.json()['id'])
        conflict=self.client.post(f"/api/v1/visits/{v['id']}/verifications",json={**payload,'note':'different'})
        self.assertEqual(conflict.status_code,409)
        self.assertEqual(self.client.get('/api/v1/visits').json()[0]['status'],'completed')
        self.assertEqual(self.client.get('/api/v1/risks').json()[0]['status'],'verified')
        self.assertEqual(self.client.get('/api/v1/dashboard').json()['verification_count'],1)
        # Running the same analysis never reopens a verified candidate.
        self.client.post(f'/api/v1/parcels/{parcel}/analyses',json={})
        self.assertEqual(self.client.get('/api/v1/risks').json()[0]['status'],'verified')

    def test_source_quality_time_and_provenance_validation(self):
        p=self.parcel()['id'];url=f'/api/v1/parcels/{p}/observations'
        self.assertEqual(self.client.post(url,json=self.observation()).status_code,201)
        self.assertEqual(self.client.post(url,json=self.observation()).status_code,409)
        for altered in [self.observation(2,observed_at='2026-01-01T00:00:00'),self.observation(2,observed_at=(self.now+timedelta(days=1)).isoformat()),self.observation(2,features={'ndvi':2}),self.observation(2,source='weather'),self.observation(2,quality={'usable':True,'valid_fraction':.9}),self.observation(2,provenance={}),self.observation(2,features={'ndvi':True})]:
            self.assertEqual(self.client.post(url,json=altered).status_code,422,altered)
        edge=self.observation(3,observed_at=f'{self.year}-07-01T00:00:00+08:00')
        self.assertEqual(self.client.post(url,json=edge).status_code,201)
        other_year=self.observation(4,observed_at='2020-01-01T00:00:00+00:00')
        self.assertEqual(self.client.post(url,json=other_year).status_code,422)

    def test_geometry_rejects_nonclosed_selfintersection_and_repeated_points(self):
        base={'name':'地块','season':f'{self.year}-{self.year+1}'}
        rings=[[[0,0],[1,0],[1,1],[0,1]],[[0,0],[1,1],[1,0],[0,1],[0,0]],[[0,0],[1,0],[0,0],[0,1],[0,0]]]
        for ring in rings:
            response=self.client.post('/api/v1/parcels',json={**base,'geometry':{'type':'Polygon','coordinates':[ring]}})
            self.assertEqual(response.status_code,422,response.text)

    def test_missing_data_never_reported_healthy(self):
        p=self.parcel()['id']
        result=self.client.post(f'/api/v1/parcels/{p}/analyses',json={}).json()
        self.assertEqual(result['status'],'insufficient_data')
        self.assertEqual(self.client.get('/api/v1/dashboard').json()['parcels'][0]['data_status'],'missing')
        self.assertEqual(self.client.get('/api/v1/risks').json(),[])

    def test_stale_low_quality_and_duplicate_day_are_excluded(self):
        observations=[]
        for i in range(7):
            o=self.observation(1+i*7,.4 if i==0 else .7);o['id']=str(i);observations.append(o)
        self.assertEqual(evaluate(observations,'statistical',self.now)['status'],'candidate')
        self.assertEqual(evaluate(observations,'statistical',self.now+timedelta(days=20))['status'],'stale')
        for o in observations: o['quality']['cloud_fraction']=.99
        self.assertEqual(evaluate(observations,'statistical',self.now)['status'],'insufficient_data')
        same_day=[]
        for i in range(8):
            o=self.observation(2);o['id']=str(i);same_day.append(o)
        self.assertEqual(evaluate(same_day,'statistical',self.now)['status'],'insufficient_data')

    def test_isolation_forest_runs_only_with_sufficient_past_samples(self):
        observations=[]
        for i in range(23):
            o=self.observation(1+i*3,.3 if i==0 else .69+(i%5)*.005);o['id']=str(i);observations.append(o)
        self.assertEqual(evaluate(observations[:10],'isolation_forest',self.now)['status'],'insufficient_data')
        result=evaluate(observations,'isolation_forest',self.now)
        self.assertEqual(result['status'],'candidate')
        self.assertEqual(result['risk']['evidence']['baseline_count'],22)
        self.assertEqual(result,evaluate(observations,'isolation_forest',self.now))

    def test_cross_parcel_risk_and_foreign_photos_are_rejected(self):
        parcel,risk=self.fixture_risk();other=self.parcel('另一地块')['id']
        response=self.client.post('/api/v1/visits',json={'parcel_id':other,'risk_id':risk,'due_date':self.now.date().isoformat()})
        self.assertEqual(response.status_code,422)
        v1=self.visit(parcel,risk);v2=self.visit(other)
        out=io.BytesIO();Image.new('RGB',(20,20),'green').save(out,format='PNG')
        photo=self.client.post(f"/api/v1/visits/{v1['id']}/photos",content=out.getvalue(),headers={'content-type':'image/png'})
        self.assertEqual(photo.status_code,201,photo.text)
        retried=self.client.post(f"/api/v1/visits/{v1['id']}/photos",content=out.getvalue(),headers={'content-type':'image/png'})
        self.assertEqual(photo.json()['id'],retried.json()['id'])
        response=self.client.post(f"/api/v1/visits/{v2['id']}/verifications",json={'observed_at':self.now.isoformat(),'label':'normal','note':'测试','photo_ids':[photo.json()['id']]})
        self.assertEqual(response.status_code,422)
        self.assertEqual(self.client.get('/api/v1/verifications').json(),[])
        got=self.client.get('/api/v1/photos/'+photo.json()['id'])
        self.assertEqual(got.status_code,200)
        self.assertEqual(Image.open(io.BytesIO(got.content)).getexif(),{})
        self.assertEqual(self.client.post(f"/api/v1/visits/{v1['id']}/photos",content=b'not-image',headers={'content-type':'image/png'}).status_code,422)

    def test_fixture_separation_events_persist_and_unknown_id(self):
        p=self.client.post('/api/v1/dev/fixtures').json()['parcel_id']
        self.assertFalse(self.client.post('/api/v1/dev/fixtures').json()['created'])
        self.assertEqual(self.client.post(f'/api/v1/parcels/{p}/observations',json=self.observation()).status_code,409)
        body={'occurred_on':self.now.date().isoformat(),'kind':'drainage','note':'开发模拟操作'}
        event=self.client.post(f'/api/v1/parcels/{p}/events',json=body)
        self.assertEqual(event.status_code,201)
        reopened=TestClient(create_app(self.db,False))
        self.assertEqual(reopened.get(f'/api/v1/parcels/{p}/events').json()[0]['id'],event.json()['id']);reopened.close()
        self.assertEqual(self.client.get('/api/v1/parcels/nonexistent').status_code,404)

    def test_verification_and_events_respect_season_and_trigger_time(self):
        parcel,risk=self.fixture_risk();visit=self.visit(parcel,risk)
        url=f"/api/v1/visits/{visit['id']}/verifications"
        base={'label':'normal','note':'测试观察记录','photo_ids':[]}
        self.assertEqual(self.client.post(url,json={**base,'observed_at':'2000-01-01T00:00:00Z'}).status_code,422)
        # In season but earlier than the latest trigger cannot resolve that candidate.
        early=(self.now-timedelta(days=2)).isoformat()
        self.assertEqual(self.client.post(url,json={**base,'observed_at':early}).status_code,422)
        self.assertEqual(self.client.get('/api/v1/visits').json()[0]['status'],'pending')
        self.assertEqual(self.client.post(f'/api/v1/parcels/{parcel}/events',json={'occurred_on':'2000-01-01','kind':'sowing','note':'错误季节'}).status_code,422)
        # Legitimate historic parcel seasons and later-entered records remain supported.
        old=self.client.post('/api/v1/parcels',json={'name':'历史季地块','season':'2019-2020','geometry':self.parcel()['geometry']}).json()
        v=self.visit(old['id'])
        response=self.client.post(f"/api/v1/visits/{v['id']}/verifications",json={**base,'observed_at':'2020-03-01T00:00:00Z'})
        self.assertEqual(response.status_code,201,response.text)
        self.assertEqual(self.client.post(f"/api/v1/parcels/{old['id']}/events",json={'occurred_on':'2019-10-01','kind':'sowing','note':'历史真实记录入口测试'}).status_code,201)

    def test_staged_photo_replacement_and_final_reference_lifecycle(self):
        p=self.parcel()['id'];v=self.visit(p);ids=[]
        def upload(color):
            out=io.BytesIO();Image.new('RGB',(20,20),color).save(out,format='PNG')
            return self.client.post(f"/api/v1/visits/{v['id']}/photos",content=out.getvalue(),headers={'content-type':'image/png'})
        for i in range(8):
            response=upload((i*30,100,150));self.assertEqual(response.status_code,201);ids.append(response.json()['id'])
        self.assertEqual(upload((245,200,100)).status_code,409)
        delete=f"/api/v1/visits/{v['id']}/photos/{ids[0]}"
        self.assertEqual(self.client.delete(delete).status_code,204)
        self.assertEqual(self.client.delete(delete).status_code,204)
        replacement=upload((245,200,100));self.assertEqual(replacement.status_code,201)
        selected=[replacement.json()['id']]
        response=self.client.post(f"/api/v1/visits/{v['id']}/verifications",json={'observed_at':self.now.isoformat(),'label':'uncertain','note':'仅保留选中照片','photo_ids':selected})
        self.assertEqual(response.status_code,201,response.text)
        self.assertEqual(self.client.get('/api/v1/photos/'+selected[0]).status_code,200)
        self.assertEqual(self.client.get('/api/v1/photos/'+ids[1]).status_code,404)
        self.assertEqual(self.client.delete(f"/api/v1/visits/{v['id']}/photos/{selected[0]}").status_code,409)

    def test_foreign_origin_and_host_blocked(self):
        self.assertEqual(self.client.get('/api/v1/dashboard',headers={'origin':'https://untrusted.example'}).status_code,403)
        self.assertEqual(self.client.get('/api/v1/dashboard',headers={'host':'untrusted.example'}).status_code,400)

if __name__=='__main__': unittest.main()
