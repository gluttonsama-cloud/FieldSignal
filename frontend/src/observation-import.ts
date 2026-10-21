// File parsing is a convenience boundary, not independent source verification.
// Keep the original record intact; the API owns full schema and parcel checks.
type JsonObject = Record<string, unknown>;
export interface ObservationBundle {
  schema_version: 1;
  bundle_id: string;
  scope: 'parcel';
  bundle_sha256: string;
  processing_version: string;
  observations: JsonObject[];
  limitations: string[];
}
export type ObservationInput = { kind: 'single'; record: JsonObject } | { kind: 'bundle'; bundle: ObservationBundle };
const object = (value: unknown): value is JsonObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const digest = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const nonempty = (value: unknown) => typeof value === 'string' && Boolean(value.trim()) && value.length <= 200;
const unit = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : '未提供，待核验';

function rejectPublic(record: JsonObject) {
  const provenance = object(record.provenance) ? record.provenance : {};
  const support = object(provenance.spatial_support) ? provenance.spatial_support : {};
  const quality = object(record.quality) ? record.quality : {};
  if (record.data_origin === 'public_sample' || provenance.usage_scope === 'public_sample' || support.kind === 'public_window' || (Array.isArray(quality.flags) && quality.flags.includes('no_crop_truth'))) {
    throw new Error('公开样本不能导入用户地块。请在「数据接入」查看独立公开样本。');
  }
}

export function parseObservationInput(raw: string): ObservationInput {
  const value: unknown = JSON.parse(raw);
  if (!object(value)) throw new Error('请提供单条观测 JSON 对象，或本地规范化脚本的输出文件。');
  if (!('observations' in value || 'schema_version' in value || 'scope' in value)) {
    rejectPublic(value);
    return { kind: 'single', record: value };
  }
  if (value.scope === 'public_sample') throw new Error('公开样本不能导入用户地块。请在「数据接入」查看独立公开样本。');
  if (value.schema_version !== 1 || value.scope !== 'parcel' || !nonempty(value.bundle_id) || !digest(value.bundle_sha256) || !nonempty(value.processing_version) || !Array.isArray(value.observations) || !Array.isArray(value.limitations) || !value.limitations.every(item => typeof item === 'string')) {
    throw new Error('规范化文件结构不完整：需要版本 1、parcel 范围、批次摘要、处理版本和 observations 数组。');
  }
  if (!value.observations.length) throw new Error('规范化文件没有可选择的观测；请检查原始数据及处理限制，不会生成空记录。');
  let geometry: unknown;
  for (const record of value.observations) {
    if (!object(record)) throw new Error('规范化文件中的每条观测都必须是 JSON 对象。');
    rejectPublic(record);
    if (!object(record.provenance) || record.provenance.usage_scope !== 'parcel' || !digest(record.provenance.parcel_geometry_sha256)) {
      throw new Error('规范化文件中的每条观测都须保留 parcel 范围与地块边界摘要，不能自动补写。');
    }
    const p=record.provenance,q=record.quality;
    if (p.processing_version !== value.processing_version || (geometry !== undefined && p.parcel_geometry_sha256 !== geometry)) {
      throw new Error('规范化文件的处理版本或地块边界摘要不一致，请重新生成，不会自动修正。');
    }
    geometry=p.parcel_geometry_sha256;
    if (!nonempty(record.source) || !nonempty(record.observed_at) || !nonempty(record.source_record_id) || !object(record.features) || !Object.values(record.features).every(item => item === null || typeof item === 'number' && Number.isFinite(item)) || !object(q) || typeof q.usable !== 'boolean' || !unit(q.valid_fraction) || q.cloud_fraction !== undefined && !unit(q.cloud_fraction) || !Array.isArray(q.flags) || !q.flags.every(item => typeof item === 'string') || !nonempty(p.provider) || !nonempty(p.collection) || !nonempty(p.item_id)) {
      throw new Error('规范化观测的来源、时间、特征或质量结构不完整；请重新生成文件。');
    }
  }
  return { kind: 'bundle', bundle: value as unknown as ObservationBundle };
}

export function observationImportSummary(record: JsonObject): string {
  const p = object(record.provenance) ? record.provenance : {};
  const q = object(record.quality) ? record.quality : {};
  const support = object(p.spatial_support) ? p.spatial_support : {};
  const valid = typeof q.valid_fraction === 'number' && Number.isFinite(q.valid_fraction) ? `${(q.valid_fraction * 100).toFixed(1)}%` : '未知';
  return [
    `来源：${text(record.source)} · ${text(p.provider)} / ${text(p.collection)}`,
    `来源记录：${text(record.source_record_id)}`,
    `观测时间（保留原时区）：${text(record.observed_at)}`,
    `获取时间（保留原时区）：${text(p.retrieved_at)}`,
    `指标（原始字段与数值，未补零）：${object(record.features) ? JSON.stringify(record.features) : '未提供'}`,
    `时间支持：${text(p.temporal_support)}`,
    `质量声明：${q.usable === true ? '可用' : q.usable === false ? '受限' : '未知'} · ${record.source === 'weather' ? '有效参数比例' : ['parcel','public_window'].includes(String(support.kind)) ? '有效像元比例' : '声明有效比例'} ${valid}`,
    `云比例声明：${unit(q.cloud_fraction) ? `${(Number(q.cloud_fraction)*100).toFixed(1)}%（范围与口径见原始 JSON）` : '未知或不适用'}`,
    `质量标记：${Array.isArray(q.flags) && q.flags.length ? q.flags.map(text).join('、') : '未提供'}`,
    `范围声明：${text(p.usage_scope)} · 空间支持 ${text(support.kind)}`,
    `地块边界 SHA-256：${text(p.parcel_geometry_sha256)}`,
    `地块掩膜 SHA-256：${text(p.parcel_mask_sha256)}`,
    '以上为文件声明，未独立核验；提交时由本地服务校验当前地块绑定与生长季。',
  ].join('\n');
}
