"""Validated contracts. Coordinates never leave this service automatically."""
from __future__ import annotations

from datetime import date, datetime, timezone
from math import cos, radians
from zoneinfo import ZoneInfo
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, StrictFloat, field_validator, model_validator

Number = Annotated[float, Field(strict=True, allow_inf_nan=False)]
Unit = Annotated[float, Field(strict=True, ge=0, le=1, allow_inf_nan=False)]
Text = Annotated[str, Field(min_length=1, max_length=200)]

class Contract(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True, allow_inf_nan=False)

class Polygon(Contract):
    type: Literal['Polygon'] = 'Polygon'
    coordinates: list[list[list[Number]]]

    @field_validator('coordinates')
    @classmethod
    def validate_polygon(cls, rings):
        if len(rings) != 1:
            raise ValueError('V0仅支持一个外环；带孔/多面地块待空间适配器接入')
        ring = rings[0]
        if not 4 <= len(ring) <= 1000 or ring[0] != ring[-1]:
            raise ValueError('外环须闭合，含4至1000个坐标点')
        if any(len(p) != 2 or not -180 <= p[0] <= 180 or not -85 <= p[1] <= 85 for p in ring):
            raise ValueError('坐标须为WGS84 [经度, 纬度]，纬度范围-85至85')
        if len({tuple(p) for p in ring[:-1]}) != len(ring) - 1:
            raise ValueError('地块边界不能包含重复顶点')
        if max(p[0] for p in ring)-min(p[0] for p in ring) > 1 or max(p[1] for p in ring)-min(p[1] for p in ring)>1:
            raise ValueError('V0仅支持局部地块，边界跨度不能超过1度')
        def orientation(a,b,c):
            return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
        def on(a,b,p):
            return min(a[0],b[0]) <= p[0] <= max(a[0],b[0]) and min(a[1],b[1]) <= p[1] <= max(a[1],b[1])
        def intersects(a,b,c,d):
            x,y,z,w = orientation(a,b,c),orientation(a,b,d),orientation(c,d,a),orientation(c,d,b)
            return (x*y<0 and z*w<0) or (x==0 and on(a,b,c)) or (y==0 and on(a,b,d)) or (z==0 and on(c,d,a)) or (w==0 and on(c,d,b))
        n=len(ring)-1
        for i in range(n):
            for j in range(i+1,n):
                if j==i+1 or (i==0 and j==n-1): continue
                if intersects(ring[i],ring[i+1],ring[j],ring[j+1]):
                    raise ValueError('地块边界不能自交或自接触')
        if approximate_area_ha(ring) < 0.0001:
            raise ValueError('地块面积不能为零')
        return rings

def approximate_area_ha(ring):
    """Local equirectangular estimate only; not surveying or authoritative area."""
    lon0,lat0=ring[0]
    points=[((x-lon0)*111320*cos(radians(lat0)),(y-lat0)*110540) for x,y in ring]
    return abs(sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(points,points[1:])))/20000

class ParcelCreate(Contract):
    name: Annotated[str, Field(min_length=1, max_length=80)]
    region: Literal['shayang','luotian','other'] = 'shayang'
    crop: Literal['oilseed_rape'] = 'oilseed_rape'
    season: Annotated[str, Field(pattern=r'^20\d{2}-20\d{2}$')]
    sowing_date: date | None = None
    cultivar: Annotated[str, Field(max_length=100)] | None = None
    geometry: Polygon
    boundary_source: Literal['user_provided','user_survey','public_dataset'] = 'user_provided'
    boundary_reference: Annotated[str, Field(max_length=500)] | None = None

    @model_validator(mode='after')
    def dates(self):
        first,last=map(int,self.season.split('-'))
        if last != first+1: raise ValueError('生长季须为相邻两年，如2026-2027')
        if self.sowing_date and not date(first,7,1)<=self.sowing_date<=date(last,6,30):
            raise ValueError('播种日期不在所填生长季内（7月1日至次年6月30日）')
        return self

class Features(Contract):
    ndvi: Annotated[float, Field(strict=True,ge=-1,le=1)] | None = None
    ndre: Annotated[float, Field(strict=True,ge=-1,le=1)] | None = None
    evi: Annotated[float, Field(strict=True,ge=-1,le=3)] | None = None
    ndwi: Annotated[float, Field(strict=True,ge=-1,le=1)] | None = None
    vv_db: Annotated[float, Field(strict=True,ge=-60,le=20)] | None = None
    vh_db: Annotated[float, Field(strict=True,ge=-60,le=20)] | None = None
    temperature_min_c: Annotated[float, Field(strict=True,ge=-90,le=65)] | None = None
    temperature_max_c: Annotated[float, Field(strict=True,ge=-90,le=65)] | None = None
    precipitation_mm: Annotated[float, Field(strict=True,ge=0,le=2000)] | None = None

    @model_validator(mode='after')
    def nonempty(self):
        if not self.model_dump(exclude_none=True): raise ValueError('观测至少包含一项有效指标，缺失不得填0')
        if self.temperature_min_c is not None and self.temperature_max_c is not None and self.temperature_min_c>self.temperature_max_c:
            raise ValueError('最低温不能高于最高温')
        return self

