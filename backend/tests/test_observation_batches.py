"""Atomic normalized-bundle import, through real HTTP validation and SQLite."""
import asyncio
import copy
from hashlib import sha256
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.adapters.local_bundle import LocalObservationBundleAdapter, PROCESSING_VERSION, geometry_sha256
from app.adapters.storage import SCHEMA_VERSION
from app.api.routes import MAX_OBSERVATION_BATCH_BYTES
from app.domain.models import ObservationCreate
from app.main import create_app
from test_idempotency import LoseCommittedResponse


class ObservationBatchTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db=Path(self.temp.name)/'batches.db'
        self.app=create_app(self.db,False)
        self.client=self.new_client(self.app)
        self.geometry={'type':'Polygon','coordinates':[[[112.4,30.7],[112.402,30.7],[112.402,30.702],[112.4,30.702],[112.4,30.7]]]}
        self.parcel_body={'name':'批量测试边界，不是真实农田','season':'2019-2020','geometry':self.geometry}
        self.parcel_id=self.create_parcel()
        self.url=f'/api/v1/parcels/{self.parcel_id}/observation-batches'

    def new_client(self,app):
        client=TestClient(app)
        self.addCleanup(client.close)
        return client

    def create_parcel(self):
        response=self.client.post('/api/v1/parcels',json=self.parcel_body)
        self.assertEqual(response.status_code,201,response.text)
        return response.json()['id']

    def observation(self,index=1,source='weather'):
        result={
            'observed_at':'2020-03-01T00:00:00Z',
            'source':source,
            'source_record_id':f'local-test-{source}-{index}',
            'features':{'precipitation_mm':1.25},
            'quality':{'usable':True,'valid_fraction':1.0},
            'provenance':{
                'provider':'local-test-provider','collection':'local-test-collection',
                'item_id':f'local-test-{source}-{index}','processing_version':PROCESSING_VERSION,
                'usage_scope':'parcel','parcel_geometry_sha256':geometry_sha256(self.geometry),
                'spatial_support':{'kind':'coarse_grid'},
                'asset_checksums':{'input':'a'*64},
            },
        }
        if source=='sentinel2':
            result['features']={'ndvi':.45}
            result['quality']['cloud_fraction']=.1
            result['provenance']['spatial_support']={'kind':'parcel'}
            result['provenance']['parcel_mask_sha256']='b'*64
            result['provenance']['asset_checksums']['mask']='b'*64
        return result

    def bundle(self,count=3):
        return {
            'schema_version':1,'bundle_id':'local-test-bundle','scope':'parcel',
            'bundle_sha256':'c'*64,'processing_version':PROCESSING_VERSION,
            'observations':[self.observation(index) for index in range(count)],
            'limitations':['仅为隔离测试，不代表田间实测。'],
        }

    def post(self,body=None,key=None,client=None,url=None):
        headers={} if key is None else {'Idempotency-Key':key}
        return (client or self.client).post(url or self.url,json=body or self.bundle(),headers=headers)

    def count(self,table):
        with sqlite3.connect(self.db) as c:
            return c.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]

    def observations(self):
        return self.client.get(f'/api/v1/parcels/{self.parcel_id}/observations').json()

    def assert_rejected(self,response,code,status=422,observations=0,receipts=0):
        self.assertEqual(response.status_code,status,response.text)
        self.assertEqual(response.json()['error']['code'],code,response.text)
        self.assertEqual(self.count('observations'),observations)
        self.assertEqual(self.count('idempotency_receipts'),receipts)

    def test_success_preserves_order_provenance_and_never_runs_analysis(self):
        body=self.bundle()
        body['observations'][1]=self.observation(1,'sentinel2')
        result=self.post(body,'success')
        self.assertEqual(result.status_code,201,result.text)
        receipt=result.json()
        self.assertEqual(set(receipt),{'id','parcel_id','bundle_id','bundle_sha256','processing_version','created_at','created_count','existing_count','observations'})
        self.assertEqual(receipt['created_count'],3)
        self.assertEqual(receipt['existing_count'],0)
        self.assertEqual(receipt['parcel_id'],self.parcel_id)
        self.assertEqual(receipt['bundle_sha256'],body['bundle_sha256'])
        self.assertEqual([row['source_record_id'] for row in receipt['observations']],[row['source_record_id'] for row in body['observations']])
        self.assertTrue(all(row['status']=='created' for row in receipt['observations']))
        self.assertEqual(set(receipt['observations'][0]),{'id','source','source_record_id','observed_at','status'})
        for row in self.observations():
            expected=next(o for o in body['observations'] if o['source_record_id']==row['source_record_id'])
            self.assertEqual(row['provenance'],ObservationCreate.model_validate(expected).model_dump(mode='json',exclude_none=True)['provenance'])
            self.assertEqual(row['data_origin'],'user')
        for table in ['analyses','risks','visits','source_imports']:
            self.assertEqual(self.count(table),0)
        with sqlite3.connect(self.db) as c:
            self.assertEqual(c.execute('PRAGMA user_version').fetchone()[0],SCHEMA_VERSION)

    def test_current_normalization_cli_output_imports_without_reshaping(self):
        root=Path(self.temp.name)
        inputs=root/'synthetic-inputs'
        inputs.mkdir()
        weather={
            'geometry':{'coordinates':[112.4,30.7]},
            'header':{'time_standard':'UTC','sources':['MERRA2'],'start':'20200301','end':'20200301','fill_value':-999,'api':{'version':'test-only'}},
            'parameters':{'T2M_MIN':{'units':'C'},'T2M_MAX':{'units':'C'},'PRECTOTCORR':{'units':'mm/day'}},
            'properties':{'parameter':{'T2M_MIN':{'20200301':2},'T2M_MAX':{'20200301':12},'PRECTOTCORR':{'20200301':1.25}}},
        }
        source=inputs/'synthetic-weather.json'
        source.write_text(json.dumps(weather))
        manifest={
            'schema_version':1,'bundle_id':'synthetic-cli-test','scope':'parcel','title':'Synthetic test only',
            'files':{'weather':{'path':source.name,'sha256':sha256(source.read_bytes()).hexdigest()}},
            'records':[{'adapter':'nasa_power_daily','data':'weather','retrieved_at':'2020-03-02T00:00:00Z','provider':'test-only synthetic provider','license':'synthetic test','source_uri':'local:synthetic-test'}],
            'limitations':['Synthetic test only'],'parcel_geometry_sha256':geometry_sha256(self.geometry),
        }
        manifest_path=inputs/'manifest.json'
        manifest_path.write_text(json.dumps(manifest))
        geometry_path=root/'geometry.json'
        geometry_path.write_text(json.dumps(self.geometry))
        output=root/'normalized.json'
        script=Path(__file__).resolve().parents[2]/'scripts'/'normalize-observation-bundle.py'
        normalized=subprocess.run([sys.executable,str(script),'--manifest',str(manifest_path),'--parcel-geometry',str(geometry_path),'--output',str(output)],capture_output=True,text=True,timeout=30)
        self.assertEqual(normalized.returncode,0,normalized.stderr)
        response=self.client.post(self.url,content=output.read_bytes(),headers={'Content-Type':'application/json','Idempotency-Key':'cli-import'})
        self.assertEqual(response.status_code,201,response.text)
        self.assertEqual(response.json()['created_count'],1)
        self.assertEqual(response.json()['bundle_sha256'],sha256(manifest_path.read_bytes()).hexdigest())
        # A non-public optional source registry is not an import crash and does
        # not turn a parcel-bound normalized bundle into a public sample.
        reopened=self.new_client(create_app(self.db,False,manifest_path))
        retry=reopened.post(self.url,content=output.read_bytes(),headers={'Content-Type':'application/json'})
        self.assertEqual(retry.status_code,201,retry.text)
        self.assertEqual(retry.json()['existing_count'],1)

    def test_mixed_exact_existing_and_new_reuses_original_row(self):
        body=self.bundle()
        single=self.client.post(f'/api/v1/parcels/{self.parcel_id}/observations',json=body['observations'][1])
        self.assertEqual(single.status_code,201,single.text)
        # Defaulted optional fields and equivalent timezone representations are
        # the same normalized ObservationCreate, not different evidence.
        body['observations'][1]=ObservationCreate.model_validate(body['observations'][1]).model_dump(mode='json')
        body['observations'][1]['observed_at']='2020-03-01T08:00:00+08:00'
        result=self.post(body,'mixed')
        self.assertEqual(result.status_code,201,result.text)
        receipt=result.json()
        self.assertEqual([row['status'] for row in receipt['observations']],['created','existing','created'])
        self.assertEqual((receipt['created_count'],receipt['existing_count']),(2,1))
        self.assertEqual(receipt['observations'][1]['id'],single.json()['id'])
        stored=next(row for row in self.observations() if row['id']==single.json()['id'])
        self.assertEqual(stored,single.json())

    def test_new_key_or_no_key_repeats_without_duplicates(self):
        first=self.post(key='first').json()
        original=self.observations()
        for key in [None,'second','third',None]:
            response=self.post(key=key)
            self.assertEqual(response.status_code,201,response.text)
            receipt=response.json()
            self.assertNotEqual(receipt['id'],first['id'])
            self.assertEqual((receipt['created_count'],receipt['existing_count']),(0,3))
            self.assertEqual([row['id'] for row in receipt['observations']],[row['id'] for row in first['observations']])
            self.assertEqual(self.observations(),original)
        self.assertEqual(self.count('idempotency_receipts'),3)

    def test_every_normalized_content_field_participates_in_exact_reuse(self):
        original=self.bundle(1)
        self.assertEqual(self.post(original,'original').status_code,201)
        stored=self.observations()
        changes=[
            ('observed_at','2020-03-02T00:00:00Z'),
            ('features.precipitation_mm',2.0),
            ('quality.usable',False),('quality.valid_fraction',.9),('quality.flags',['new flag']),
            ('provenance.provider','different'),('provenance.collection','different'),
            ('provenance.item_id','different'),('provenance.license','different'),
            ('provenance.source_uri','https://example.invalid/local'),
            ('provenance.temporal_support','daily_utc'),
            ('provenance.support_note','different'),
            ('provenance.retrieved_at','2020-03-02T00:00:00Z'),
            ('provenance.spatial_support',{'kind':'coarse_grid','grid_degrees':{'latitude':.5}}),
            ('provenance.asset_checksums',{'input':'d'*64}),
            ('provenance.spatial_resolution_m',50000.0),
        ]
        for field,value in changes:
            with self.subTest(field=field):
                body=copy.deepcopy(original)
                obj=body['observations'][0]
                parts=field.split('.')
                for part in parts[:-1]: obj=obj[part]
                obj[parts[-1]]=value
                response=self.post(body,f'changed-{field}')
                self.assert_rejected(response,'observation_content_conflict',409,1,1)
                self.assertIn('第1条',response.json()['error']['message'])
                self.assertEqual(self.observations(),stored)

    def test_conflicting_middle_record_rolls_back_earlier_new_row(self):
        body=self.bundle()
        single=self.client.post(f'/api/v1/parcels/{self.parcel_id}/observations',json=body['observations'][1])
        self.assertEqual(single.status_code,201,single.text)
        body['observations'][1]['features']['precipitation_mm']=9.0
        rejected=self.post(body,'conflicting-middle')
        self.assert_rejected(rejected,'observation_content_conflict',409,1)
        self.assertIn('第2条',rejected.json()['error']['message'])
        self.assertIn('local-test-weather-1',rejected.json()['error']['message'])
        self.assertEqual(self.observations(),[single.json()])
        # A rejected operation does not claim the key.
        body['observations'][1]['features']['precipitation_mm']=1.25
        repaired=self.post(body,'conflicting-middle')
        self.assertEqual(repaired.status_code,201,repaired.text)
        self.assertEqual((repaired.json()['created_count'],repaired.json()['existing_count']),(2,1))

    def test_exact_reuse_ignores_object_order_not_changed_numeric_serialization(self):
        body=self.bundle(1)
        row=body['observations'][0]
        row['features']['precipitation_mm']=0.0
        row['provenance']['asset_checksums']['second-input']='d'*64
        self.assertEqual(self.post(body,'zero-original').status_code,201)
        row['provenance']['asset_checksums']=dict(reversed(list(row['provenance']['asset_checksums'].items())))
        existing=self.post(body,'reordered')
        self.assertEqual(existing.status_code,201,existing.text)
        self.assertEqual(existing.json()['existing_count'],1)
        row['features']['precipitation_mm']=-0.0
        self.assert_rejected(self.post(body,'signed-zero'),'observation_content_conflict',409,1,2)

    def test_invalid_middle_service_record_rolls_back_all_and_key_remains_free(self):
        body=self.bundle()
        body['observations'][1]['observed_at']='2021-03-01T00:00:00Z'
        rejected=self.post(body,'outside-season')
        self.assert_rejected(rejected,'outside_season')
        self.assertIn('第2条',rejected.json()['error']['message'])
        body['observations'][1]['observed_at']='2020-03-01T00:00:00Z'
        self.assertEqual(self.post(body,'outside-season').status_code,201)

    def test_invalid_middle_model_record_writes_nothing(self):
        body=self.bundle()
        body['observations'][1]['features']['precipitation_mm']=-1.0
        rejected=self.post(body,'invalid-model')
        self.assert_rejected(rejected,'validation_error')
        self.assertTrue(any(detail['field']=='body.observations.1.features.precipitation_mm' for detail in rejected.json()['error']['details']))

    def test_duplicate_source_identity_in_batch_is_rejected_not_reused(self):
        body=self.bundle()
        body['observations'][1]=copy.deepcopy(body['observations'][0])
        body['observations'][1]['source_record_id']=' '+body['observations'][1]['source_record_id']+' '
        rejected=self.post(body,'duplicate-input')
        self.assert_rejected(rejected,'duplicate_batch_observation')
        self.assertIn('第2条',rejected.json()['error']['message'])

    def test_same_record_id_from_different_sources_is_distinct(self):
        body=self.bundle(2)
        body['observations'][1]=self.observation(1,'sentinel2')
        body['observations'][1]['source_record_id']=body['observations'][0]['source_record_id']
        response=self.post(body)
        self.assertEqual(response.status_code,201,response.text)
        self.assertEqual(response.json()['created_count'],2)

    def test_each_record_must_be_parcel_bound_and_version_consistent(self):
        cases=[
            ('scope',lambda row:row['provenance'].update(usage_scope='unverified'),'parcel_scope_required'),
            ('missing_scope',lambda row:row['provenance'].pop('usage_scope'),'parcel_scope_required'),
            ('geometry',lambda row:row['provenance'].update(parcel_geometry_sha256='0'*64),'geometry_binding_mismatch'),
            ('missing_geometry',lambda row:row['provenance'].pop('parcel_geometry_sha256'),'geometry_binding_mismatch'),
            ('version',lambda row:row['provenance'].update(processing_version='different'),'processing_version_mismatch'),
            ('public_scope',lambda row:row['provenance'].update(usage_scope='public_sample'),'public_sample_not_parcel'),
            ('public_window',lambda row:row['provenance'].update(spatial_support={'kind':'public_window'}),'public_sample_not_parcel'),
            ('public_flag',lambda row:row['quality'].update(flags=['no_crop_truth']),'public_sample_not_parcel'),
        ]
        for name,change,code in cases:
            with self.subTest(case=name):
                body=self.bundle()
                change(body['observations'][1])
                rejected=self.post(body,name)
                self.assert_rejected(rejected,code)
                self.assertIn('第2条',rejected.json()['error']['message'])

    def test_optical_record_requires_bound_mask_and_parcel_support(self):
        for change in ['missing_mask','wrong_mask','missing_support','wrong_support']:
            with self.subTest(change=change):
                body=self.bundle()
                body['observations'][1]=self.observation(1,'sentinel2')
                provenance=body['observations'][1]['provenance']
                if change=='missing_mask': provenance.pop('parcel_mask_sha256')
                elif change=='wrong_mask': provenance['parcel_mask_sha256']='d'*64
                elif change=='missing_support': provenance.pop('spatial_support')
                else: provenance['spatial_support']['kind']='coarse_grid'
                self.assert_rejected(self.post(body,change),'parcel_mask_binding_missing')

    def test_recognized_public_sample_still_rejected_after_relabeling(self):
        public,_=LocalObservationBundleAdapter(self.app.state.service.source_imports.manifest).normalize()
        original=public[0].model_dump(mode='json',exclude_none=True)
        for match in ['source_id','asset_hash']:
            with self.subTest(match=match):
                body=self.bundle()
                row=body['observations'][1]
                if match=='source_id':
                    row['source']=original['source']
                    row['source_record_id']=original['source_record_id']
                    row['features']={'ndvi':.4}
                    row['quality']['cloud_fraction']=.1
                else: row['provenance']['asset_checksums']=original['provenance']['asset_checksums']
                self.assert_rejected(self.post(body,match),'public_sample_not_parcel')

    def test_prior_public_sample_remains_recognizable_if_original_files_disappear(self):
        service=self.app.state.service.source_imports
        adapter=LocalObservationBundleAdapter(service.manifest)
        imported=self.client.post('/api/v1/source-imports/public-sample',json={'sample_id':adapter.manifest.bundle_id})
        self.assertEqual(imported.status_code,201,imported.text)
        body=self.bundle()
        body['observations'][1]['provenance']['asset_checksums']=imported.json()['import']['observations'][0]['provenance']['asset_checksums']
        with patch.object(service,'manifest',Path(self.temp.name)/'unavailable-manifest.json'):
            self.assert_rejected(self.post(body,'remember-public'),'public_sample_not_parcel')

    def test_season_boundary_uses_beijing_date(self):
        body=self.bundle(1)
        body['observations'][0]['observed_at']='2020-06-30T15:59:59Z'
        accepted=self.post(body,'last-season-second')
        self.assertEqual(accepted.status_code,201,accepted.text)
        outside=self.bundle(2)
        outside['observations'][0]['source_record_id']='new-first-record'
        outside['observations'][1]['observed_at']='2020-06-30T16:00:00Z'
        self.assert_rejected(self.post(outside,'next-season'),'outside_season',observations=1,receipts=1)

    def test_fixture_target_rejected_and_missing_target_not_found(self):
        fixture_client=self.new_client(create_app(self.db,True))
        fixture=fixture_client.post('/api/v1/dev/fixtures').json()
        count=self.count('observations')
        response=self.post(key='fixture',url=f'/api/v1/parcels/{fixture["parcel_id"]}/observation-batches')
        self.assert_rejected(response,'fixture_readonly',409,count)
        missing=self.post(key='missing',url='/api/v1/parcels/missing/observation-batches')
        self.assert_rejected(missing,'not_found',404,count)

    def test_same_key_replay_after_lost_response_and_database_reopen(self):
        body=self.bundle()
        dropped=LoseCommittedResponse(self.app)
        with self.assertRaisesRegex(ConnectionResetError,'committed response lost'):
            self.post(body,'lost-response',self.new_client(dropped))
        self.assertEqual(self.count('observations'),3)
        self.assertEqual(self.count('idempotency_receipts'),1)
        status,original=dropped.response()
        self.assertEqual(status,201)
        reopened=self.new_client(create_app(self.db,False))
        for client in [reopened,self.client,reopened]:
            retry=self.post(body,'lost-response',client)
            self.assertEqual(retry.status_code,201,retry.text)
            self.assertEqual(retry.json(),original)
        self.assertEqual(self.count('observations'),3)
        self.assertEqual(self.count('idempotency_receipts'),1)

    def test_idempotency_uses_normalized_defaults_not_raw_json_format(self):
        body=self.bundle()
        original=self.post(body,'canonical')
        self.assertEqual(original.status_code,201,original.text)
        body['observations']=[ObservationCreate.model_validate(row).model_dump(mode='json') for row in body['observations']]
        for row in body['observations']: row['observed_at']='2020-03-01T08:00:00+08:00'
        response=self.client.post(self.url,content=json.dumps(body,sort_keys=True,indent=4),headers={'Content-Type':'application/json','Idempotency-Key':'canonical'})
        self.assertEqual(response.status_code,201,response.text)
        self.assertEqual(response.json(),original.json())

    def test_invalid_or_multiple_idempotency_headers_write_nothing(self):
        for key in ['', 'has a space', 'x'*129]:
            self.assert_rejected(self.post(key=key),'invalid_idempotency_key')
        response=self.client.post(self.url,json=self.bundle(),headers=[('Idempotency-Key','one'),('Idempotency-Key','two')])
        self.assert_rejected(response,'invalid_idempotency_key')

    def test_same_key_changed_payload_target_or_operation_conflicts(self):
        body=self.bundle()
        self.assertEqual(self.post(body,'bound-key').status_code,201)
        for field,value in [('bundle_id','other'),('bundle_sha256','d'*64),('limitations',['different'])]:
            changed={**body,field:value}
            self.assert_rejected(self.post(changed,'bound-key'),'idempotency_conflict',409,3,1)
        changed=copy.deepcopy(body)
        changed['observations'][0]['features']['precipitation_mm']=2.0
        self.assert_rejected(self.post(changed,'bound-key'),'idempotency_conflict',409,3,1)
        for target in [self.create_parcel(),'missing']:
            self.assert_rejected(self.post(body,'bound-key',url=f'/api/v1/parcels/{target}/observation-batches'),'idempotency_conflict',409,3,1)
        event=self.client.post(f'/api/v1/parcels/{self.parcel_id}/events',json={'occurred_on':'2020-03-01','kind':'other','note':'测试'},headers={'Idempotency-Key':'bound-key'})
        self.assert_rejected(event,'idempotency_conflict',409,3,1)
        parcel=self.client.post('/api/v1/parcels',json=self.parcel_body,headers={'Idempotency-Key':'parcel-key'})
        self.assertEqual(parcel.status_code,201,parcel.text)
        self.assert_rejected(self.post(body,'parcel-key'),'idempotency_conflict',409,3,2)

    def concurrent_posts(self,keys,bodies=None):
        clients=[self.new_client(create_app(self.db,False)) for _ in keys]
        bodies=bodies or [self.bundle() for _ in keys]
        barrier=Barrier(len(keys))
        def submit(args):
            client,key,body=args
            barrier.wait(timeout=10)
            return self.post(body,key,client)
        with ThreadPoolExecutor(max_workers=len(keys)) as pool:
            return list(pool.map(submit,zip(clients,keys,bodies)))

    def test_concurrent_same_key_returns_one_exact_receipt(self):
        responses=self.concurrent_posts(['concurrent']*4)
        self.assertTrue(all(r.status_code==201 for r in responses),[r.text for r in responses])
        self.assertTrue(all(r.json()==responses[0].json() for r in responses))
        self.assertEqual(responses[0].json()['created_count'],3)
        self.assertEqual(self.count('observations'),3)
        self.assertEqual(self.count('idempotency_receipts'),1)

    def test_concurrent_different_keys_and_no_key_do_not_duplicate(self):
        responses=self.concurrent_posts(['one','two',None,None])
        self.assertTrue(all(r.status_code==201 for r in responses),[r.text for r in responses])
        self.assertEqual(sum(r.json()['created_count'] for r in responses),3)
        self.assertEqual(sum(r.json()['existing_count'] for r in responses),9)
        self.assertEqual(self.count('observations'),3)
        self.assertEqual(self.count('idempotency_receipts'),2)

    def test_concurrent_same_key_different_content_does_not_mix_rows(self):
        original=self.bundle()
        changed=copy.deepcopy(original)
        changed['observations'][1]['features']['precipitation_mm']=9.0
        responses=self.concurrent_posts(['conflicting']*2,[original,changed])
        self.assertEqual(sorted(r.status_code for r in responses),[201,409])
        self.assertEqual(self.count('observations'),3)
        self.assertEqual(self.count('idempotency_receipts'),1)
        failed=next(r for r in responses if r.status_code==409)
        self.assertEqual(failed.json()['error']['code'],'idempotency_conflict')

    def test_receipt_write_failure_rolls_back_observations_too(self):
        with patch.object(self.app.state.service.store,'insert_receipt',side_effect=RuntimeError('simulated storage failure')):
            with self.assertRaisesRegex(RuntimeError,'simulated storage failure'):
                self.post(key='failed-receipt')
        self.assertEqual(self.count('observations'),0)
        self.assertEqual(self.count('idempotency_receipts'),0)
        self.assertEqual(self.post(key='failed-receipt').status_code,201)

    def test_exact_model_shape_and_record_limit(self):
        for count in [0,501]:
            self.assert_rejected(self.post(self.bundle(count),'count-limit'),'validation_error')
        for field,value in [('scope','public_sample'),('schema_version',True),('schema_version','1'),('schema_version',2),('bundle_sha256','not-a-hash'),('parcel_id',self.parcel_id),('run_analysis',True)]:
            with self.subTest(field=field,value=value):
                body=self.bundle()
                body[field]=value
                self.assert_rejected(self.post(body,'invalid-envelope'),'validation_error')
        for field in self.bundle():
            body=self.bundle()
            del body[field]
            self.assert_rejected(self.post(body,'missing-field'),'validation_error')
        maximum=self.post(self.bundle(500),'maximum')
        self.assertEqual(maximum.status_code,201,maximum.text)
        self.assertEqual(maximum.json()['created_count'],500)

    def test_record_cannot_supply_server_metadata_or_extra_fields(self):
        for field,value in [('parcel_id',self.create_parcel()),('data_origin','fixture'),('id','obs_user-supplied'),('created_at','2020-03-01T00:00:00Z'),('extra',True)]:
            body=self.bundle()
            body['observations'][1][field]=value
            self.assert_rejected(self.post(body,'record-extra'),'validation_error')

    def test_size_limit_counts_raw_bytes_not_characters_or_content_length(self):
        for headers in [
            {'Content-Type':'application/json'},
            {'Content-Type':'application/json','Content-Length':'1'},
        ]:
            body=self.bundle(1)
            body['limitations']=['测'*(MAX_OBSERVATION_BATCH_BYTES//3)]
            raw=json.dumps(body,ensure_ascii=False).encode()
            self.assertGreater(len(raw),MAX_OBSERVATION_BATCH_BYTES)
            self.assertLess(len(raw.decode()),MAX_OBSERVATION_BATCH_BYTES)
            response=self.client.post(self.url,content=raw,headers=headers)
            self.assert_rejected(response,'observation_batch_too_large',413)

    def test_exact_one_mib_request_is_allowed_and_one_more_byte_is_rejected(self):
        raw=json.dumps(self.bundle(1)).encode()
        padded=raw+b' '*(MAX_OBSERVATION_BATCH_BYTES-len(raw))
        good=self.client.post(self.url,content=padded,headers={'Content-Type':'application/json'})
        self.assertEqual(good.status_code,201,good.text)
        rejected=self.client.post(self.url,content=padded+b' ',headers={'Content-Type':'application/json'})
        self.assert_rejected(rejected,'observation_batch_too_large',413,1)

    def test_chunked_body_without_length_is_bounded_before_json_parsing(self):
        messages=[]
        consumed=[]
        async def request():
            done=asyncio.Event()
            chunks=iter([b' '*(MAX_OBSERVATION_BATCH_BYTES//2)]*3+[b'never consumed'])
            async def receive():
                try: chunk=next(chunks)
                except StopIteration:
                    await done.wait()
                    return {'type':'http.disconnect'}
                consumed.append(len(chunk))
                return {'type':'http.request','body':chunk,'more_body':True}
            async def send(message):
                messages.append(message)
                if message['type']=='http.response.body' and not message.get('more_body',False):
                    done.set()
            scope={'type':'http','asgi':{'version':'3.0'},'http_version':'1.1','method':'POST','scheme':'http','path':self.url,'raw_path':self.url.encode(),'query_string':b'','root_path':'','headers':[(b'host',b'testserver'),(b'content-type',b'application/json')],'client':('127.0.0.1',1234),'server':('testserver',80)}
            await self.app(scope,receive,send)
        asyncio.run(request())
        self.assertEqual(next(message['status'] for message in messages if message['type']=='http.response.start'),413)
        self.assertEqual(consumed,[MAX_OBSERVATION_BATCH_BYTES//2]*3)
        self.assertEqual(self.count('observations'),0)
        self.assertEqual(self.count('idempotency_receipts'),0)

    def test_single_observation_route_and_batch_openapi_remain_typed(self):
        single=self.observation()
        single['provenance'].pop('usage_scope')
        single['provenance'].pop('parcel_geometry_sha256')
        url=f'/api/v1/parcels/{self.parcel_id}/observations'
        self.assertEqual(self.client.post(url,json=single).status_code,201)
        self.assert_rejected(self.client.post(url,json=single),'duplicate_observation',409,1)
        schema=self.client.get('/openapi.json').json()
        operation=schema['paths']['/api/v1/parcels/{parcel_id}/observation-batches']['post']
        self.assertEqual(operation['requestBody']['content']['application/json']['schema']['$ref'],'#/components/schemas/ObservationBatchCreate')
        batch=schema['components']['schemas']['ObservationBatchCreate']
        self.assertEqual(batch['properties']['observations']['maxItems'],500)
        self.assertFalse(batch['additionalProperties'])


if __name__=='__main__': unittest.main()
