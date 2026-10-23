#!/usr/bin/env python3
"""Actual local HTTP smoke against the production build and an isolated empty DB."""
import json
import base64
from hashlib import sha256
from io import BytesIO
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
from PIL import Image, PngImagePlugin

ROOT=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='fieldsignal-http-') as temp:
    with socket.socket() as probe:
        probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
    base=f'http://127.0.0.1:{port}'
    env=os.environ|{'FIELDSIGNAL_DB':str(Path(temp)/'isolated.sqlite3'),'FIELDSIGNAL_ENABLE_FIXTURES':'0','PYTHONPATH':str(ROOT/'backend')}
    log=Path(temp)/'server.log'
    with log.open('w') as output:
        process=subprocess.Popen([sys.executable,'-m','uvicorn','app.main:app','--host','127.0.0.1','--port',str(port)],cwd=ROOT,env=env,stdout=output,stderr=output)
        try:
            for _ in range(100):
                try:
                    if process.poll() is not None: raise RuntimeError('Server exited: '+log.read_text())
                    with urllib.request.urlopen(base+'/api/v1/health',timeout=1) as response: health=json.load(response)
                    break
                except OSError:time.sleep(.1)
            else:raise RuntimeError('Local server did not become ready')
            def get(path):
                with urllib.request.urlopen(base+path,timeout=10) as response:return json.load(response)
            def post(path,body,key=None):
                headers={'Content-Type':'application/json','Origin':base}
                if key is not None: headers['Idempotency-Key']=key
                request=urllib.request.Request(base+path,data=json.dumps(body).encode(),headers=headers,method='POST')
                with urllib.request.urlopen(request,timeout=10) as response:return json.load(response)
            assert health['demo_enabled'] is False
            checked=[]
            for path in ['/admin','/field']:
                with urllib.request.urlopen(base+path) as response:
                    html=response.read().decode();assert response.status==200
                    assert "connect-src 'self'" in response.headers['Content-Security-Policy']
                    checked.append(path)
                for asset in re.findall(r'(?:src|href)="(/assets/[^"]+)"',html):
                    with urllib.request.urlopen(base+asset) as response:assert response.status==200;checked.append(asset)
            contract=get('/openapi.json');assert '/api/v1/sources' in contract['paths']
            preview=get('/api/v1/sources');assert not preview['imports'] and preview['public_sample']['available']
            payload={'sample_id':preview['public_sample']['sample_id']}
            first=post('/api/v1/source-imports/public-sample',payload)
            repeat=post('/api/v1/source-imports/public-sample',payload)
            assert first['created'] and not repeat['created'] and first['import']['id']==repeat['import']['id']
            stored=get('/api/v1/source-imports/'+first['import']['id'])
            assert len(stored['observations'])==4 and all(o['data_status']=='stale' for o in stored['observations'])
            assert abs(stored['observations'][0]['features']['ndvi']-.37450793780333835)<1e-12
            assert stored['observations'][0]['quality']['valid_fraction']==1012/1024
            assert len(get('/api/v1/sources')['imports'])==1
            dashboard=get('/api/v1/dashboard')
            assert all(dashboard[key]==0 for key in ['parcel_count','open_risk_count','pending_visit_count','verification_count'])
            # Synthetic, isolated API exercise only. This arbitrary polygon and
            # declared observations are not a real farm or satellite evidence.
            geometry={'type':'Polygon','coordinates':[[[0.0,0.0],[0.002,0.0],[0.002,0.002],[0.0,0.002],[0.0,0.0]]]}
            parcel_payload={'name':'HTTP synthetic test only — not a real field','region':'other','season':'2019-2020','geometry':geometry}
            parcel=post('/api/v1/parcels',parcel_payload,'http-synthetic-parcel')
            assert post('/api/v1/parcels',parcel_payload,'http-synthetic-parcel')==parcel
            visit_payload={'parcel_id':parcel['id'],'risk_id':None,'due_date':'2020-03-30','assignee':'Synthetic local label','note':'Synthetic task, no real farm'}
            visit=post('/api/v1/visits',visit_payload,'http-synthetic-visit')
            plan_payload={'expected_revision':0,'due_date':'2020-03-31','assignee':'Changed synthetic label'}
            plan=post(f"/api/v1/visits/{visit['id']}/plan",plan_payload,'http-synthetic-plan')
            assert post(f"/api/v1/visits/{visit['id']}/plan",plan_payload,'http-synthetic-plan')==plan
            # Creation replay remains the original receipt, not the newer plan.
            assert post('/api/v1/visits',visit_payload,'http-synthetic-visit')==visit
            event_payload={'occurred_on':'2020-03-30','kind':'drainage','note':'\u0085Synthetic historical event only\u0085'}
            event=post(f"/api/v1/parcels/{parcel['id']}/events",event_payload,'http-synthetic-event')
            assert event['note']=='Synthetic historical event only'
            assert post(f"/api/v1/parcels/{parcel['id']}/events",event_payload,'http-synthetic-event')==event
            image=BytesIO();Image.new('RGB',(8,8),(62,114,75)).save(image,format='PNG')
            def upload_synthetic_photo():
                request=urllib.request.Request(base+f"/api/v1/visits/{visit['id']}/photos",data=image.getvalue(),headers={'Content-Type':'image/png','Origin':base},method='POST')
                with urllib.request.urlopen(request,timeout=10) as response:return json.load(response)
            photo=upload_synthetic_photo()
            assert upload_synthetic_photo()==photo
            source_payload={'observed_at':'2020-03-30T20:00:00.123456+08:00','label':'uncertain','note':'\u0085Synthetic original report, requires a manual recheck\u0085','photo_ids':[photo['id']],'client_submission_id':'http-original-report'}
            source=post(f"/api/v1/visits/{visit['id']}/verifications",source_payload)
            assert source['disposition']=='review_required' and source['label_source']=='field_report_unadjudicated'
            assert post(f"/api/v1/visits/{visit['id']}/verifications",source_payload)==source
            confirmed_photo=upload_synthetic_photo()
            assert confirmed_photo['id']==photo['id'] and confirmed_photo['state']=='confirmed'
            follow_up_path=f"/api/v1/verifications/{source['id']}/follow-up-visits"
            follow_up_payload={'due_date':'2020-04-01','assignee':'Synthetic recheck label','note':'\u0085Explicit synthetic recheck only\u0085'}
            follow_up=post(follow_up_path,follow_up_payload,'http-follow-up')
            assert follow_up['source_verification_id']==source['id'] and follow_up['parcel_id']==parcel['id']
            assert follow_up['risk_id'] is None and follow_up['status']=='pending'
            assert post(follow_up_path,follow_up_payload,'http-follow-up')==follow_up
            try:post(follow_up_path,follow_up_payload,'http-second-pending-follow-up')
            except urllib.error.HTTPError as error:
                assert error.code==409 and json.load(error)['error']['code']=='duplicate_follow_up_visit'
            else:raise AssertionError('Duplicate pending follow-up unexpectedly succeeded')
            follow_up_plan_payload={'expected_revision':0,'due_date':'2020-04-02','assignee':'Changed synthetic recheck label'}
            follow_up_plan=post(f"/api/v1/visits/{follow_up['id']}/plan",follow_up_plan_payload,'http-follow-up-plan')
            assert follow_up_plan['source_verification_id']==source['id']
            recheck_payload={'observed_at':'2020-03-29T12:00:00Z','label':'normal','note':'Synthetic second report, not a diagnosis','photo_ids':[],'client_submission_id':'http-follow-up-report'}
            try:post(f"/api/v1/visits/{follow_up['id']}/verifications",recheck_payload)
            except urllib.error.HTTPError as error:
                assert error.code==422 and json.load(error)['error']['code']=='verification_before_source'
            else:raise AssertionError('Follow-up observed before original unexpectedly succeeded')
            recheck_payload['observed_at']='2020-03-31T12:00:00Z'
            recheck=post(f"/api/v1/visits/{follow_up['id']}/verifications",recheck_payload)
            assert recheck['disposition']=='review_required' and recheck['source_verification_id']==source['id']
            assert get('/api/v1/dashboard')['review_required_count']==2,'A normal follow-up is still not adjudication'
            assert post(f"/api/v1/visits/{follow_up['id']}/verifications",recheck_payload)==recheck
            actual_visits=get('/api/v1/visits');completed_follow_up=next(v for v in actual_visits if v['id']==follow_up['id'])
            assert completed_follow_up['status']=='completed' and completed_follow_up['source_verification_id']==source['id']
            assert next(v for v in get('/api/v1/verifications') if v['id']==source['id'])==source
            assert post(follow_up_path,follow_up_payload,'http-follow-up')==follow_up,'Creation replay remains its original pending snapshot'
            another_follow_up=post(follow_up_path,follow_up_payload,'http-later-explicit-follow-up')
            assert another_follow_up['id']!=follow_up['id'],'Completion allows another explicitly requested follow-up'
            receipt_module=(ROOT/'frontend/src/record-receipts.ts').as_uri()
            validation_script=(f'import {{validateParcelReceipt,validateVisitReceipt,validateFollowUpVisitReceipt,validateVisitPlanReceipt,validateFarmEventReceipt,validateVerificationReceipt,validatePhotoReceipt}} from {json.dumps(receipt_module)};'
                +"import {readFileSync} from 'node:fs';const x=JSON.parse(readFileSync(0,'utf8'));"
                +"validateParcelReceipt(x.parcel,x.parcel_payload);validateVisitReceipt(x.visit,x.visit_payload);"
                +"validateVisitPlanReceipt(x.plan,x.visit,x.plan_payload);validateFarmEventReceipt(x.event,x.parcel.id,x.event_payload);"
                +"validateFollowUpVisitReceipt(x.follow_up,x.source,x.follow_up_payload);"
                +"validateVisitPlanReceipt(x.follow_up_plan,x.follow_up,x.follow_up_plan_payload);"
                +"const original={visit_id:x.visit.id,parcel_id:x.parcel.id,data_origin:x.parcel.data_origin};"
                +"validateVerificationReceipt(x.source,original,x.source_payload);validateVerificationReceipt(x.recheck,{...original,visit_id:x.follow_up.id},x.recheck_payload);"
                +"validatePhotoReceipt(x.photo,x.visit.id,x.parcel.data_origin);validatePhotoReceipt(x.confirmed_photo,x.visit.id,x.parcel.data_origin);")
            subprocess.run(['node','--experimental-strip-types','--input-type=module','-e',validation_script],
                input=json.dumps({'parcel':parcel,'parcel_payload':parcel_payload,'visit':visit,'visit_payload':visit_payload,'plan':plan,'plan_payload':plan_payload,'event':event,'event_payload':event_payload,'source':source,'source_payload':source_payload,'follow_up':follow_up,'follow_up_payload':follow_up_payload,'follow_up_plan':follow_up_plan,'follow_up_plan_payload':follow_up_plan_payload,'photo':photo,'confirmed_photo':confirmed_photo,'recheck':recheck,'recheck_payload':recheck_payload}),
                text=True,capture_output=True,check=True,cwd=ROOT)

            geometry_digest=sha256(json.dumps(geometry,sort_keys=True,separators=(',',':')).encode()).hexdigest()
            batch={'schema_version':1,'bundle_id':'http-synthetic-six-periods','scope':'parcel','bundle_sha256':'a'*64,'processing_version':'http-synthetic-v1','limitations':['Synthetic test, not real field or satellite evidence'],'observations':[
                {'observed_at':f'2020-03-{day:02d}T00:00:00Z','source':'sentinel2','source_record_id':f'http-synthetic-{i}',
                 'features':{'ndvi':value},'quality':{'usable':True,'valid_fraction':0.95,'cloud_fraction':0.02,'flags':['synthetic_not_satellite_data']},
                 'provenance':{'provider':'synthetic-local-http-test','collection':'synthetic-test','item_id':f'http-synthetic-{i}','processing_version':'http-synthetic-v1','usage_scope':'parcel','parcel_geometry_sha256':geometry_digest,'parcel_mask_sha256':'b'*64,'asset_checksums':{'mask':'b'*64},'spatial_support':{'kind':'parcel'}}}
                for i,(day,value) in enumerate([(1,.70),(6,.71),(11,.69),(16,.70),(21,.70),(30,.38)])]}
            batch_path=f"/api/v1/parcels/{parcel['id']}/observation-batches"
            saved=post(batch_path,batch,'http-synthetic-batch')
            assert saved['created_count']==6 and saved['existing_count']==0
            assert post(batch_path,batch,'http-synthetic-batch')==saved
            repeated=post(batch_path,batch,'http-synthetic-batch-new-key')
            assert repeated['created_count']==0 and repeated['existing_count']==6
            assert [r['id'] for r in repeated['observations']]==[r['id'] for r in saved['observations']]
            changed=json.loads(json.dumps(batch));changed['observations'][2]['features']['ndvi']=.2
            try:post(batch_path,changed,'http-conflicting-batch')
            except urllib.error.HTTPError as error:
                assert error.code==409 and json.load(error)['error']['code']=='observation_content_conflict'
            else:raise AssertionError('Conflicting batch unexpectedly succeeded')
            assert len(get(f"/api/v1/parcels/{parcel['id']}/observations"))==6
            assert not get(f"/api/v1/parcels/{parcel['id']}/analyses"),'Import must not automatically run analysis'
            analysis=post(f"/api/v1/parcels/{parcel['id']}/analyses",{'method':'statistical'})
            assert analysis['status']=='blocked' and analysis['preview_status']=='stale','Historic synthetic input must not become a current alert'
            assert analysis['mode']=='preview' and analysis['monitoring_eligible'] is False and analysis['risk_id'] is None
            assert not get('/api/v1/risks'),'Declared local metrics must not create formal monitoring candidates'
            single_payload=json.loads(json.dumps(batch['observations'][0]))
            single_payload['source_record_id']='http-synthetic-single-record'
            single=post(f"/api/v1/parcels/{parcel['id']}/observations",single_payload)
            read_module=(ROOT/'frontend/src/read-contracts.ts').as_uri()
            farm_export_module=(ROOT/'frontend/src/farm-event-export.ts').as_uri()
            read_script=(f'import {{validateCoreRead,validateObservationRead,validateAnalysisRead,validateEventRead}} from {json.dumps(read_module)};'
                +f'import {{validateAnalysisReceipt,validateObservationReceipt}} from {json.dumps(receipt_module)};'
                +f'import {{farmEventCsv}} from {json.dumps(farm_export_module)};'
                +"import assert from 'node:assert/strict';"
                +"import {readFileSync} from 'node:fs';const x=JSON.parse(readFileSync(0,'utf8'));"
                +"validateCoreRead(x.core);validateObservationRead(x.observations,x.parcel_id);"
                +"validateAnalysisRead(x.analyses,x.parcel_id);validateEventRead(x.events,x.parcel_id);"
                +"validateAnalysisReceipt(x.analyses[0],x.core[1].parcels.find(p=>p.id===x.parcel_id),{method:'statistical'});"
                +"validateObservationReceipt(x.single,x.parcel_id,x.single_payload);"
                +"const before=JSON.stringify(x);const csv=farmEventCsv(x.events,x.core[1].parcels.find(p=>p.id===x.parcel_id),{},'Synthetic loaded HTTP snapshot');"
                +"assert.ok(csv.startsWith('\\uFEFF'));for(const e of x.events){assert.ok(csv.includes(e.id));assert.ok(csv.includes(e.occurred_on));assert.ok(csv.includes(e.created_at));}"
                +"assert.ok(csv.includes('非诊断'));assert.equal(JSON.stringify(x),before);")
            read_snapshot={'core':[health,get('/api/v1/dashboard'),get('/api/v1/risks'),get('/api/v1/visits'),get('/api/v1/verifications')],
                'parcel_id':parcel['id'],'observations':get(f"/api/v1/parcels/{parcel['id']}/observations"),
                'single':single,'single_payload':single_payload,
                'analyses':get(f"/api/v1/parcels/{parcel['id']}/analyses"),'events':get(f"/api/v1/parcels/{parcel['id']}/events")}
            subprocess.run(['node','--experimental-strip-types','--input-type=module','-e',read_script],
                input=json.dumps(read_snapshot),text=True,capture_output=True,check=True,cwd=ROOT)
            recovery_visit=post('/api/v1/visits',visit_payload,'http-photo-recovery-visit')
            alternate=BytesIO();metadata=PngImagePlugin.PngInfo();metadata.add_text('Synthetic note','same pixels, distinct PNG bytes')
            Image.new('RGB',(8,8),(62,114,75)).save(alternate,format='PNG',pnginfo=metadata)
            photo_recovery_run=subprocess.run(['node','--experimental-strip-types',str(ROOT/'scripts/photo-recovery-smoke.mjs')],
                input=json.dumps({'base':base,'visit':recovery_visit,'parcel':parcel,'images':[base64.b64encode(value).decode() for value in [image.getvalue(),alternate.getvalue()]]}),
                text=True,capture_output=True,cwd=ROOT)
            if photo_recovery_run.returncode:
                raise RuntimeError('Photo recovery smoke failed:\n'+photo_recovery_run.stderr)
            photo_recovery=json.loads(photo_recovery_run.stdout)
            print(json.dumps({'http':'passed','empty_default':True,'pages_assets':sorted(set(checked)),'sample_import_records':4,'repeat_created':repeat['created'],'farm_counts_after_public_sample':{k:dashboard[k] for k in ['parcel_count','open_risk_count','pending_visit_count','verification_count']},'optical_median_ndvi':stored['observations'][0]['features']['ndvi'],'synthetic_batch':{'created':saved['created_count'],'reused':repeated['existing_count'],'same_key_replayed':True,'conflict_atomic':True,'automatic_analysis':False,'manual_historic_analysis':analysis['status']},'mutation_receipts':{'parcel':True,'visit':True,'plan':True,'farm_event':True,'follow_up':True,'verification':True,'photo_staged_and_confirmed':True,'same_key_replayed':True,'frontend_validation':True,'unicode_normalization':True},'follow_up_flow':{'source_unchanged':True,'pending_duplicate_rejected':True,'before_source_rejected':True,'plan_and_completion_preserve_source':True,'creation_replay_after_completion':True,'later_explicit_follow_up':True},'photo_recovery':photo_recovery,'read_contracts':'passed actual HTTP core and detail payloads','farm_event_csv':'passed actual HTTP farm history snapshot without mutation','private_data_sent':False},ensure_ascii=False,indent=2))
        finally:
            process.terminate()
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:process.kill();process.wait()
