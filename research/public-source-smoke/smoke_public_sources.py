#!/usr/bin/env python3
"""Two small anonymous reads; optional three 320m COG windows. No credentials.
Metadata-only: python smoke_public_sources.py
Pixel smoke: /usr/bin/python3 smoke_public_sources.py --pixels
Requires GDAL Python + NumPy only for --pixels. Never installs anything.
"""
import argparse,datetime,json,os,pathlib,runpy,urllib.request,urllib.parse
ROOT=pathlib.Path(__file__).resolve().parent
ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--pixels',action='store_true');ap.add_argument('--output',type=pathlib.Path);args=ap.parse_args()
now=datetime.datetime.now(datetime.UTC)
out=args.output or ROOT/'runs'/now.strftime('%Y%m%dT%H%M%SZ');out.mkdir(parents=True,exist_ok=True)
queries={
 'earthsearch_s2_c1_clear_search':('https://earth-search.aws.element84.com/v1/search',{'collections':'sentinel-2-c1-l2a','bbox':'112.35,30.65,112.45,30.75','datetime':'2025-03-01T00:00:00Z/2025-04-30T23:59:59Z','query':json.dumps({'eo:cloud_cover':{'lt':20}}),'limit':1}),
 'power_weather_aligned':('https://power.larc.nasa.gov/api/temporal/daily/point',{'parameters':'T2M_MIN,T2M_MAX,PRECTOTCORR','community':'AG','longitude':112.4,'latitude':30.7,'start':'20250426','end':'20250428','format':'JSON','time-standard':'UTC'})}
for name,(endpoint,params) in queries.items():
 url=endpoint+'?'+urllib.parse.urlencode(params)
 with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'FieldSignalPublicSmoke/0.1'}),timeout=60)as r:
  raw=r.read(250001)
  if len(raw)>250000:raise RuntimeError('Metadata response exceeds 250 KB limit')
  obj=json.loads(raw)
  if name.startswith('earthsearch') and not obj.get('features'):raise RuntimeError('No scene found; do not manufacture an observation')
  (out/(name+'.json')).write_text(json.dumps(obj,ensure_ascii=False,indent=2))
  (out/(name+'_request.json')).write_text(json.dumps({'request_url':url,'retrieved_at_utc':datetime.datetime.now(datetime.UTC).isoformat(),'status':r.status,'bytes':len(raw)},indent=2))
  print(name,r.status,len(raw),'bytes')
if args.pixels:
 try:from osgeo import gdal
 except ImportError:raise SystemExit('Metadata saved; pixel validation needs an existing GDAL Python + NumPy environment. No packages installed.')
 os.environ['FIELDSIGNAL_SMOKE_OUTPUT']=str(out)
 runpy.run_path(str(ROOT/'read_optical_window.py'),run_name='__main__')
print('Evidence saved:',out)
