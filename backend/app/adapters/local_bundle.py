"""Offline, reusable adapters for lawfully obtained local S2 windows / POWER JSON.

Nothing fetches URLs. Manifests bind every input byte by SHA-256. Public windows
cannot become parcel evidence. Parcel optical inputs require an explicit aligned
binary mask and a hash binding to the target GeoJSON (not a land-ownership claim).
"""
from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
from typing import Annotated, Literal
from xml.etree import ElementTree
import numpy as np
from PIL import Image
from pydantic import Field, ValidationError, model_validator
from app.domain.models import Contract, Text, ObservationCreate, Polygon

PROCESSING_VERSION='local-bundle-v1-scl45-median'
MAX_FILE_BYTES=32*1024*1024
MAX_TOTAL_BYTES=64*1024*1024
MAX_PIXELS=4_000_000
Digest=Annotated[str,Field(pattern=r'^[0-9a-f]{64}$')]

class BundleError(ValueError): pass

class LocalFile(Contract):
    path: Annotated[str,Field(min_length=1,max_length=400)]
    sha256: Digest

class LocalRecord(Contract):
    adapter: Literal['sentinel2_local_window','nasa_power_daily']
    retrieved_at: datetime
    provider: Text
    license: Annotated[str,Field(min_length=1,max_length=500)]
    source_uri: Annotated[str,Field(max_length=1500)]
    stac: Text | None = None
    item_id: Text | None = None
    assets: dict[Literal['red','nir','scl'],Text] = Field(default_factory=dict)
    data: Text | None = None
    mask: Text | None = None

    @model_validator(mode='after')
    def references(self):
        if self.retrieved_at.tzinfo is None or self.retrieved_at>datetime.now(timezone.utc):
            raise ValueError('retrieved_at must have a timezone and cannot be in the future')
        if self.adapter=='sentinel2_local_window' and (not self.stac or not self.item_id or set(self.assets)!={'red','nir','scl'} or self.data):
            raise ValueError('Optical records require stac, item_id, red/nir/scl assets')
        if self.adapter=='nasa_power_daily' and (not self.data or self.stac or self.assets or self.mask):
            raise ValueError('POWER records require only a data file')
        return self

class LocalBundle(Contract):
    schema_version: Literal[1]
    bundle_id: Text
    scope: Literal['public_sample','parcel']
    title: Text
    files: dict[Text,LocalFile] = Field(min_length=1,max_length=100)
    records: list[LocalRecord] = Field(min_length=1,max_length=100)
    limitations: list[Text] = Field(default_factory=list,max_length=20)
    parcel_geometry_sha256: Digest | None = None

    @model_validator(mode='after')
    def scope_binding(self):
        for record in self.records:
            references=[record.stac,record.data,record.mask,*record.assets.values()]
            if any(key is not None and key not in self.files for key in references):
                raise ValueError('Record references an undeclared local file')
        if self.scope=='parcel' and not self.parcel_geometry_sha256:
            raise ValueError('Parcel bundles require parcel_geometry_sha256')
        if self.scope=='public_sample' and self.parcel_geometry_sha256:
            raise ValueError('Public samples cannot be bound to a farm parcel')
        if self.scope=='parcel' and any(r.adapter=='sentinel2_local_window' and not r.mask for r in self.records):
            raise ValueError('Parcel optical inputs require an aligned binary parcel mask')
        return self


