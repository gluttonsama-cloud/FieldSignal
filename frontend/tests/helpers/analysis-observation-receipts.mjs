// Synthetic local contract fixtures, never real observations or production data.
export const syntheticObservationPayload = (recordId = 'synthetic-observation') => ({
  observed_at: '2026-10-18T04:05:06.123456Z', source: 'sentinel2', source_record_id: recordId,
  features: { ndvi: 0.4, ndre: null }, quality: { usable: true, valid_fraction: 0.8, cloud_fraction: 0.1 },
  provenance: { provider: 'synthetic', collection: 'synthetic-s2', item_id: recordId, processing_version: 'test-v1',
    usage_scope: 'parcel', parcel_geometry_sha256: 'a'.repeat(64), parcel_mask_sha256: 'b'.repeat(64),
    asset_checksums: { mask: 'b'.repeat(64) }, spatial_support: { kind: 'parcel', crs: 'EPSG:4326', bounds: [112, 30, 112.001, 30.001] } },
});
export function syntheticObservationReceipt(payload, parcelId = 'parcel-synthetic') {
  const content = structuredClone(payload);
  content.features = Object.fromEntries(Object.entries(content.features).filter(([, value]) => value !== null));
  content.quality.flags ??= [];
  content.provenance.temporal_support ??= 'instantaneous';
  content.provenance.usage_scope ??= 'unverified';
  content.provenance.asset_checksums ??= {};
  return { id: `observation-${payload.source_record_id}`, parcel_id: parcelId, ...content, data_origin: 'user',
    created_at: '2026-10-18T05:00:00.654321Z', ingested_at: '2026-10-18T05:00:00.654320Z' };
}
export function syntheticAnalysisReceipt(parcel = { id: 'parcel-synthetic', data_origin: 'user' }, method = 'statistical', outcome = 'not_flagged') {
  const fixture = parcel.data_origin === 'fixture';
  return { id: 'analysis-synthetic', parcel_id: parcel.id, method, data_origin: parcel.data_origin,
    model_version: 'synthetic-v1', created_at: '2026-10-18T06:00:00.123456Z', evaluated_at: '2026-10-18T06:00:00.123450Z',
    status: fixture ? outcome : ['insufficient_data', 'stale'].includes(outcome) ? 'blocked' : 'preview_only',
    mode: fixture ? 'fixture_demo' : 'preview', qualification_status: fixture ? 'fixture_demo' : 'declared_only',
    monitoring_eligible: false, qualification_reasons: ['Synthetic declaration, not independently verified.'],
    preview_status: fixture ? null : outcome, preview_evidence: !fixture && outcome === 'candidate' ? { metric: 'ndvi', latest_value: 0.2 } : null,
    risk_id: fixture && outcome === 'candidate' ? 'risk-synthetic' : null,
    observation_count: outcome === 'insufficient_data' ? 0 : 21, message: 'Synthetic preview, not a diagnosis or a production event.' };
}
