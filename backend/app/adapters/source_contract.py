"""Future provider boundary; intentionally no implicit requests or credentials.

A provider must normalize raw assets before returning ObservationCreate. Keeping
this port separate prevents catalogue availability becoming parcel evidence.
"""
from dataclasses import dataclass
from typing import Literal, Protocol
from app.domain.models import ObservationCreate

Availability = Literal['not_connected','catalog_only','auth_required','cost_approval_required','sample_verified','ready']

@dataclass(frozen=True)
class SourceCapability:
    key: str
    modality: Literal['sentinel2','sentinel1','weather']
    availability: Availability
    parcel_ingestion_ready: bool
    limitations: tuple[str,...]

class ObservationAdapter(Protocol):
    capability: SourceCapability
    def normalize_local_record(self,record:dict) -> ObservationCreate:
        """Read already obtained data; must not silently send parcel geometry out.

        Preserve native resolution, observed_at, processing version, license,
        temporal support and missing-value mask. Never replace null with zero.
        """
        ...

SOURCE_CAPABILITIES=(
    SourceCapability('earthsearch-sentinel2-c1-l2a','sentinel2','sample_verified',False,('Only one arbitrary public 320m window tested, not a known oilseed-rape parcel.','Mainland deployment connectivity untested.','Read each asset scale/offset; enforce SCL/nodata quality before aggregation.')),
    SourceCapability('nasa-power-daily','weather','sample_verified',False,('Coarse 0.5° × 0.625° reanalysis grid, not a field station or forecast.','Keep UTC-day support and provider fill-value semantics.')),
    SourceCapability('sentinel1-cdse','sentinel1','auth_required',False,('Catalogue verified; unsigned asset read returned 401.','Authentication/access approval is separate from this local prototype.')),
    SourceCapability('sentinel1-pc-rtc','sentinel1','auth_required',False,('Catalogue verified; unsigned asset read returned 409.','10m spacing is not 10m native resolution; preserve orbit/polarization.')),
    SourceCapability('sentinel1-earthsearch','sentinel1','cost_approval_required',False,('Requester Pays asset access was not attempted.','GRD amplitude is not RTC gamma0.')),
)
