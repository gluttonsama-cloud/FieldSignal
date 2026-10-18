"""Explicit public-sample imports. Separate storage from farm observations."""
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
import json
from app.adapters.local_bundle import LocalObservationBundleAdapter, BundleError, PROCESSING_VERSION
from app.adapters.source_contract import SOURCE_CAPABILITIES

SAMPLE_MANIFEST=Path(__file__).resolve().parents[3]/'research'/'public-source-smoke'/'observation-bundle.json'


def observation_status(observation,now=None):
    now=now or datetime.now(timezone.utc)
    quality=observation['quality']
    if not quality['usable'] or quality['valid_fraction']<.6 or (observation['source']=='sentinel2' and quality.get('cloud_fraction',1)>.4):
        return 'quality_limited'
    return 'stale' if now-datetime.fromisoformat(observation['observed_at'])>timedelta(days=14) else 'available'


def current_import(data):
    return {**data,'observations':[{**o,'data_status':observation_status(o)} for o in data['observations']]}


class PublicSampleImports:
    def __init__(self,store,manifest=None):
        self.store=store
        self.manifest=Path(manifest or SAMPLE_MANIFEST)

    def sources(self):
        capabilities=[asdict(c) for c in SOURCE_CAPABILITIES]
        # Keep source availability independent from application import state.
        try:
            adapter=LocalObservationBundleAdapter(self.manifest)
            if adapter.manifest.scope!='public_sample': raise BundleError('Public source registry cannot load a parcel bundle')
            records,warnings=adapter.normalize()
            optical=[o for o in records if o.source=='sentinel2']
            weather=[o for o in records if o.source=='weather']
            bounds=optical[0].provenance.spatial_support.bounds if optical else None
            weather_input=next((r for r in adapter.manifest.records if r.adapter=='nasa_power_daily'),None)
            center=json.loads(adapter.blobs[weather_input.data])['geometry']['coordinates'][:2] if weather_input else []
            metadata={'sample_id':adapter.manifest.bundle_id,'title':adapter.manifest.title,'acquired_at':min((o.observed_at.isoformat() for o in optical),default=None),'retrieved_at':min(r.retrieved_at for r in adapter.manifest.records).isoformat(),'center_wgs84':center,'window_size_m':bounds[2]-bounds[0] if bounds else None,'optical_observation_count':len(optical),'weather_observation_count':len(weather),'expected_observation_count':len(records),'limitations':warnings,'bundle_sha256':adapter.bundle_sha256,'available':True}
        except BundleError:
            metadata={'sample_id':'shayang-public-window-20250428-v1','title':'公开历史样本','acquired_at':None,'retrieved_at':None,'center_wgs84':[],'window_size_m':None,'optical_observation_count':0,'weather_observation_count':0,'expected_observation_count':0,'limitations':['本地样本文件缺失或完整性校验失败；请恢复完整源码包后重试。'],'bundle_sha256':'','available':False}
        with self.store.connect() as c:
            imports=sorted(self.store.all(c,'source_imports'),key=lambda row:row['imported_at'],reverse=True)
        return {'capabilities':capabilities,'public_sample':metadata,'imports':[current_import(row) for row in imports]}

    def import_sample(self,sample_id):
        adapter=LocalObservationBundleAdapter(self.manifest)
        if adapter.manifest.bundle_id!=sample_id or adapter.manifest.scope!='public_sample':
            raise BundleError('Unknown public sample identifier')
        key=sha256(f'{adapter.bundle_sha256}:{PROCESSING_VERSION}'.encode()).hexdigest()
        import_id=f'sourceimport_{key[:32]}'
        with self.store.connect(write=True) as c:
            prior=self.store.get(c,'source_imports',import_id)
            if prior: return {'created':False,'import':current_import(prior)}
            normalized,warnings=adapter.normalize()
            timestamp=datetime.now(timezone.utc).isoformat()
            observations=[{'id':f'sampleobs_{key[:16]}_{index}',**o.model_dump(mode='json',exclude_none=True),'data_origin':'public_sample','ingested_at':timestamp,'created_at':timestamp} for index,o in enumerate(normalized)]
            data={'id':import_id,'sample_id':sample_id,'scope':'public_sample','status':'completed','bundle_sha256':adapter.bundle_sha256,'processing_version':PROCESSING_VERSION,'imported_at':timestamp,'created_at':timestamp,'observations':observations,'limitations':warnings,'analysis_status':'insufficient_data'}
            self.store.insert(c,'source_imports',data)
            return {'created':True,'import':current_import(data)}

    def get(self,import_id):
        with self.store.connect() as c:
            data=self.store.get(c,'source_imports',import_id)
            return current_import(data) if data else None

    def matches_public_record(self,observation):
        """Catch accidental copy/relabel of registered public inputs, not forgery."""
        checksums=observation.provenance.asset_checksums
        identities=set()
        try:
            adapter=LocalObservationBundleAdapter(self.manifest)
            if adapter.manifest.scope!='public_sample': return False
            keys={key for record in adapter.manifest.records for key in [*record.assets.values(),record.data] if key}
            known={adapter.manifest.files[key].sha256 for key in keys}
            records,_=adapter.normalize()
            identities.update((record.source,record.source_record_id) for record in records)
        except (BundleError,KeyError):
            known=set()
        # Previously imported evidence remains recognizable even if source files
        # are subsequently missing. Reading it does not create any field records.
        with self.store.connect() as c:
            for batch in self.store.all(c,'source_imports'):
                for record in batch['observations']:
                    known.update(record['provenance'].get('asset_checksums',{}).values())
                    identities.add((record['source'],record['source_record_id']))
        return bool(known.intersection(checksums.values())) or (observation.source,observation.source_record_id) in identities
