#!/usr/bin/python3
"""Read three tiny public Sentinel-2 COG windows, never a full scene.
Requires GDAL Python bindings + NumPy. Public demonstration square, not a farm.
Run after probe_catalogs.py plus C1 search fixture generation.
"""
from osgeo import gdal,osr
import json,pathlib,datetime,urllib.request,hashlib,os,numpy as np
P=pathlib.Path(os.environ.get("FIELDSIGNAL_SMOKE_OUTPUT", pathlib.Path(__file__).parent))
item=json.loads((P/'earthsearch_s2_c1_clear_search.json').read_text())['features'][0]
gdal.UseExceptions()
for k,v in {'GDAL_DISABLE_READDIR_ON_OPEN':'EMPTY_DIR','CPL_VSIL_CURL_ALLOWED_EXTENSIONS':'.tif','GDAL_HTTP_MAX_RETRY':'0','GDAL_HTTP_TIMEOUT':'45','CPL_CURL_VERBOSE':'YES','CPL_DEBUG':'VSICURL'}.items():gdal.SetConfigOption(k,v)
src=osr.SpatialReference();src.ImportFromEPSG(4326);src.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
dst=osr.SpatialReference();dst.ImportFromEPSG(32649);dst.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
x,y,_=osr.CoordinateTransformation(src,dst).TransformPoint(112.4,30.7)
# Snap to a shared 20m grid; a 320m square with exact 10/20m correspondence.
left=int(x//20)*20-160;top=int(y//20)*20+160
result={'read_at_utc':datetime.datetime.now(datetime.UTC).isoformat(),'demonstration_only':True,'not_a_known_oilseed_rape_field':True,'item_id':item['id'],'acquired_at':item['properties']['datetime'],'scene_cloud_cover_pct':item['properties']['eo:cloud_cover'],'center_wgs84':[112.4,30.7],'window_bounds_epsg32649':[left,top-320,left+320,top],'assets':{}}
arrs={}
for band in ['red','nir','scl']:
 a=item['assets'][band];u=a['href']
 with urllib.request.urlopen(urllib.request.Request(u,headers={'Range':'bytes=0-16383'}),timeout=45)as r:
  if r.status!=206:raise RuntimeError('Server lacks range response; refusing potential full download')
  b=r.read(16385)
  if len(b)>16384:raise RuntimeError('Range response over limit')
  rangeproof={'status':r.status,'content_range':r.headers.get('Content-Range'),'bytes_read':len(b),'header_sha256':hashlib.sha256(b).hexdigest(),'magic_hex':b[:4].hex()}
 ds=gdal.Open('/vsicurl/'+u);gt=ds.GetGeoTransform();s=abs(gt[1]);col=round((left-gt[0])/s);row=round((gt[3]-top)/s);n=round(320/s)
 assert col>=0 and row>=0 and col+n<=ds.RasterXSize and row+n<=ds.RasterYSize
 rb=ds.GetRasterBand(1);arr=rb.ReadAsArray(col,row,n,n);arrs[band]=arr
 out=P/(band+'_sample_320m.tif');gdal.Translate(str(out),ds,srcWin=[col,row,n,n])
 vals,counts=np.unique(arr,return_counts=True)
 result['assets'][band]={'asset_href':u,'http_range_probe':rangeproof,'gdal_size':[ds.RasterXSize,ds.RasterYSize],'gdal_crs':ds.GetSpatialRef().GetAuthorityCode(None),'gdal_geotransform':gt,'gdal_dtype':gdal.GetDataTypeName(rb.DataType),'gdal_nodata':rb.GetNoDataValue(),'gdal_scale':rb.GetScale(),'gdal_offset':rb.GetOffset(),'stac_raster_band':a.get('raster:bands',[{}])[0],'pixel_window':[col,row,n,n],'raw_min':float(arr.min()),'raw_max':float(arr.max()),'unique_class_counts':{str(int(v)):int(c)for v,c in zip(vals,counts)} if band=='scl' else None,'local_sample_sha256':hashlib.sha256(out.read_bytes()).hexdigest()}
 ds=None
red=arrs['red'].astype(float)*item['assets']['red']['raster:bands'][0]['scale']+item['assets']['red']['raster:bands'][0].get('offset',0)
nir=arrs['nir'].astype(float)*item['assets']['nir']['raster:bands'][0]['scale']+item['assets']['nir']['raster:bands'][0].get('offset',0)
scl=np.repeat(np.repeat(arrs['scl'],2,axis=0),2,axis=1)
valid=np.isin(scl,[4,5])&(arrs['red']!=0)&(arrs['nir']!=0)&(red>=0)&(nir>=0)&(red+nir>1e-6)
ndvi=(nir[valid]-red[valid])/(nir[valid]+red[valid])
result['smoke_metric']={'rule':'SCL 4/5 only, raw nodata removed, nonnegative reflectance, finite positive denominator; no crop truth','total_10m_pixels':int(valid.size),'valid_10m_pixels':int(valid.sum()),'valid_fraction':float(valid.mean()),'median_ndvi':float(np.median(ndvi)) if ndvi.size else None,'warning':'One public 320m square and one date verifies plumbing only; no oilseed-rape label, anomaly, yield, disease, or accuracy inference.'}
(P/'optical_window_evidence.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False,indent=2))
