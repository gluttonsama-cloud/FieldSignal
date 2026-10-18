#!/usr/bin/env python3
"""Normalize lawfully obtained local files only; no network and no database write."""
import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'backend'))
from app.adapters.local_bundle import LocalObservationBundleAdapter, BundleError, PROCESSING_VERSION, geometry_sha256

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--manifest',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
parser.add_argument('--parcel-geometry',type=Path,help='GeoJSON Polygon for verifying the parcel geometry binding')
args=parser.parse_args()
try:
    adapter=LocalObservationBundleAdapter(args.manifest)
    if adapter.manifest.scope=='parcel':
        if not args.parcel_geometry or geometry_sha256(json.loads(args.parcel_geometry.read_text()))!=adapter.manifest.parcel_geometry_sha256:
            raise BundleError('Parcel input must match --parcel-geometry SHA-256 binding')
    observations,warnings=adapter.normalize()
    if args.output.resolve().is_relative_to(adapter.root):
        raise BundleError('Output must be outside the input bundle directory to preserve input evidence')
    result={'schema_version':1,'bundle_id':adapter.manifest.bundle_id,'scope':adapter.manifest.scope,'bundle_sha256':adapter.bundle_sha256,'processing_version':PROCESSING_VERSION,'observations':[o.model_dump(mode='json',exclude_none=True) for o in observations],'limitations':warnings}
    with args.output.open('x') as stream: json.dump(result,stream,ensure_ascii=False,indent=2)
    print(f'Wrote {len(observations)} normalized observations to {args.output}; no database import or network call.')
except (BundleError,OSError,ValueError) as exc:
    parser.exit(1,f'Normalization refused: {exc}\n')