def geometry_sha256(geometry:dict) -> str:
    normalized=Polygon.model_validate(geometry).model_dump(mode='json')
    return sha256(json.dumps(normalized,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def _json(raw):
    def invalid(value): raise BundleError(f'Non-finite JSON number: {value}')
    return json.loads(raw,parse_constant=invalid)


def _raster(raw):
    with Image.open(BytesIO(raw)) as img:
        if img.format!='TIFF' or getattr(img,'n_frames',1)!=1 or img.width*img.height>MAX_PIXELS:
            raise BundleError('Expected a small single-page local GeoTIFF, not a full scene')
        tags=dict(img.tag_v2)
        if tags.get(277,1)!=1 or 34264 in tags:
            raise BundleError('Only single-band north-up GeoTIFF windows are supported')
        scale=tags.get(33550); tie=tags.get(33922); keys=tags.get(34735,())
        if not scale or len(scale)!=3 or not tie or len(tie)!=6 or tie[:3]!=(0.,0.,0.) or scale[0]<=0 or scale[1]<=0:
            raise BundleError('Missing or unsupported raster grid metadata')
        geo={keys[i]:keys[i+3] for i in range(4,len(keys),4) if len(keys)>=i+4 and keys[i+1]==0 and keys[i+2]==1}
        epsg=geo.get(3072)
        if not epsg or geo.get(1025)!=1 or geo.get(3076)!=9001:
            raise BundleError('Expected projected EPSG CRS, metre units and pixel-area support')
        array=np.array(img)
        if array.ndim!=2 or not np.issubdtype(array.dtype,np.integer):
            raise BundleError('Expected an integer single-band raster')
        bounds=[tie[3],tie[4]-img.height*scale[1],tie[3]+img.width*scale[0],tie[4]]
        gdal={}
        if tags.get(42112):
            for node in ElementTree.fromstring(tags[42112]).findall('Item'):
                if node.get('role') in {'scale','offset'}: gdal[node.get('role')]=float(node.text)
        return array,{'crs':f'EPSG:{epsg}','bounds':bounds,'pixel_size_m':float(scale[0]),'pixel_y_m':float(scale[1]),'gdal':gdal,'nodata':float(tags[42113]) if 42113 in tags else None}


class LocalObservationBundleAdapter:
    """Input root is the manifest directory; caller controls its filesystem access."""
    def __init__(self,manifest_path):
        path=Path(manifest_path).resolve()
        try:
            if path.stat().st_size>1024*1024: raise BundleError('Manifest exceeds 1 MiB')
            raw=path.read_bytes()
            self.manifest=LocalBundle.model_validate(_json(raw))
            self.bundle_sha256=sha256(raw).hexdigest()
            self.root=path.parent
            self.blobs={}
            total=0
            for key,item in self.manifest.files.items():
                relative=Path(item.path)
                if relative.is_absolute() or '..' in relative.parts or '\\' in item.path:
                    raise BundleError('Input paths must stay inside the manifest directory')
                local=(self.root/relative).resolve()
                if not local.is_relative_to(self.root) or not local.is_file():
                    raise BundleError('Input path escapes the bundle or does not exist')
                size=local.stat().st_size;total+=size
                if size>MAX_FILE_BYTES or total>MAX_TOTAL_BYTES: raise BundleError('Local bundle size limit exceeded')
                data=local.read_bytes()
                if sha256(data).hexdigest()!=item.sha256: raise BundleError(f'Input checksum mismatch: {key}')
                self.blobs[key]=data
        except (OSError,ValidationError,ValueError) as exc:
            if isinstance(exc,BundleError): raise
            raise BundleError(f'Invalid local bundle: {exc}') from exc

    def _base(self,record,keys):
        m=self.manifest
        return {'provider':record.provider,'processing_version':PROCESSING_VERSION,'license':record.license,'source_uri':record.source_uri,'retrieved_at':record.retrieved_at,'usage_scope':m.scope,'asset_checksums':{key:m.files[key].sha256 for key in keys},'parcel_geometry_sha256':m.parcel_geometry_sha256,'parcel_mask_sha256':m.files[record.mask].sha256 if record.mask else None}

    def normalize(self):
        observations=[];warnings=list(self.manifest.limitations)
        try:
            for record in self.manifest.records:
                result,notes=self._optical(record) if record.adapter=='sentinel2_local_window' else self._weather(record)
                observations.extend(result);warnings.extend(notes)
            identities=[(o.source,o.source_record_id) for o in observations]
            if len(identities)!=len(set(identities)): raise BundleError('Duplicate source records in bundle')
            return observations,list(dict.fromkeys(warnings))
        except (KeyError,IndexError,AttributeError,ValueError,TypeError,OverflowError,OSError,ElementTree.ParseError,Image.DecompressionBombError) as exc:
            if isinstance(exc,BundleError): raise
            raise BundleError(f'Local normalization failed: {exc}') from exc

    def _optical(self,r):
        catalog=_json(self.blobs[r.stac])
        items=catalog.get('features',[catalog])
        matches=[item for item in items if item.get('id')==r.item_id]
        if len(matches)!=1: raise BundleError('STAC item must match exactly one local record')
        item=matches[0];props=item['properties']
        if props.get('constellation')!='sentinel-2': raise BundleError('Expected Sentinel-2 STAC item')
        arrays={};grids={};values={}
        for band,key in r.assets.items():
            arrays[band],grids[band]=_raster(self.blobs[key])
            grid=grids[band];meta=item['assets'][band]['raster:bands'][0]
            if grid['crs']!=f"EPSG:{props['proj:epsg']}" or grid['pixel_size_m']!=grid['pixel_y_m'] or not np.isclose(grid['pixel_size_m'],meta['spatial_resolution']):
                raise BundleError('STAC CRS/resolution does not match local TIFF')
            asset=item['assets'][band];transform=asset['proj:transform'];height,width=asset['proj:shape']
            if len(transform)!=6 or transform[1]!=0 or transform[3]!=0 or transform[0]<=0 or transform[4]>=0:
                raise BundleError('Unsupported STAC raster transform')
            step=grid['pixel_size_m'];left,bottom,right,top=grid['bounds']
            if not np.isclose(transform[0],step) or not np.isclose(-transform[4],step) or left<transform[2] or right>transform[2]+width*step or top>transform[5] or bottom<transform[5]-height*step or not np.isclose((left-transform[2])/step,round((left-transform[2])/step)) or not np.isclose((transform[5]-top)/step,round((transform[5]-top)/step)):
                raise BundleError('Local window is outside or misaligned to the source STAC grid')
            if band in {'red','nir'}:
                scale=float(meta['scale']);offset=float(meta.get('offset',0))
                if not np.isfinite(scale) or not np.isfinite(offset) or scale<=0:
                    raise BundleError('Invalid reflectance scale/offset')
                if grid['nodata']!=meta['nodata'] or any(not np.isclose(grid['gdal'].get(k,default),value) for k,value,default in [('scale',scale,1.),('offset',offset,0.)]):
                    raise BundleError('STAC scale/offset/nodata differs from local TIFF')
                values[band]=arrays[band].astype(float)*scale+offset
        red,nir=arrays['red'],arrays['nir'];g=grids['red'];s=grids['scl']
        if red.shape!=nir.shape or g['bounds']!=grids['nir']['bounds'] or g['bounds']!=s['bounds'] or g['crs']!=s['crs']:
            raise BundleError('Bands must share the exact footprint and CRS')
        ratio=s['pixel_size_m']/g['pixel_size_m']
        if ratio!=int(ratio) or not 1<=ratio<=6: raise BundleError('SCL supports integer nearest-neighbour alignment only')
        scl=np.repeat(np.repeat(arrays['scl'],int(ratio),axis=0),int(ratio),axis=1)
        if scl.shape!=red.shape: raise BundleError('SCL dimensions are not aligned to the optical window')
        if not np.isin(scl,range(12)).all(): raise BundleError('Unknown SCL class')
        mask=np.ones(red.shape,dtype=bool)
        if r.mask:
            pixels,mg=_raster(self.blobs[r.mask])
            if pixels.shape!=red.shape or mg['bounds']!=g['bounds'] or mg['crs']!=g['crs'] or not np.isin(pixels,[0,1]).all():
                raise BundleError('Parcel mask must be aligned and binary')
            mask=pixels==1
        total=int(mask.sum())
        if not total: raise BundleError('No pixels inside declared spatial support')
        denom=values['red']+values['nir']
        valid=mask&np.isin(scl,[4,5])&(red!=item['assets']['red']['raster:bands'][0]['nodata'])&(nir!=item['assets']['nir']['raster:bands'][0]['nodata'])&(values['red']>=0)&(values['nir']>=0)&np.isfinite(denom)&(denom>1e-6)
        count=int(valid.sum());fraction=count/total
        # Cloud fraction is actual SCL cloud/cirrus, not scene cloud or 1-valid.
        cloud=float((mask&np.isin(scl,[8,9,10])).sum()/total)
        if not count: return [],[f'{r.item_id}: no valid SCL 4/5 NDVI pixels; no metric invented']
        ndvi=float(np.median((values['nir'][valid]-values['red'][valid])/denom[valid]))
        keys=[r.stac,*r.assets.values()]+([r.mask] if r.mask else [])
        support={'kind':'parcel' if self.manifest.scope=='parcel' else 'public_window','crs':g['crs'],'bounds':g['bounds'],'pixel_size_m':g['pixel_size_m'],'scl_pixel_size_m':s['pixel_size_m'],'total_pixels':total,'valid_pixels':count}
        fingerprint=sha256(json.dumps({'bounds':g['bounds'],'mask':self.manifest.files[r.mask].sha256 if r.mask else None},sort_keys=True).encode()).hexdigest()[:16]
        prov={**self._base(r,keys),'collection':item['collection'],'item_id':r.item_id,'spatial_resolution_m':g['pixel_size_m'],'temporal_support':'instantaneous','spatial_support':support,'support_note':f"SCL 4/5, nodata and invalid reflectance removed; SCL nearest-neighbour alignment adds no spatial information. Median NDVI; no crop truth or diagnosis. Source processing baseline {props.get('s2:processing_baseline','unknown')}."}
        record=ObservationCreate(observed_at=props['datetime'],source='sentinel2',source_record_id=f'{r.item_id}:{fingerprint}',features={'ndvi':ndvi},quality={'usable':fraction>=.6 and cloud<=.4,'valid_fraction':fraction,'cloud_fraction':cloud,'flags':['scl45_only','no_crop_truth'] if self.manifest.scope=='public_sample' else ['scl45_only','user_supplied_parcel_mask']},provenance=prov)
        if r.retrieved_at<record.observed_at: raise BundleError('Retrieval predates the observation')
        return [record],[]

    def _weather(self,r):
        data=_json(self.blobs[r.data]);header=data['header'];params=data['properties']['parameter']
        if header['time_standard']!='UTC': raise BundleError('POWER adapter currently supports explicit UTC daily data only')
        if 'MERRA2' not in header['sources']: raise BundleError('Only MERRA2 meteorological grid support is verified by this adapter')
        specs={'T2M_MIN':('temperature_min_c','C'),'T2M_MAX':('temperature_max_c','C'),'PRECTOTCORR':('precipitation_mm','mm/day')}
        if any(data['parameters'][key]['units']!=units for key,(_,units) in specs.items()): raise BundleError('Unexpected POWER units')
        dates=sorted(set().union(*(params.get(key,{}) for key in specs)))
        if len(dates)>366: raise BundleError('POWER bundle exceeds one year of daily records')
        coords=data['geometry']['coordinates'][:2]
        if len(coords)!=2 or not all(isinstance(x,(int,float)) and np.isfinite(x) for x in coords) or not -180<=coords[0]<=180 or not -90<=coords[1]<=90: raise BundleError('Invalid POWER source point')
        result=[];warnings=[]
        for day in dates:
            when=datetime.strptime(day,'%Y%m%d').replace(tzinfo=timezone.utc)
            if not header['start']<=day<=header['end']: raise BundleError('POWER day outside source interval')
            values={}
            for key,(target,_) in specs.items():
                value=params.get(key,{}).get(day)
                if value is None or value==header['fill_value']: continue
                if isinstance(value,bool) or not isinstance(value,(int,float)) or not np.isfinite(value): raise BundleError('Invalid POWER numeric value')
                values[target]=float(value)
            if not values:
                warnings.append(f'{day}: all POWER parameters missing; no observation created');continue
            identifier=f'POWER:{coords[0]}:{coords[1]}:{day}:UTC'
            prov={**self._base(r,[r.data]),'collection':'NASA-POWER-daily','item_id':identifier,'temporal_support':'daily_utc','spatial_support':{'kind':'coarse_grid','crs':'EPSG:4326','grid_degrees':{'latitude':.5,'longitude':.625}},'support_note':f"Source point {coords}; meteorological grid 0.5° × 0.625°; {'/'.join(header['sources'])}, API {header['api']['version']}. UTC daily interval, not Beijing-time day, field station or forecast. PRECTOTCORR mm/day preserved as daily accumulation."}
            observation=ObservationCreate(observed_at=when,source='weather',source_record_id=identifier,features=values,quality={'usable':len(values)==len(specs),'valid_fraction':len(values)/len(specs),'flags':['coarse_grid_context_only']+(['missing_parameters'] if len(values)!=len(specs) else [])},provenance=prov)
            if r.retrieved_at<when: raise BundleError('Retrieval predates the weather day')
            result.append(observation)
        return result,warnings
