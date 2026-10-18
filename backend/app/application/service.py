from datetime import date, datetime, timedelta, timezone
from hashlib import sha256
from io import BytesIO
import sqlite3
from uuid import uuid4
from zoneinfo import ZoneInfo
from PIL import Image, ImageOps, UnidentifiedImageError
from app.domain.models import ParcelCreate, ObservationCreate, approximate_area_ha
from app.domain.detection import evaluate, MODEL_VERSION, eligible
from app.adapters.local_bundle import geometry_sha256
from app.application.source_imports import PublicSampleImports


def now_iso(): return datetime.now(timezone.utc).isoformat()
def entity(prefix, **data): return {'id':f'{prefix}_{uuid4().hex}',**data,'created_at':now_iso()}

class ServiceError(Exception):
    def __init__(self,status,code,message):
        self.status,self.code,self.message=status,code,message
        super().__init__(message)

class FieldService:
    def __init__(self,store,source_manifest=None):
        self.store=store
        self.source_imports=PublicSampleImports(store,source_manifest)

    def required(self,c,table,key):
        obj=self.store.get(c,table,key)
        if not obj: raise ServiceError(404,'not_found','记录不存在')
        return obj

    def list(self,table,parcel_id=None):
        with self.store.connect() as c:
            if parcel_id: self.required(c,'parcels',parcel_id)
            result=self.store.all(c,table,parcel_id)
            return sorted(result,key=lambda x:x.get('observed_at',x['created_at']))

    def parcel(self,parcel_id):
        with self.store.connect() as c: return self.required(c,'parcels',parcel_id)

    def create_parcel(self,payload):
        with self.store.connect(write=True) as c: return self._create_parcel(c,payload,'user')

    def _create_parcel(self,c,payload,origin):
        p=entity('parcel',**payload.model_dump(mode='json'),area_ha=round(approximate_area_ha(payload.geometry.coordinates[0]),4),area_method='local_equirectangular_estimate_not_survey',data_origin=origin)
        p['boundary_crs']='EPSG:4326'
        if origin=='fixture': p['boundary_source']='synthetic_fixture'
        return self.store.insert(c,'parcels',p)

    @staticmethod
    def require_season(parcel,day):
        first,last=map(int,parcel['season'].split('-'))
        if not date(first,7,1)<=day<=date(last,6,30):
            raise ServiceError(422,'outside_season','记录日期不在地块生长季内，请选择对应季节的地块记录。')

    def add_observation(self,parcel_id,payload):
        with self.store.connect(write=True) as c:
            p=self.required(c,'parcels',parcel_id)
            if p['data_origin']=='fixture':
                raise ServiceError(409,'fixture_readonly','开发模拟地块不接受真实观测导入，请新建真实地块。')
            return self._add_observation(c,p,payload)

    def _add_observation(self,c,p,payload):
        if payload.provenance.usage_scope=='public_sample' or (payload.provenance.spatial_support and payload.provenance.spatial_support.kind=='public_window') or 'no_crop_truth' in payload.quality.flags or (p['data_origin']!='fixture' and payload.provenance.usage_scope!='parcel' and self.source_imports.matches_public_record(payload)):
            raise ServiceError(422,'public_sample_not_parcel','公开方窗只用于独立数据管线验证，不能导入用户地块。')
        if payload.provenance.usage_scope=='parcel' and payload.provenance.parcel_geometry_sha256!=geometry_sha256(p['geometry']):
            raise ServiceError(422,'geometry_binding_mismatch','观测边界摘要与此地块不一致，不能归入此地块。')
        if payload.provenance.usage_scope=='parcel' and payload.source=='sentinel2' and (not payload.provenance.spatial_support or payload.provenance.spatial_support.kind!='parcel' or not payload.provenance.parcel_mask_sha256 or payload.provenance.parcel_mask_sha256 not in payload.provenance.asset_checksums.values()):
            raise ServiceError(422,'parcel_mask_binding_missing','地块光学观测必须保留地块空间支持、掩膜摘要和资产摘要绑定。')
        self.require_season(p,payload.observed_at.astimezone(ZoneInfo('Asia/Shanghai')).date())
        data=payload.model_dump(mode='json',exclude_none=True)
        o=entity('obs',parcel_id=p['id'],**data,data_origin=p['data_origin'],ingested_at=now_iso())
        try:
            return self.store.insert(c,'observations',o,parcel_id=p['id'],source=o['source'],source_record_id=o['source_record_id'])
        except sqlite3.IntegrityError:
            raise ServiceError(409,'duplicate_observation','该地块已导入此数据源记录；保留原始记录，不能静默覆盖。')

    def analyse(self,parcel_id,method):
        with self.store.connect(write=True) as c:
            p=self.required(c,'parcels',parcel_id)
            result=evaluate(self.store.all(c,'observations',parcel_id),method)
            risk_id=None
            if result['risk']:
                risk=result['risk']
                # Stable uniqueness makes repeated runs safe and preserves a verified candidate.
                existing=c.execute('SELECT id FROM risks WHERE parcel_id=? AND observation_id=? AND method=? AND model_version=?',(parcel_id,risk['observation_id'],method,MODEL_VERSION)).fetchone()
                if existing:
                    risk_id=existing['id']
                else:
                    r=entity('risk',parcel_id=parcel_id,method=method,model_version=MODEL_VERSION,status='open',data_origin=p['data_origin'],**risk)
                    self.store.insert(c,'risks',r,parcel_id=parcel_id,observation_id=r['observation_id'],method=method,model_version=MODEL_VERSION)
                    risk_id=r['id']
            run=entity('run',parcel_id=parcel_id,method=method,model_version=MODEL_VERSION,evaluated_at=now_iso(),status=result['status'],risk_id=risk_id,observation_count=result['observation_count'],message=result['message'],data_origin=p['data_origin'])
            return self.store.insert(c,'analyses',run,parcel_id=parcel_id)

    def create_visit(self,payload):
        with self.store.connect(write=True) as c:
            p=self.required(c,'parcels',payload.parcel_id)
            if payload.risk_id:
                risk=self.required(c,'risks',payload.risk_id)
                if risk['parcel_id']!=p['id']: raise ServiceError(422,'parcel_mismatch','风险候选不属于此地块')
                if risk['status']=='verified': raise ServiceError(409,'risk_verified','此候选已核验，可建立无关联候选的复查任务。')
                if c.execute('SELECT id FROM visits WHERE risk_id=? AND status=?',(payload.risk_id,'pending')).fetchone():
                    raise ServiceError(409,'duplicate_visit','此风险候选已有待完成巡田任务')
            visit=entity('visit',**payload.model_dump(mode='json'),status='pending',data_origin=p['data_origin'])
            self.store.insert(c,'visits',visit,parcel_id=p['id'],risk_id=payload.risk_id,status='pending')
            if payload.risk_id:
                risk['status']='assigned';self.store.update(c,'risks',risk)
            return visit

    def upload_photo(self,visit_id,content_type,raw):
        if content_type not in {'image/jpeg','image/png','image/webp'}:
            raise ServiceError(415,'unsupported_image','仅接受JPEG、PNG或WebP图片')
        try:
            with Image.open(BytesIO(raw)) as img:
                if img.format not in {'JPEG','PNG','WEBP'} or img.width*img.height>16_000_000:
                    raise ValueError('图片过大或格式不支持')
                img.load()
                clean=ImageOps.exif_transpose(img).convert('RGB')
                clean.thumbnail((2560,2560))
                out=BytesIO();clean.save(out,format='JPEG',quality=88)
                data=out.getvalue()
        except (UnidentifiedImageError,OSError,ValueError,Image.DecompressionBombError):
            raise ServiceError(422,'invalid_image','无法解码图片或图片超过1600万像素')
        digest=sha256(data).hexdigest()
        with self.store.connect(write=True) as c:
            v=self.required(c,'visits',visit_id)
            row=c.execute('SELECT id FROM photos WHERE visit_id=? AND sha256=?',(visit_id,digest)).fetchone()
            if row: return self.required(c,'photos',row['id'])
            if v['status']!='pending': raise ServiceError(409,'visit_completed','巡田已完成，不能追加照片')
            count=c.execute('SELECT COUNT(*) FROM photos WHERE visit_id=?',(visit_id,)).fetchone()[0]
            if count>=8: raise ServiceError(409,'photo_limit','每次巡田最多8张照片')
            photo=entity('photo',visit_id=visit_id,content_type='image/jpeg',size_bytes=len(data),metadata_stripped=True,state='staged',data_origin=v['data_origin'])
            self.store.insert(c,'photos',photo,visit_id=visit_id,sha256=digest,blob=data)
            return photo

    def remove_staged_photo(self,visit_id,photo_id):
        with self.store.connect(write=True) as c:
            visit=self.required(c,'visits',visit_id)
            if visit['status']!='pending':
                raise ServiceError(409,'visit_completed','巡田已提交，请先查看已保存核验；已归档照片不能在草稿中删除。')
            photo=self.store.get(c,'photos',photo_id)
            if not photo: return
            if photo['visit_id']!=visit_id:
                raise ServiceError(422,'photo_mismatch','照片不属于本次巡田')
            c.execute('DELETE FROM photos WHERE id=?',(photo_id,))

    def photo(self,photo_id):
        with self.store.connect() as c:
            p=self.required(c,'photos',photo_id)
            b=c.execute('SELECT blob FROM photos WHERE id=?',(photo_id,)).fetchone()['blob']
            return p,b

    def verify(self,visit_id,payload):
        request=payload.model_dump(mode='json')
        with self.store.connect(write=True) as c:
            visit=self.required(c,'visits',visit_id)
            row=c.execute('SELECT id FROM verifications WHERE visit_id=?',(visit_id,)).fetchone()
            if row:
                prior=self.required(c,'verifications',row['id'])
                if payload.client_submission_id and prior.get('client_submission_id')==payload.client_submission_id:
                    if all(prior.get(k)==v for k,v in request.items()): return prior
                    raise ServiceError(409,'idempotency_conflict','该提交编号已用于不同内容；请刷新核验结果。')
                raise ServiceError(409,'visit_completed','巡田已完成，请查看已提交的核验记录。')
            parcel=self.required(c,'parcels',visit['parcel_id'])
            self.require_season(parcel,payload.observed_at.astimezone(ZoneInfo('Asia/Shanghai')).date())
            if visit.get('risk_id'):
                candidate=self.required(c,'risks',visit['risk_id'])
                trigger=self.required(c,'observations',candidate['observation_id'])
                if payload.observed_at<datetime.fromisoformat(trigger['observed_at']):
                    raise ServiceError(422,'verification_before_observation','现场核验时间不能早于关联候选的触发观测，请检查观察时间。')
            for photo_id in payload.photo_ids:
                p=self.required(c,'photos',photo_id)
                if p['visit_id']!=visit_id: raise ServiceError(422,'photo_mismatch','核验照片必须属于本次巡田')
            result=entity('verification',visit_id=visit_id,parcel_id=visit['parcel_id'],**request,data_origin=visit['data_origin'],label_source='field_report_unadjudicated')
            self.store.insert(c,'verifications',result,visit_id=visit_id,parcel_id=visit['parcel_id'])
            # Only submitted references become evidence; discard unused staged uploads.
            for row in c.execute('SELECT id FROM photos WHERE visit_id=?',(visit_id,)).fetchall():
                if row['id'] in payload.photo_ids:
                    photo=self.required(c,'photos',row['id']);photo['state']='confirmed'
                    self.store.update(c,'photos',photo)
                else:
                    c.execute('DELETE FROM photos WHERE id=?',(row['id'],))
            visit['status']='completed';visit['completed_at']=now_iso()
            self.store.update(c,'visits',visit,status='completed')
            if visit.get('risk_id'):
                risk=self.required(c,'risks',visit['risk_id']);risk['status']='verified';risk['verification_id']=result['id']
                self.store.update(c,'risks',risk)
            return result

    def add_event(self,parcel_id,payload):
        with self.store.connect(write=True) as c:
            p=self.required(c,'parcels',parcel_id)
            self.require_season(p,payload.occurred_on)
            ev=entity('event',parcel_id=parcel_id,**payload.model_dump(mode='json'),data_origin=p['data_origin'])
            return self.store.insert(c,'events',ev,parcel_id=parcel_id)

    def dashboard(self):
        with self.store.connect() as c:
            parcels=self.store.all(c,'parcels');risks=self.store.all(c,'risks');visits=self.store.all(c,'visits');verifications=self.store.all(c,'verifications')
            now=datetime.now(timezone.utc)
            output=[]
            for p in parcels:
                obs=sorted(self.store.all(c,'observations',p['id']),key=lambda o:o['observed_at'])
                # Latest usable across modalities is not a statement about crop health.
                valid=[o for o in obs if o['quality']['usable'] and o['quality']['valid_fraction']>=0.6 and (o['source']!='sentinel2' or o['quality'].get('cloud_fraction',1)<=0.4)]
                latest=valid[-1]['observed_at'] if valid else None
                status='missing' if not obs else 'quality_limited' if not valid else 'stale' if now-datetime.fromisoformat(latest)>timedelta(days=14) else 'available'
                output.append({**p,'latest_observed_at':latest,'observation_count':len(obs),'data_status':status,'open_risk_count':sum(r['parcel_id']==p['id'] and r['status']!='verified' for r in risks)})
            return {'parcel_count':len(parcels),'open_risk_count':sum(r['status']!='verified' for r in risks),'pending_visit_count':sum(v['status']=='pending' for v in visits),'verification_count':len(verifications),'parcels':output,'recent_verifications':sorted(verifications,key=lambda v:v['created_at'],reverse=True)[:20]}

    def seed_fixture(self):
        with self.store.connect(write=True) as c:
            existing=[p for p in self.store.all(c,'parcels') if p['data_origin']=='fixture']
            if existing: return {'created':False,'parcel_id':existing[0]['id']}
            today=datetime.now(timezone.utc);year=today.year if today.month>=7 else today.year-1
            p=self._create_parcel(c,ParcelCreate(name='开发模拟地块 · 非真实农田',region='other',season=f'{year}-{year+1}',geometry={'type':'Polygon','coordinates':[[[112.400,30.700],[112.402,30.700],[112.402,30.702],[112.400,30.702],[112.400,30.700]]]}),'fixture')
            # Synthetic timestamps are relative to today for a reproducible local walkthrough.
            # If very early in season, the seed starts at the season boundary and remains insufficient.
            start=datetime(year,7,1,tzinfo=timezone.utc)
            for i,val in enumerate([0.68,0.70,0.69,0.71,0.69,0.70,0.38]):
                dt=today-timedelta(days=1+(6-i)*7)
                if dt<start: continue
                o=ObservationCreate(observed_at=dt,source='sentinel2',source_record_id=f'fixture-s2-{i}',features={'ndvi':val,'ndwi':0.10},quality={'usable':True,'valid_fraction':0.95,'cloud_fraction':0.02,'flags':['synthetic_not_satellite_data']},provenance={'provider':'local-development-fixture','collection':'synthetic-s2','item_id':f'fixture-s2-{i}','processing_version':'fixture-v1','license':'Synthetic development fixture; not field evidence'})
                self._add_observation(c,p,o)
            return {'created':True,'parcel_id':p['id']}
