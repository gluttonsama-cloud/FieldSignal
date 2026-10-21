from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import Response
from fastapi.routing import APIRoute
from app.domain.models import ParcelCreate, ObservationCreate, ObservationBatchCreate, AnalysisCreate, VisitCreate, FollowUpVisitCreate, VisitPlanUpdate, VerificationCreate, FarmEventCreate
from app.application.service import ServiceError
from app.domain.models import PublicSampleImportCreate
from app.adapters.local_bundle import BundleError

MAX_OBSERVATION_BATCH_BYTES=1024*1024


class ObservationBatchRoute(APIRoute):
    """Bound actual incoming bytes before FastAPI buffers or parses the batch."""
    def get_route_handler(self):
        handler=super().get_route_handler()

        async def bounded_handler(request:Request):
            raw=bytearray()
            async for chunk in request.stream():
                if len(raw)+len(chunk)>MAX_OBSERVATION_BATCH_BYTES:
                    raise ServiceError(413,'observation_batch_too_large','批量观测请求不能超过1 MiB，未导入本次请求。')
                raw.extend(chunk)
            # Replay the bounded body through a normal Request, preserving typed
            # validation and OpenAPI without global middleware or private caches.
            pending=True
            async def receive():
                nonlocal pending
                if pending:
                    pending=False
                    return {'type':'http.request','body':bytes(raw),'more_body':False}
                return await request.receive()
            return await handler(Request(request.scope,receive))
        return bounded_handler


def request_idempotency_key(values:list[str]|None=Header(default=None,alias='Idempotency-Key',description='Optional single globally unique 1–128 character token: letters, digits, . _ : -. Reuse only for the same operation, target and normalized payload.')):
    if values is None: return None
    if len(values)!=1:
        raise ServiceError(422,'invalid_idempotency_key','只能提供一个 Idempotency-Key 请求头。')
    return values[0]


def router(service,fixtures_enabled):
    api=APIRouter(prefix='/api/v1')

    @api.get('/health')
    def health(): return {'status':'ok','version':'0.1.0','storage':'sqlite-local-no-spatial-sql','demo_enabled':fixtures_enabled}

    @api.get('/dashboard')
    def dashboard(): return service.dashboard()

    @api.get('/sources')
    def sources(): return service.source_imports.sources()

    @api.post('/source-imports/public-sample',status_code=201)
    def import_public_sample(body:PublicSampleImportCreate):
        try: return service.source_imports.import_sample(body.sample_id)
        except BundleError as exc:
            raise ServiceError(422,'source_import_invalid','本地样本校验或归一化失败，未导入。'+str(exc)) from exc

    @api.get('/source-imports/{import_id}')
    def source_import(import_id:str):
        result=service.source_imports.get(import_id)
        if result is None: raise ServiceError(404,'not_found','导入记录不存在')
        return result

    @api.get('/parcels')
    def parcels(): return service.list('parcels')

    @api.post('/parcels',status_code=201)
    def create_parcel(body:ParcelCreate,idempotency_key:str|None=Depends(request_idempotency_key)):
        return service.create_parcel(body,idempotency_key)

    @api.get('/parcels/{parcel_id}')
    def parcel(parcel_id:str): return service.parcel(parcel_id)

    @api.get('/parcels/{parcel_id}/observations')
    def observations(parcel_id:str): return service.list('observations',parcel_id)

    @api.post('/parcels/{parcel_id}/observations',status_code=201)
    def add_observation(parcel_id:str,body:ObservationCreate): return service.add_observation(parcel_id,body)

    batch_api=APIRouter(route_class=ObservationBatchRoute)

    @batch_api.post('/parcels/{parcel_id}/observation-batches',status_code=201)
    def add_observation_batch(parcel_id:str,body:ObservationBatchCreate,idempotency_key:str|None=Depends(request_idempotency_key)):
        return service.add_observation_batch(parcel_id,body,idempotency_key)

    api.include_router(batch_api)

    @api.post('/parcels/{parcel_id}/analyses',status_code=201)
    def analyse(parcel_id:str,body:AnalysisCreate): return service.analyse(parcel_id,body.method)

    @api.get('/parcels/{parcel_id}/analyses')
    def analyses(parcel_id:str): return service.list('analyses',parcel_id)

    @api.get('/risks')
    def risks(): return service.list('risks')

    @api.post('/visits',status_code=201)
    def create_visit(body:VisitCreate,idempotency_key:str|None=Depends(request_idempotency_key)):
        return service.create_visit(body,idempotency_key)

    @api.get('/visits')
    def visits(): return service.list('visits')

    @api.post('/visits/{visit_id}/plan')
    def update_visit_plan(visit_id:str,body:VisitPlanUpdate,idempotency_key:str|None=Depends(request_idempotency_key)):
        return service.update_visit_plan(visit_id,body,idempotency_key)

    @api.post('/visits/{visit_id}/photos',status_code=201)
    async def upload_photo(visit_id:str,request:Request):
        raw=bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw)>10*1024*1024: raise ServiceError(413,'image_too_large','照片不能超过10MB')
        return service.upload_photo(visit_id,request.headers.get('content-type','').split(';')[0],bytes(raw))

    @api.delete('/visits/{visit_id}/photos/{photo_id}',status_code=204)
    def remove_staged_photo(visit_id:str,photo_id:str):
        service.remove_staged_photo(visit_id,photo_id)
        return Response(status_code=204)

    @api.get('/photos/{photo_id}')
    def photo(photo_id:str):
        meta,blob=service.photo(photo_id)
        return Response(content=blob,media_type=meta['content_type'],headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'})

    @api.post('/visits/{visit_id}/verifications',status_code=201)
    def verify(visit_id:str,body:VerificationCreate): return service.verify(visit_id,body)

    @api.get('/verifications')
    def verifications(): return service.list('verifications')

    @api.post('/verifications/{verification_id}/follow-up-visits',status_code=201)
    def create_follow_up_visit(verification_id:str,body:FollowUpVisitCreate,idempotency_key:str|None=Depends(request_idempotency_key)):
        return service.create_follow_up_visit(verification_id,body,idempotency_key)

    @api.get('/parcels/{parcel_id}/events')
    def events(parcel_id:str): return service.list('events',parcel_id)

    @api.post('/parcels/{parcel_id}/events',status_code=201)
    def add_event(parcel_id:str,body:FarmEventCreate,idempotency_key:str|None=Depends(request_idempotency_key)):
        return service.add_event(parcel_id,body,idempotency_key)

    @api.post('/dev/fixtures',status_code=201)
    def fixture():
        if not fixtures_enabled: raise ServiceError(404,'not_found','开发模拟数据入口未启用')
        return service.seed_fixture()

    return api
