import type { Analysis, Dashboard, FarmEvent, Health, Observation, Risk, Verification, Visit } from './types';

type JsonObject = Record<string, unknown>;
type CoreRead = [Health, Dashboard, Risk[], Visit[], Verification[]];

// These are read/render boundaries, not the API's domain validators. Never
// repair a response, discard rows, infer missing values, or acknowledge a write.
function invalid(read: string, path: string, expected: string): never {
  throw new Error(`${read}读取失败：响应结构无效，${path} 应为${expected}。请重试读取；未将异常响应当作空记录。`);
}
function object(value: unknown, read: string, path: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(read, path, '对象');
  return value as JsonObject;
}
function array(value: unknown, read: string, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(read, path, '数组');
  return value;
}
function string(value: unknown, read: string, path: string) {
  if (typeof value !== 'string') invalid(read, path, '字符串');
}
function optionalStrings(row: JsonObject, keys: readonly string[], read: string, path: string) {
  for (const key of keys) if (row[key] != null) string(row[key], read, `${path}.${key}`);
}
function optionalNumber(row: JsonObject, key: string, read: string, path: string) {
  const value = row[key];
  if (value != null && (typeof value !== 'number' || !Number.isFinite(value))) invalid(read, `${path}.${key}`, '有限数值');
}
function optionalBoolean(row: JsonObject, key: string, read: string, path: string) {
  if (row[key] != null && typeof row[key] !== 'boolean') invalid(read, `${path}.${key}`, '布尔值');
}
function strings(value: unknown, read: string, path: string) {
  const items = array(value, read, path);
  for (let index = 0; index < items.length; index++) string(items[index], read, `${path}[${index}]`);
}
function rows(value: unknown, read: string, path: string, check: (row: JsonObject, path: string) => void) {
  const items = array(value, read, path);
  for (let index = 0; index < items.length; index++) {
    const rowPath = `${path}[${index}]`;
    check(object(items[index], read, rowPath), rowPath);
  }
}
function identity(row: JsonObject, read: string, path: string, parcelId?: string) {
  string(row.id, read, `${path}.id`);
  string(row.parcel_id, read, `${path}.parcel_id`);
  if (parcelId !== undefined && row.parcel_id !== parcelId) invalid(read, `${path}.parcel_id`, '本次请求的地块编号');
}
function parcel(row: JsonObject, path: string) {
  const read = '地块总览';
  string(row.id, read, `${path}.id`);
  optionalStrings(row, ['name', 'region', 'crop', 'season', 'sowing_date', 'cultivar', 'data_origin', 'created_at',
    'latest_observed_at', 'boundary_source', 'boundary_reference', 'boundary_crs', 'area_method', 'data_status',
    'latest_optical_observed_at', 'latest_weather_observed_at', 'optical_data_status', 'weather_data_status',
    'monitoring_status', 'qualification_status'], read, path);
  for (const key of ['area_ha', 'observation_count', 'open_risk_count', 'review_required_count']) optionalNumber(row, key, read, path);
  optionalBoolean(row, 'monitoring_eligible', read, path);
  if (row.geometry === undefined) return;
  const geometry = object(row.geometry, read, `${path}.geometry`);
  optionalStrings(geometry, ['type'], read, `${path}.geometry`);
  const coordinates = array(geometry.coordinates, read, `${path}.geometry.coordinates`);
  for (let ringIndex = 0; ringIndex < coordinates.length; ringIndex++) {
    const ringPath = `${path}.geometry.coordinates[${ringIndex}]`;
    const ring = array(coordinates[ringIndex], read, ringPath);
    for (let index = 0; index < ring.length; index++) {
      const pointPath = `${ringPath}[${index}]`, point = array(ring[index], read, pointPath);
      if (point.length < 2) invalid(read, pointPath, '至少含两个有限数值的坐标数组');
      for (let dimension = 0; dimension < point.length; dimension++) {
        if (typeof point[dimension] !== 'number' || !Number.isFinite(point[dimension])) invalid(read, `${pointPath}[${dimension}]`, '有限数值');
      }
    }
  }
}
function verification(row: JsonObject, path: string, read = '核查记录') {
  identity(row, read, path);
  string(row.visit_id, read, `${path}.visit_id`);
  strings(row.photo_ids, read, `${path}.photo_ids`);
  optionalStrings(row, ['observed_at', 'label', 'note', 'client_submission_id', 'created_at',
    'disposition', 'risk_id', 'source_verification_id', 'label_source'], read, path);
}