class Quality(Contract):
    usable: bool
    valid_fraction: Unit
    cloud_fraction: Unit | None = None
    flags: list[Annotated[str, Field(max_length=100)]] = Field(default_factory=list,max_length=20)

class SpatialSupport(Contract):
    kind: Literal['public_window','parcel','coarse_grid','unknown'] = 'unknown'
    crs: Text | None = None
    bounds: list[Number] | None = Field(default=None,min_length=4,max_length=4)
    pixel_size_m: Number | None = Field(default=None,gt=0)
    scl_pixel_size_m: Number | None = Field(default=None,gt=0)
    grid_degrees: dict[Literal['latitude','longitude'],Number] | None = None
    total_pixels: int | None = Field(default=None,ge=1)
    valid_pixels: int | None = Field(default=None,ge=0)

class Provenance(Contract):
    provider: Text
    collection: Text
    item_id: Text
    processing_version: Text
    license: Annotated[str, Field(max_length=500)] | None = None
    source_uri: Annotated[str, Field(max_length=1500)] | None = None
    spatial_resolution_m: Annotated[float, Field(strict=True,gt=0,le=1000000)] | None = None
    temporal_support: Literal['instantaneous','daily_utc','daily_local_solar','daily_beijing'] = 'instantaneous'
    support_note: Annotated[str, Field(max_length=1000)] | None = None
    retrieved_at: datetime | None = None
    usage_scope: Literal['unverified','public_sample','parcel'] = 'unverified'
    spatial_support: SpatialSupport | None = None
    asset_checksums: dict[Text,Annotated[str, Field(pattern=r'^[0-9a-f]{64}$')]] = Field(default_factory=dict,max_length=20)
    parcel_geometry_sha256: Annotated[str, Field(pattern=r'^[0-9a-f]{64}$')] | None = None
    parcel_mask_sha256: Annotated[str, Field(pattern=r'^[0-9a-f]{64}$')] | None = None

    @field_validator('retrieved_at')
    @classmethod
    def retrieval_time(cls, dt):
        if dt is None: return dt
        if dt.tzinfo is None or dt.utcoffset() is None or dt>datetime.now(timezone.utc):
            raise ValueError('获取时间必须为含时区的过去时间')
        return dt.astimezone(timezone.utc)

class ObservationCreate(Contract):
    observed_at: datetime
    source: Literal['sentinel2','sentinel1','weather','manual']
    source_record_id: Text
    features: Features
    quality: Quality
    provenance: Provenance

    @field_validator('observed_at')
    @classmethod
    def aware_past(cls, dt):
        if dt.tzinfo is None or dt.utcoffset() is None: raise ValueError('时间必须含时区')
        if dt>datetime.now(timezone.utc): raise ValueError('观测时间不能在未来')
        return dt.astimezone(timezone.utc)

    @model_validator(mode='after')
    def modality(self):
        allowed={'sentinel2':{'ndvi','ndre','evi','ndwi'},'sentinel1':{'vv_db','vh_db'},'weather':{'temperature_min_c','temperature_max_c','precipitation_mm'}}
        if self.source!='manual' and not set(self.features.model_dump(exclude_none=True)) <= allowed[self.source]:
            raise ValueError('指标与数据源模态不匹配')
        if self.source=='sentinel2' and self.quality.cloud_fraction is None:
            raise ValueError('光学观测必须提供地块云量质量字段')
        return self

class AnalysisCreate(Contract):
    method: Literal['statistical','isolation_forest'] = 'statistical'

class PublicSampleImportCreate(Contract):
    sample_id: Text

class VisitCreate(Contract):
    parcel_id: Text
    risk_id: Text | None = None
    due_date: date
    assignee: Annotated[str, Field(max_length=100)] | None = None
    note: Annotated[str, Field(max_length=2000)] | None = None

class VerificationCreate(Contract):
    observed_at: datetime
    label: Literal['normal','waterlogging','frost','disease_suspected','other','uncertain']
    note: Annotated[str, Field(min_length=1,max_length=2000)]
    photo_ids: list[Text] = Field(default_factory=list,max_length=8)
    client_submission_id: Annotated[str, Field(min_length=8,max_length=100)] | None = None

    _time = field_validator('observed_at')(ObservationCreate.aware_past.__func__)

    @field_validator('photo_ids')
    @classmethod
    def unique(cls, ids):
        if len(ids)!=len(set(ids)): raise ValueError('照片ID重复')
        return ids

class FarmEventCreate(Contract):
    occurred_on: date
    kind: Literal['sowing','fertilizing','spraying','drainage','other']
    note: Annotated[str, Field(min_length=1,max_length=2000)]

    @field_validator('occurred_on')
    @classmethod
    def not_future(cls, dt):
        if dt>datetime.now(ZoneInfo('Asia/Shanghai')).date(): raise ValueError('农事记录日期不能在未来')
        return dt
