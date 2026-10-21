"""Local-only prototype entry point; no external requests, auth or deployment."""
import os
from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException
from app.adapters.storage import SQLiteStore
from app.application.service import FieldService, ServiceError
from app.api.routes import router

ROOT=Path(__file__).resolve().parents[2]


def create_app(db_path=None,fixtures_enabled=None,source_manifest=None):
    db_path=db_path or os.getenv('FIELDSIGNAL_DB',str(ROOT/'backend'/'var'/'fieldsignal.sqlite3'))
    fixtures_enabled=fixtures_enabled if fixtures_enabled is not None else os.getenv('FIELDSIGNAL_ENABLE_FIXTURES')=='1'
    app=FastAPI(title='FieldSignal local V0',version='0.1.0',docs_url=None,redoc_url=None)
    app.add_middleware(TrustedHostMiddleware,allowed_hosts=['127.0.0.1','localhost','testserver'])
    store=SQLiteStore(db_path);service=FieldService(store,source_manifest)
    app.state.service=service

    @app.middleware('http')
    async def local_requests(request:Request,call_next):
        origin=request.headers.get('origin')
        allowed={'http://localhost:5173','http://127.0.0.1:5173','http://localhost:8000','http://127.0.0.1:8000'}
        allowed.add(f'{request.url.scheme}://{request.url.netloc}')
        if origin and origin not in allowed:
            return JSONResponse({'error':{'code':'origin_not_allowed','message':'此本地原型只接受同机界面请求','details':[]}},status_code=403)
        response=await call_next(request)
        response.headers['X-Content-Type-Options']='nosniff'
        response.headers['Referrer-Policy']='no-referrer'
        response.headers['Cache-Control']='no-store'
        # Local assets only. Never leak parcel geometry, photo IDs or URLs to a CDN.
        response.headers['Content-Security-Policy']="default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
        return response

    @app.exception_handler(ServiceError)
    async def service_error(request,exc):
        return JSONResponse({'error':{'code':exc.code,'message':exc.message,'details':[]}},status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request,exc):
        details=[{'field':'.'.join(map(str,e['loc'])),'message':e['msg']} for e in exc.errors()]
        return JSONResponse({'error':{'code':'validation_error','message':'输入数据不符合约定，请检查字段。','details':details}},status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request,exc):
        return JSONResponse({'error':{'code':'http_error','message':str(exc.detail),'details':[]}},status_code=exc.status_code,headers=exc.headers)

    app.include_router(router(service,fixtures_enabled))
    dist=ROOT/'frontend'/'dist'
    if dist.exists():
        if (dist/'assets').exists(): app.mount('/assets',StaticFiles(directory=dist/'assets'),name='assets')
        @app.get('/')
        @app.get('/admin')
        @app.get('/field')
        def frontend(): return FileResponse(dist/'index.html')
        for filename in ['manifest.webmanifest','icon.svg','sw.js']:
            if (dist/filename).is_file():
                def static_endpoint(path):
                    def serve_file(): return FileResponse(path)
                    return serve_file
                app.add_api_route('/'+filename,static_endpoint(dist/filename),methods=['GET'],include_in_schema=False)
    return app

app=create_app()
