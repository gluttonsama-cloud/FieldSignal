from datetime import date, datetime, timedelta, timezone
from hashlib import sha256
from io import BytesIO
import json
import re
import sqlite3
from uuid import uuid4
from zoneinfo import ZoneInfo
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import ValidationError
from app.domain.models import ParcelCreate, ObservationCreate, approximate_area_ha
from app.domain.detection import evaluate, MODEL_VERSION, quality_eligible, qualification
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
            if table=='risks': result=[self._risk_view(row) for row in result]
            elif table=='verifications': result=[self._report_view(c,row) for row in result]
            elif table=='visits': result=[self._visit_view(c,row) for row in result]
            return sorted(result,key=lambda x:x.get('observed_at',x['created_at']))

    @staticmethod
    def _risk_view(risk):
        # Historical "verified" meant only that a field report was received.
        # Correct the read model, never migrate saved evidence or old receipts.
        legacy=risk.get('status')=='verified'
        return {**risk,'status':'review_required' if legacy else risk['status'],
                **({'legacy_status':'verified'} if legacy else {}),
                'disposition':'unresolved','mode':'fixture_demo' if risk['data_origin']=='fixture' else 'preview',
                'monitoring_eligible':False}

    def _report_view(self,c,report):
        visit=self.required(c,'visits',report['visit_id'])
        return {**report,'disposition':'review_required','risk_id':self._visit_risk_id(c,visit),
                **({'source_verification_id':visit['source_verification_id']} if visit.get('source_verification_id') else {})}

    def _visit_view(self,c,visit):
        # Old follow-ups stored a null risk_id. Recover their event link through
        # source reports for reads only, preserving immutable creation receipts.
        return {**visit,'risk_id':self._visit_risk_id(c,visit)} if visit.get('source_verification_id') else visit

    def parcel(self,parcel_id):
        with self.store.connect() as c: return self.required(c,'parcels',parcel_id)

    @staticmethod
    def idempotency_request(payload,key):
        if key is None: return None
        if not isinstance(key,str) or not re.fullmatch(r'[A-Za-z0-9._:-]{1,128}',key):
            raise ServiceError(422,'invalid_idempotency_key','Idempotency-Key 须为1至128个英文字母、数字、点、下划线、冒号或连字符。')
        # Bind to the validated/defaulted payload, not JSON whitespace/key order.
        return json.dumps(payload.model_dump(mode='json'),sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False)

    def replay(self,c,key,operation,target,request_json):
        if key is None: return None
        prior=self.store.receipt(c,key)
        if prior is None: return None
        # Keys are global across create operations, not scoped to a route.
        if (prior['operation'],prior['target'],prior['request_json'])!=(operation,target,request_json):
            raise ServiceError(409,'idempotency_conflict','该提交编号已用于不同内容、操作或地块，请查看已保存记录。')
        return json.loads(prior['response_json'])

    def create_parcel(self,payload,idempotency_key=None):
        request_json=self.idempotency_request(payload,idempotency_key)
        with self.store.connect(write=True) as c:
            prior=self.replay(c,idempotency_key,'create_parcel','',request_json)
            if prior is not None: return prior
            result=self._create_parcel(c,payload,'user')
            if idempotency_key is not None:
                self.store.insert_receipt(c,idempotency_key,'create_parcel','',request_json,result)
            return result

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

    def _validate_observation(self,p,payload,parcel_geometry_digest=None):
        if payload.provenance.usage_scope=='public_sample' or (payload.provenance.spatial_support and payload.provenance.spatial_support.kind=='public_window') or 'no_crop_truth' in payload.quality.flags or (p['data_origin']!='fixture' and payload.provenance.usage_scope!='parcel' and self.source_imports.matches_public_record(payload)):
            raise ServiceError(422,'public_sample_not_parcel','公开方窗只用于独立数据管线验证，不能导入用户地块。')
        if payload.provenance.usage_scope=='parcel' and payload.provenance.parcel_geometry_sha256!=(parcel_geometry_digest or geometry_sha256(p['geometry'])):
            raise ServiceError(422,'geometry_binding_mismatch','观测边界摘要与此地块不一致，不能归入此地块。')
        if payload.provenance.usage_scope=='parcel' and payload.source=='sentinel2' and (not payload.provenance.spatial_support or payload.provenance.spatial_support.kind!='parcel' or not payload.provenance.parcel_mask_sha256 or payload.provenance.parcel_mask_sha256 not in payload.provenance.asset_checksums.values()):
            raise ServiceError(422,'parcel_mask_binding_missing','地块光学观测必须保留地块空间支持、掩膜摘要和资产摘要绑定。')
        self.require_season(p,payload.observed_at.astimezone(ZoneInfo('Asia/Shanghai')).date())

    def _add_observation(self,c,p,payload):
        self._validate_observation(p,payload)
        return self._insert_observation(c,p,payload)

    def _insert_observation(self,c,p,payload):
        data=payload.model_dump(mode='json',exclude_none=True)
        o=entity('obs',parcel_id=p['id'],**data,data_origin=p['data_origin'],ingested_at=now_iso())
        try:
            return self.store.insert(c,'observations',o,parcel_id=p['id'],source=o['source'],source_record_id=o['source_record_id'])
        except sqlite3.IntegrityError:
            raise ServiceError(409,'duplicate_observation','该地块已导入此数据源记录；保留原始记录，不能静默覆盖。')

    def add_observation_batch(self,parcel_id,payload,idempotency_key=None):
        request_json=self.idempotency_request(payload,idempotency_key)
        with self.store.connect(write=True) as c:
            prior=self.replay(c,idempotency_key,'add_observation_batch',parcel_id,request_json)
            if prior is not None: return prior
            parcel=self.required(c,'parcels',parcel_id)
            if parcel['data_origin']=='fixture':
                raise ServiceError(409,'fixture_readonly','开发模拟地块不接受真实观测导入，请新建真实地块。')
            parcel_geometry_digest=geometry_sha256(parcel['geometry'])
            known_public_hashes,known_public_ids=self.source_imports.public_record_fingerprints(c)
            seen=set()
            rows=[]
            for index,observation in enumerate(payload.observations,1):
                key=(observation.source,observation.source_record_id)
                try:
                    if key in seen:
                        raise ServiceError(422,'duplicate_batch_observation','批内数据源记录重复，请移除重复项后重新核对。')
                    seen.add(key)
                    provenance=observation.provenance
                    if provenance.usage_scope=='public_sample' or key in known_public_ids or known_public_hashes.intersection(provenance.asset_checksums.values()):
                        raise ServiceError(422,'public_sample_not_parcel','公开样本只用于独立数据管线验证，不能导入用户地块。')
                    if provenance.usage_scope!='parcel':
                        raise ServiceError(422,'parcel_scope_required','批量观测必须逐条声明 parcel 用途并绑定当前地块。')
                    if provenance.processing_version!=payload.processing_version:
                        raise ServiceError(422,'processing_version_mismatch','观测处理版本与批次声明不一致。')
                    self._validate_observation(parcel,observation,parcel_geometry_digest)
                    existing=c.execute('SELECT data FROM observations WHERE parcel_id=? AND source=? AND source_record_id=?',(parcel_id,*key)).fetchone()
                    if existing is not None:
                        saved=json.loads(existing['data'])
                        # Only server-owned metadata is excluded. Validate and
                        # restore every nested default before exact comparison.
                        content={k:v for k,v in saved.items() if k not in {'id','created_at','ingested_at','data_origin','parcel_id'}}
                        try:
                            normalized=ObservationCreate.model_validate(content).model_dump(mode='json')
                            same=json.dumps(normalized,sort_keys=True,allow_nan=False)==json.dumps(observation.model_dump(mode='json'),sort_keys=True,allow_nan=False)
                        except ValidationError:
                            same=False
                        if not same:
                            raise ServiceError(409,'observation_content_conflict','该数据源记录已存在但内容不同，不能覆盖；请核对原始记录。')
                        row=saved
                        status='existing'
                    else:
                        row=self._insert_observation(c,parcel,observation)
                        status='created'
                    rows.append({name:row[name] for name in ['id','source','source_record_id','observed_at']}|{'status':status})
                except ServiceError as exc:
                    raise ServiceError(exc.status,exc.code,f'第{index}条观测（{key[0]} / {key[1]}）：{exc.message} 本次批量请求未写入新观测。') from exc
            result=entity('obsbatch',parcel_id=parcel_id,bundle_id=payload.bundle_id,bundle_sha256=payload.bundle_sha256,processing_version=payload.processing_version,created_count=sum(row['status']=='created' for row in rows),existing_count=sum(row['status']=='existing' for row in rows),observations=rows)
            if idempotency_key is not None:
                self.store.insert_receipt(c,idempotency_key,'add_observation_batch',parcel_id,request_json,result)
            return result

    def analyse(self,parcel_id,method):
        with self.store.connect(write=True) as c:
            p=self.required(c,'parcels',parcel_id)
            observations=self.store.all(c,'observations',parcel_id)
            trust=qualification(observations,geometry_sha256(p['geometry']),fixture=p['data_origin']=='fixture')
            result=evaluate(observations,method,mode=trust['mode'])
            risk_id=None
            # Declared metrics can be explored, never promoted into monitoring.
            # Only the explicit, separately labelled fixture walkthrough creates
            # synthetic candidates until a qualified production source exists.
            if result['risk'] and trust['mode']=='fixture_demo':
                risk=result['risk']
                # Repeated runs preserve the same event and its review state.
                existing=c.execute('SELECT id FROM risks WHERE parcel_id=? AND observation_id=? AND method=? AND model_version=?',(parcel_id,risk['observation_id'],method,MODEL_VERSION)).fetchone()
                if existing:
                    risk_id=existing['id']
                else:
                    r=entity('risk',parcel_id=parcel_id,method=method,model_version=MODEL_VERSION,status='open',disposition='unresolved',mode='fixture_demo',monitoring_eligible=False,data_origin=p['data_origin'],**risk)
                    self.store.insert(c,'risks',r,parcel_id=parcel_id,observation_id=r['observation_id'],method=method,model_version=MODEL_VERSION)
                    risk_id=r['id']
            preview=trust['mode']=='preview'
            status=('preview_only' if result['status'] in {'candidate','not_flagged'} else 'blocked') if preview else result['status']
            message=('仅供探索预览：来源、地块映射和质量依据尚未独立核实，不生成正式监测候选。' if preview else '开发模拟演示，非真实监测。')+result['message']
            run=entity('run',parcel_id=parcel_id,method=method,model_version=MODEL_VERSION,evaluated_at=now_iso(),status=status,risk_id=risk_id,observation_count=result['observation_count'],message=message,data_origin=p['data_origin'],**trust,
                       preview_status=result['status'] if preview else None,
                       preview_evidence=result['risk']['evidence'] if preview and result['risk'] else None)
            return self.store.insert(c,'analyses',run,parcel_id=parcel_id)

    def create_visit(self,payload,idempotency_key=None):
        request_json=self.idempotency_request(payload,idempotency_key)
        with self.store.connect(write=True) as c:
            prior=self.replay(c,idempotency_key,'create_visit',payload.parcel_id,request_json)
            if prior is not None: return prior
            p=self.required(c,'parcels',payload.parcel_id)
            if payload.risk_id:
                risk=self.required(c,'risks',payload.risk_id)
                if risk['parcel_id']!=p['id']: raise ServiceError(422,'parcel_mismatch','风险候选不属于此地块')
                if self._pending_risk_visit(c,payload.risk_id):
                    raise ServiceError(409,'duplicate_visit','此风险候选已有待完成巡田任务')
            visit=entity('visit',**payload.model_dump(mode='json'),status='pending',data_origin=p['data_origin'],plan_revision=0)
            self.store.insert(c,'visits',visit,parcel_id=p['id'],risk_id=payload.risk_id,status='pending')
            if payload.risk_id:
                risk['status']='assigned';risk['disposition']='unresolved';self.store.update(c,'risks',risk)
            if idempotency_key is not None:
                self.store.insert_receipt(c,idempotency_key,'create_visit',payload.parcel_id,request_json,visit)
            return visit

    def _follow_up_source(self,c,verification_id,parcel_id=None):
        source=self.required(c,'verifications',verification_id)
        source_row=c.execute('SELECT visit_id,parcel_id FROM verifications WHERE id=?',(verification_id,)).fetchone()
        visit_row=c.execute('SELECT parcel_id,risk_id,status,data FROM visits WHERE id=?',(source_row['visit_id'],)).fetchone()
        original=json.loads(visit_row['data']) if visit_row else {}
        parcel=self.store.get(c,'parcels',source_row['parcel_id'])
        if (not parcel or not visit_row
                or source.get('id')!=verification_id
                or source.get('visit_id')!=source_row['visit_id']
                or source.get('parcel_id')!=source_row['parcel_id']
                or original.get('id')!=source_row['visit_id']
                or original.get('parcel_id')!=source_row['parcel_id']
                or visit_row['parcel_id']!=source_row['parcel_id']
                or original.get('risk_id')!=visit_row['risk_id']
                or original.get('status')!='completed' or visit_row['status']!='completed'
                or parcel.get('id')!=source_row['parcel_id']
                or source.get('data_origin')!=parcel.get('data_origin')
                or original.get('data_origin')!=parcel.get('data_origin')
                or (parcel_id is not None and parcel_id!=source_row['parcel_id'])):
            raise ServiceError(422,'invalid_follow_up_source','原核验与已完成巡田、地块记录不一致，不能建立或提交复查；请核对原记录。')
        try:
            observed_at=datetime.fromisoformat(source['observed_at'])
            if observed_at.tzinfo is None or observed_at.utcoffset() is None: raise ValueError
        except (KeyError,TypeError,ValueError):
            raise ServiceError(422,'invalid_follow_up_source','原核验缺少有效的含时区观察时间，不能建立或提交复查。')
        return source,parcel,observed_at

    def _visit_risk_id(self,c,visit):
        return self._visit_lineage(c,visit)[0]

    def _visit_lineage(self,c,visit):
        """Resolve the event through both new and legacy source-linked visits.

        Never trust a source id alone: every edge is validated against indexed
        parcel/visit identities, origins and completed execution. Detect cycles
        and conflicting event links instead of silently dropping lineage.
        """
        parcel_id=visit['parcel_id'];origin=visit['data_origin']
        seen=set();risk_ids=set();claims=[];source_root=None
        while True:
            if visit['id'] in seen:
                raise ServiceError(422,'invalid_follow_up_source','复查来源形成循环，不能确认关联事件。')
            seen.add(visit['id'])
            if visit.get('risk_id'): risk_ids.add(visit['risk_id'])
            if not visit.get('source_verification_id'): break
            source,_,_=self._follow_up_source(c,visit['source_verification_id'],parcel_id)
            source_root=source['id']
            if 'risk_id' in source: claims.append(source['risk_id'])
            visit=self.required(c,'visits',source['visit_id'])
        risk_id=next(iter(risk_ids),None)
        if len(risk_ids)>1 or any(claim!=risk_id for claim in claims):
            raise ServiceError(422,'invalid_follow_up_source','复查与原报告的关联事件不一致，请核对原记录。')
        if risk_id:
            risk=self.required(c,'risks',risk_id)
            if risk['parcel_id']!=parcel_id or risk['data_origin']!=origin:
                raise ServiceError(422,'invalid_follow_up_source','复查关联事件与地块或来源不一致，请核对原记录。')
        return risk_id,source_root

    def _pending_risk_visit(self,c,risk_id):
        # Include historical null-risk follow-ups. BEGIN IMMEDIATE serializes
        # this guard with creates/completions; the existing index also protects
        # all newly linked pending visits across ordinary/follow-up endpoints.
        parcel_id=self.required(c,'risks',risk_id)['parcel_id']
        for row in c.execute("SELECT data FROM visits WHERE status='pending' AND parcel_id=?",(parcel_id,)):
            visit=json.loads(row['data'])
            if self._visit_risk_id(c,visit)==risk_id: return True
        return False

    def create_follow_up_visit(self,verification_id,payload,idempotency_key=None):
        request_json=self.idempotency_request(payload,idempotency_key)
        with self.store.connect(write=True) as c:
            prior=self.replay(c,idempotency_key,'create_follow_up_visit',verification_id,request_json)
            if prior is not None: return prior
            source,parcel,_=self._follow_up_source(c,verification_id)
            # BEGIN IMMEDIATE serializes this check with every create/completion,
            # including independent stores. Lineage stays in the visit JSON, so
            # legacy visit schemas and receipt canonicalization are unchanged.
            pending=c.execute("SELECT data FROM visits WHERE status='pending'").fetchall()
            if any(json.loads(row['data']).get('source_verification_id')==source['id'] for row in pending):
                raise ServiceError(409,'duplicate_follow_up_visit','此核验已有待完成复查，请查看现有任务。')
            risk_id,source_root=self._visit_lineage(c,self.required(c,'visits',source['visit_id']))
            source_root=source_root or source['id']
            if 'risk_id' in source and source['risk_id']!=risk_id:
                raise ServiceError(422,'invalid_follow_up_source','原报告与巡田的关联事件不一致，请核对原记录。')
            if risk_id and self._pending_risk_visit(c,risk_id):
                raise ServiceError(409,'duplicate_visit','此关联事件已有待完成巡田或复查，请查看现有任务。')
            # An unlinked field report also has a single follow-up chain. Do
            # not create sibling work from an older report while a descendant
            # is pending, even when there is no satellite candidate at all.
            for row in pending:
                existing=json.loads(row['data'])
                if existing['parcel_id']==parcel['id'] and existing.get('source_verification_id') and self._visit_lineage(c,existing)[1]==source_root:
                    raise ServiceError(409,'duplicate_follow_up_visit','此报告链已有待完成复查，请查看现有任务。')
            visit=entity('visit',parcel_id=parcel['id'],risk_id=risk_id,source_verification_id=source['id'],**payload.model_dump(mode='json'),status='pending',data_origin=parcel['data_origin'],plan_revision=0)
            self.store.insert(c,'visits',visit,parcel_id=parcel['id'],risk_id=risk_id,status='pending')
            if risk_id:
                risk=self.required(c,'risks',risk_id)
                risk['status']='assigned';risk['disposition']='unresolved'
                self.store.update(c,'risks',risk)
            if idempotency_key is not None:
                self.store.insert_receipt(c,idempotency_key,'create_follow_up_visit',verification_id,request_json,visit)
            return visit

    def update_visit_plan(self,visit_id,payload,idempotency_key=None):
        request_json=self.idempotency_request(payload,idempotency_key)
        with self.store.connect(write=True) as c:
            visit=self.required(c,'visits',visit_id)
            if visit['status']!='pending':
                raise ServiceError(409,'visit_completed','巡田已完成，计划只读；请刷新任务并查看已保存核查。')
            revision=visit.get('plan_revision',0)
            prior=self.replay(c,idempotency_key,'update_visit_plan',visit_id,request_json)
            if (prior is not None and prior['plan_revision']!=revision) or (prior is None and payload.expected_revision!=revision):
                raise ServiceError(409,'visit_plan_conflict','此巡田计划已有更新，本次未覆盖。请关闭表单、刷新任务，再重新打开核对；先前请求可能已保存，不能覆盖后续计划。')
            if prior is not None: return prior
            visit.update(payload.model_dump(mode='json',exclude={'expected_revision'}))
            visit['plan_revision']=revision+1
            visit['plan_updated_at']=now_iso()
            self.store.update(c,'visits',visit)
            # A new receipt must match the identity the form read, including
            # inferred legacy event links. Keep the stored visit and all prior
            # receipts unchanged; only snapshot the current read projection.
            result=self._visit_view(c,visit)
            if idempotency_key is not None:
                self.store.insert_receipt(c,idempotency_key,'update_visit_plan',visit_id,request_json,result)
            return result

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
            if visit.get('source_verification_id'):
                _,_,source_observed_at=self._follow_up_source(c,visit['source_verification_id'],visit['parcel_id'])
                if payload.observed_at<source_observed_at:
                    raise ServiceError(422,'verification_before_source','复查观察时间不能早于原核验的观察时间，请检查观察时间。')
            risk_id=self._visit_risk_id(c,visit)
            if risk_id:
                candidate=self.required(c,'risks',risk_id)
                trigger=self.required(c,'observations',candidate['observation_id'])
                if payload.observed_at<datetime.fromisoformat(trigger['observed_at']):
                    raise ServiceError(422,'verification_before_observation','现场核验时间不能早于关联候选的触发观测，请检查观察时间。')
            for photo_id in payload.photo_ids:
                p=self.required(c,'photos',photo_id)
                if p['visit_id']!=visit_id: raise ServiceError(422,'photo_mismatch','核验照片必须属于本次巡田')
            result=entity('verification',visit_id=visit_id,parcel_id=visit['parcel_id'],**request,data_origin=visit['data_origin'],label_source='field_report_unadjudicated',disposition='review_required',risk_id=risk_id,
                          **({'source_verification_id':visit['source_verification_id']} if visit.get('source_verification_id') else {}))
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
            if risk_id:
                risk=self.required(c,'risks',risk_id);risk['status']='review_required';risk['disposition']='unresolved';risk['verification_id']=result['id']
                self.store.update(c,'risks',risk)
            return result

    def add_event(self,parcel_id,payload,idempotency_key=None):
        request_json=self.idempotency_request(payload,idempotency_key)
        with self.store.connect(write=True) as c:
            prior=self.replay(c,idempotency_key,'add_event',parcel_id,request_json)
            if prior is not None: return prior
            p=self.required(c,'parcels',parcel_id)
            self.require_season(p,payload.occurred_on)
            ev=entity('event',parcel_id=parcel_id,**payload.model_dump(mode='json'),data_origin=p['data_origin'])
            self.store.insert(c,'events',ev,parcel_id=parcel_id)
            if idempotency_key is not None:
                self.store.insert_receipt(c,idempotency_key,'add_event',parcel_id,request_json,ev)
            return ev

    def dashboard(self):
        with self.store.connect() as c:
            parcels=self.store.all(c,'parcels');risks=[self._risk_view(r) for r in self.store.all(c,'risks')];visits=self.store.all(c,'visits');verifications=[self._report_view(c,v) for v in self.store.all(c,'verifications')]
            now=datetime.now(timezone.utc)
            output=[]
            for p in parcels:
                obs=sorted(self.store.all(c,'observations',p['id']),key=lambda o:o['observed_at'])
                optical=[o for o in obs if o['source']=='sentinel2']
                weather=[o for o in obs if o['source']=='weather']
                def freshness(rows,optical=False):
                    valid=[o for o in rows if (quality_eligible(o) if optical else o['quality']['usable'] and o['quality']['valid_fraction']>=.6) and datetime.fromisoformat(o['observed_at'])<=now]
                    latest=max(valid,key=lambda o:datetime.fromisoformat(o['observed_at']))['observed_at'] if valid else None
                    status='missing' if not rows else 'quality_limited' if not valid else 'stale' if now-datetime.fromisoformat(latest)>timedelta(days=14) else 'available'
                    return latest,status
                optical_at,optical_status=freshness(optical,True)
                weather_at,weather_status=freshness(weather)
                trust=qualification(obs,geometry_sha256(p['geometry']),fixture=p['data_origin']=='fixture')
                preview=evaluate(obs,'statistical',now,mode=trust['mode'])
                monitoring_status='fixture_demo' if trust['mode']=='fixture_demo' else 'preview_only' if preview['status'] in {'candidate','not_flagged'} else 'blocked'
                output.append({**p,
                    # Legacy aliases now refer to the optical signal only. A
                    # recent weather record must never renew the NDVI panel.
                    'latest_observed_at':optical_at,'data_status':optical_status,
                    'latest_optical_observed_at':optical_at,'optical_data_status':optical_status,
                    'latest_weather_observed_at':weather_at,'weather_data_status':weather_status,
                    'monitoring_status':monitoring_status,'qualification_status':trust['qualification_status'],'monitoring_eligible':False,
                    'observation_count':len(obs),'open_risk_count':sum(r['parcel_id']==p['id'] and r['disposition']=='unresolved' for r in risks),
                    'review_required_count':sum(v['parcel_id']==p['id'] for v in verifications)})
            return {'parcel_count':len(parcels),'open_risk_count':sum(r['disposition']=='unresolved' for r in risks),'pending_visit_count':sum(v['status']=='pending' for v in visits),'verification_count':len(verifications),
                    'review_required_count':len(verifications),'parcels':output,'recent_verifications':sorted(verifications,key=lambda v:v['created_at'],reverse=True)[:20]}

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