/** Validate the whole snapshot before the caller publishes any of its parts. */
export function validateCoreRead(raw: readonly unknown[]): CoreRead {
  if (!Array.isArray(raw) || raw.length !== 5) invalid('工作台', 'core', '五项读取结果数组');
  const health = object(raw[0], '服务状态', 'health');
  for (const key of ['status', 'version']) if (health[key] !== undefined) string(health[key], '服务状态', `health.${key}`);
  if (health.demo_enabled !== undefined && typeof health.demo_enabled !== 'boolean') invalid('服务状态', 'health.demo_enabled', '布尔值');
  const dashboard = object(raw[1], '地块总览', 'dashboard');
  for (const key of ['parcel_count', 'open_risk_count', 'pending_visit_count', 'verification_count']) {
    const value = dashboard[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid('地块总览', `dashboard.${key}`, '非负安全整数');
  }
  optionalNumber(dashboard, 'review_required_count', '地块总览', 'dashboard');
  rows(dashboard.parcels, '地块总览', 'dashboard.parcels', parcel);
  if (dashboard.recent_verifications !== undefined) {
    rows(dashboard.recent_verifications, '地块总览', 'dashboard.recent_verifications', (row, path) => verification(row, path, '地块总览'));
  }
  rows(raw[2], '候选记录', 'risks', (row, path) => {
    identity(row, '候选记录', path);
    object(row.evidence, '候选记录', `${path}.evidence`);
    optionalStrings(row, ['observation_id', 'status', 'priority', 'summary', 'method', 'model_version', 'created_at',
      'disposition', 'legacy_status', 'mode'], '候选记录', path);
    optionalBoolean(row, 'monitoring_eligible', '候选记录', path);
  });
  rows(raw[3], '巡田任务', 'visits', (row, path) => {
    identity(row, '巡田任务', path);
    // Old tasks may have no plan, assignee, source, or timestamp. Keep those
    // states intact; only present, non-null strings must be safe to sort/render.
    optionalStrings(row, ['risk_id', 'source_verification_id', 'status', 'due_date', 'assignee', 'note', 'created_at', 'plan_updated_at'], '巡田任务', path);
    optionalNumber(row, 'plan_revision', '巡田任务', path);
  });
  rows(raw[4], '核查记录', 'verifications', verification);
  return raw as CoreRead;
}

export function validateObservationRead(raw: unknown, parcelId?: string): Observation[] {
  const read = '观测记录';
  rows(raw, read, 'observations', (row, path) => {
    identity(row, read, path, parcelId);
    optionalStrings(row, ['observed_at', 'source', 'source_record_id', 'data_origin', 'created_at', 'ingested_at', 'data_status'], read, path);
    object(row.features, read, `${path}.features`);
    const quality = object(row.quality, read, `${path}.quality`);
    if (quality.usable != null && typeof quality.usable !== 'boolean') invalid(read, `${path}.quality.usable`, '布尔值');
    for (const key of ['valid_fraction', 'cloud_fraction']) optionalNumber(quality, key, read, `${path}.quality`);
    if (quality.flags !== undefined) strings(quality.flags, read, `${path}.quality.flags`);
    const provenance = object(row.provenance, read, `${path}.provenance`);
    optionalStrings(provenance, ['provider', 'collection', 'item_id', 'processing_version', 'license', 'source_uri',
      'retrieved_at', 'temporal_support', 'support_note', 'usage_scope', 'parcel_geometry_sha256', 'parcel_mask_sha256'], read, `${path}.provenance`);
    if (provenance.spatial_support != null) {
      const supportPath = `${path}.provenance.spatial_support`, support = object(provenance.spatial_support, read, supportPath);
      optionalStrings(support, ['kind', 'crs'], read, supportPath);
      if (support.bounds !== undefined) {
        const bounds = array(support.bounds, read, `${supportPath}.bounds`);
        for (let index = 0; index < bounds.length; index++) {
          if (typeof bounds[index] !== 'number' || !Number.isFinite(bounds[index])) invalid(read, `${supportPath}.bounds[${index}]`, '有限数值');
        }
      }
    }
  });
  return raw as Observation[];
}

export function validateAnalysisRead(raw: unknown, parcelId?: string): Analysis[] {
  rows(raw, '分析记录', 'analyses', (row, path) => {
    identity(row, '分析记录', path, parcelId);
    optionalStrings(row, ['method', 'evaluated_at', 'status', 'risk_id', 'message', 'mode',
      'qualification_status', 'preview_status'], '分析记录', path);
    optionalNumber(row, 'observation_count', '分析记录', path);
    optionalBoolean(row, 'monitoring_eligible', '分析记录', path);
    if (row.qualification_reasons != null) strings(row.qualification_reasons, '分析记录', `${path}.qualification_reasons`);
    if (row.preview_evidence != null) object(row.preview_evidence, '分析记录', `${path}.preview_evidence`);
  });
  return raw as Analysis[];
}

export function validateEventRead(raw: unknown, parcelId: string): FarmEvent[] {
  rows(raw, '农事记录', 'events', (row, path) => {
    identity(row, '农事记录', path, parcelId);
    string(row.occurred_on, '农事记录', `${path}.occurred_on`);
    optionalStrings(row, ['kind', 'note', 'created_at'], '农事记录', path);
  });
  return raw as FarmEvent[];
}
