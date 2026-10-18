#!/usr/bin/env python3
"""Actual local HTTP smoke against the production build and an isolated empty DB."""
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

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
            def post(path,body):
                request=urllib.request.Request(base+path,data=json.dumps(body).encode(),headers={'Content-Type':'application/json','Origin':base},method='POST')
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
            print(json.dumps({'http':'passed','empty_default':True,'pages_assets':sorted(set(checked)),'sample_import_records':4,'repeat_created':repeat['created'],'farm_counts':{k:dashboard[k] for k in ['parcel_count','open_risk_count','pending_visit_count','verification_count']},'optical_median_ndvi':stored['observations'][0]['features']['ndvi'],'private_data_sent':False},ensure_ascii=False,indent=2))
        finally:
            process.terminate()
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:process.kill();process.wait()
