"""Real archived inputs plus isolated mutations: offline reproducibility and safety."""
import copy
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
from PIL import Image
import numpy as np
from app.main import create_app
from app.adapters.local_bundle import BundleError, LocalObservationBundleAdapter, geometry_sha256
from app.application.source_imports import SAMPLE_MANIFEST

class SourceImportTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.bundle=self.root/'bundle';shutil.copytree(SAMPLE_MANIFEST.parent,self.bundle)
        self.manifest=self.bundle/SAMPLE_MANIFEST.name
        self.content=json.loads(self.manifest.read_text())
        self.client=TestClient(create_app(self.root/'test.db',False,self.manifest))

    def tearDown(self): self.client.close();self.temp.cleanup()

    def save(self): self.manifest.write_text(json.dumps(self.content,ensure_ascii=False))

    def update_file(self,key,content):
        path=self.bundle/self.content['files'][key]['path']
        path.write_text(json.dumps(content))
        self.content['files'][key]['sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
        self.save()

    def imported(self):
        result=self.client.post('/api/v1/source-imports/public-sample',json={'sample_id':self.content['bundle_id']})
        self.assertEqual(result.status_code,201,result.text);return result.json()

    def test_preview_does_not_import_and_original_pixels_recompute(self):
        with patch('urllib.request.urlopen',side_effect=AssertionError('Network forbidden')):
            sources=self.client.get('/api/v1/sources').json()
            self.assertEqual(sources['imports'],[])
            self.assertEqual(sources['public_sample']['expected_observation_count'],4)
            result=self.imported();rows=result['import']['observations']
        self.assertTrue(result['created']);self.assertEqual(len(rows),4)
        s2=rows[0]
        self.assertAlmostEqual(s2['features']['ndvi'],.37450793780333835,places=12)
        self.assertEqual(s2['quality']['valid_fraction'],1012/1024)
        self.assertEqual(s2['quality']['cloud_fraction'],0)
        self.assertEqual(s2['provenance']['spatial_support']['scl_pixel_size_m'],20)
        self.assertEqual(s2['observed_at'],'2025-04-28T03:19:50.740000Z')
        self.assertTrue(s2['provenance']['retrieved_at'].startswith('2026-10-15'))
        self.assertEqual(len(s2['provenance']['asset_checksums']),4)
        self.assertTrue(all(o['data_status']=='stale' and o['data_origin']=='public_sample' for o in rows))
        self.assertEqual(rows[1]['features']['precipitation_mm'],0)
        self.assertEqual(rows[2]['features']['precipitation_mm'],.06)
        self.assertEqual(result['import']['analysis_status'],'insufficient_data')
        self.assertEqual(self.client.get('/api/v1/dashboard').json()['parcel_count'],0)
        for endpoint in ['risks','visits','verifications','parcels']:
            self.assertEqual(self.client.get('/api/v1/'+endpoint).json(),[])

    def test_retry_concurrency_and_reopen_keep_single_immutable_import(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results=list(pool.map(lambda _:self.imported(),range(4)))
        self.assertEqual(sum(r['created'] for r in results),1)
        self.assertEqual(len({r['import']['id'] for r in results}),1)
        self.assertEqual(len({r['import']['imported_at'] for r in results}),1)
        rid=results[0]['import']['id']
        reopened=TestClient(create_app(self.root/'test.db',False,self.manifest))
        self.assertEqual(reopened.get('/api/v1/source-imports/'+rid).json()['id'],rid)
        self.assertEqual(len(reopened.get('/api/v1/sources').json()['imports']),1);reopened.close()

    def test_hash_tamper_fails_closed_without_partial_import(self):
        with (self.bundle/'red_sample_320m.tif').open('ab') as f:f.write(b'tamper')
        sources=self.client.get('/api/v1/sources').json()
        self.assertFalse(sources['public_sample']['available'])
        response=self.client.post('/api/v1/source-imports/public-sample',json={'sample_id':self.content['bundle_id']})
        self.assertEqual(response.status_code,422)
        self.assertEqual(sources['imports'],[])
        self.assertEqual(self.client.get('/api/v1/dashboard').json()['parcel_count'],0)

    def test_public_samples_cannot_enter_farm_or_accept_target_parameter(self):
        row=self.imported()['import']['observations'][0]
        geometry={'type':'Polygon','coordinates':[[[112.4,30.7],[112.402,30.7],[112.402,30.702],[112.4,30.702],[112.4,30.7]]]}
        parcel=self.client.post('/api/v1/parcels',json={'name':'历史地块','season':'2024-2025','geometry':geometry}).json()
        payload={key:row[key] for key in ['observed_at','source','source_record_id','features','quality','provenance']}
        rejected=self.client.post('/api/v1/parcels/'+parcel['id']+'/observations',json=payload)
        self.assertEqual(rejected.status_code,422);self.assertEqual(rejected.json()['error']['code'],'public_sample_not_parcel')
        # Deleting optional scope fields (or even the public flag) must not turn
        # recognized public assets into unverified farm records accidentally.
        for removal in ['scope','flags','hashes']:
            stripped=copy.deepcopy(payload)
            stripped['provenance'].pop('usage_scope');stripped['provenance'].pop('spatial_support')
            if removal in ['flags','hashes']: stripped['quality']['flags']=[]
            if removal=='hashes': stripped['provenance']['asset_checksums']={}
            self.assertEqual(self.client.post('/api/v1/parcels/'+parcel['id']+'/observations',json=stripped).status_code,422)
        self.assertEqual(self.client.post('/api/v1/source-imports/public-sample',json={'sample_id':self.content['bundle_id'],'parcel_id':parcel['id']}).status_code,422)
        self.assertEqual(self.client.post('/api/v1/source-imports/public-sample',json={'sample_id':'unknown'}).status_code,422)
        self.assertEqual(self.client.get('/api/v1/source-imports/missing').status_code,404)
        self.assertEqual(self.client.get('/api/v1/parcels/'+parcel['id']+'/observations').json(),[])

    def test_path_traversal_symlink_and_remote_reference_refused(self):
        for path in ['../outside.json','/etc/passwd','https://example.test/file']:
            with self.subTest(path=path):
                original=copy.deepcopy(self.content)
                self.content['files']['power']['path']=path;self.save()
                with self.assertRaises(BundleError): LocalObservationBundleAdapter(self.manifest)
                self.content=original
        outside=self.root/'outside.json';outside.write_text('{}')
        (self.bundle/'escape.json').symlink_to(outside)
        self.content['files']['power']={'path':'escape.json','sha256':hashlib.sha256(outside.read_bytes()).hexdigest()};self.save()
        with self.assertRaises(BundleError): LocalObservationBundleAdapter(self.manifest)

    def test_fill_values_never_become_zero_and_full_missing_day_skips(self):
        data=json.loads((self.bundle/'power_weather_aligned.json').read_text())
        data['properties']['parameter']['PRECTOTCORR']['20250426']=-999
        for values in data['properties']['parameter'].values():values['20250427']=-999
        self.update_file('power',data)
        records,warnings=LocalObservationBundleAdapter(self.manifest).normalize()
        weather=[o for o in records if o.source=='weather']
        self.assertEqual(len(weather),2)
        self.assertIsNone(weather[0].features.precipitation_mm)
        self.assertFalse(weather[0].quality.usable)
        self.assertEqual(weather[0].quality.valid_fraction,2/3)
        self.assertTrue(any('all POWER parameters missing' in w for w in warnings))
        for change in [('time_standard','LST'),('sources',['unverified-model'])]:
            changed=copy.deepcopy(data);changed['header'][change[0]]=change[1]
            self.update_file('power',changed)
            with self.assertRaises(BundleError):LocalObservationBundleAdapter(self.manifest).normalize()

    def test_scale_offset_and_source_grid_are_checked_not_hardcoded(self):
        catalog=json.loads((self.bundle/'earthsearch_s2_c1_clear_search.json').read_text())
        for mutate in ['offset','grid']:
            changed=copy.deepcopy(catalog)
            if mutate=='offset':changed['features'][0]['assets']['red']['raster:bands'][0]['offset']=0
            else:changed['features'][0]['assets']['red']['proj:transform'][2]+=500000
            self.update_file('s2_stac',changed)
            with self.assertRaises(BundleError):LocalObservationBundleAdapter(self.manifest).normalize()
        for mutate in ['empty_band','wrong_properties']:
            changed=copy.deepcopy(catalog)
            if mutate=='empty_band':changed['features'][0]['assets']['red']['raster:bands']=[]
            else:changed['features'][0]['properties']=[]
            self.update_file('s2_stac',changed)
            self.assertFalse(self.client.get('/api/v1/sources').json()['public_sample']['available'])
            self.assertEqual(self.client.post('/api/v1/source-imports/public-sample',json={'sample_id':self.content['bundle_id']}).status_code,422)
        self.content['records'][1]['data']='missing-file-key';self.save()
        with self.assertRaises(BundleError):LocalObservationBundleAdapter(self.manifest)
        geometry={'type':'Polygon','coordinates':[[[112.4,30.7],[112.402,30.7],[112.402,30.702],[112.4,30.702],[112.4,30.7]]]}
        parcel=self.client.post('/api/v1/parcels',json={'name':'手工来源声明','season':'2024-2025','geometry':geometry}).json()
        manual={'observed_at':'2025-04-28T03:00:00Z','source':'manual','source_record_id':'manual-unverified-01','features':{'ndvi':.4},'quality':{'usable':True,'valid_fraction':1},'provenance':{'provider':'user supplied','collection':'manual','item_id':'manual-unverified-01','processing_version':'unverified'}}
        self.assertEqual(self.client.post('/api/v1/parcels/'+parcel['id']+'/observations',json=manual).status_code,201)

    def test_generic_bundle_accepts_other_item_date_and_zero_valid_is_explicit(self):
        catalog=json.loads((self.bundle/'earthsearch_s2_c1_clear_search.json').read_text())
        catalog['features'][0]['id']='TEST_LOCAL_ITEM_DIFFERENT_DATE'
        catalog['features'][0]['properties']['datetime']='2024-03-22T01:00:00Z'
        self.content['records'][0]['item_id']='TEST_LOCAL_ITEM_DIFFERENT_DATE'
        self.content['bundle_id']='different-local-bundle';self.update_file('s2_stac',catalog)
        records,_=LocalObservationBundleAdapter(self.manifest).normalize()
        self.assertTrue(records[0].observed_at.isoformat().startswith('2024-03-22'))
        path=self.bundle/'scl_sample_320m.tif'
        with Image.open(path) as im: tags=dict(im.tag_v2);shape=im.size
        Image.fromarray(np.full((shape[1],shape[0]),9,dtype=np.uint8)).save(path,tiffinfo=tags)
        self.content['files']['scl']['sha256']=hashlib.sha256(path.read_bytes()).hexdigest();self.save()
        records,warnings=LocalObservationBundleAdapter(self.manifest).normalize()
        self.assertEqual(len(records),3)
        self.assertTrue(all(o.source=='weather' for o in records))
        self.assertTrue(any('no valid SCL 4/5' in w for w in warnings))

    def test_parcel_mask_and_geometry_binding_reuse_same_adapter(self):
        geometry={'type':'Polygon','coordinates':[[[112.4,30.7],[112.402,30.7],[112.402,30.702],[112.4,30.702],[112.4,30.7]]]}
        self.content['scope']='parcel';self.content['bundle_id']='test-parcel-window'
        self.content['parcel_geometry_sha256']=geometry_sha256(geometry)
        self.save()
        with self.assertRaises(BundleError):LocalObservationBundleAdapter(self.manifest)
        with Image.open(self.bundle/'red_sample_320m.tif') as im: tags=dict(im.tag_v2);shape=im.size
        maskpath=self.bundle/'mask.tif';Image.fromarray(np.ones((shape[1],shape[0]),dtype=np.uint8)).save(maskpath,tiffinfo=tags)
        self.content['files']['mask']={'path':'mask.tif','sha256':hashlib.sha256(maskpath.read_bytes()).hexdigest()}
        self.content['records'][0]['mask']='mask';self.save()
        rows,_=LocalObservationBundleAdapter(self.manifest).normalize()
        self.assertEqual(rows[0].provenance.spatial_support.kind,'parcel')
        parcel=self.client.post('/api/v1/parcels',json={'name':'测试边界绑定','season':'2024-2025','geometry':geometry}).json()
        url='/api/v1/parcels/'+parcel['id']+'/observations'
        payload=rows[0].model_dump(mode='json',exclude_none=True)
        wrong=copy.deepcopy(payload);wrong['provenance']['parcel_geometry_sha256']='0'*64
        self.assertEqual(self.client.post(url,json=wrong).status_code,422)
        no_mask=copy.deepcopy(payload);no_mask['provenance'].pop('parcel_mask_sha256')
        self.assertEqual(self.client.post(url,json=no_mask).status_code,422)
        good=self.client.post(url,json=payload)
        self.assertEqual(good.status_code,201,good.text)
        self.assertEqual(self.client.post(url,json=payload).status_code,409)
        # A parcel manifest cannot be imported via the isolated public-sample API.
        self.assertEqual(self.client.post('/api/v1/source-imports/public-sample',json={'sample_id':self.content['bundle_id']}).status_code,422)

if __name__=='__main__':unittest.main()
