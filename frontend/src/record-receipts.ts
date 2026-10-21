import type { FarmEvent, Parcel, Verification, Visit } from './types.ts';

export interface ParcelReceiptPayload {
  name: string;
  region?: string;
  crop?: string;
  season: string;
  geometry: Parcel['geometry'];
  sowing_date?: string | null;
  cultivar?: string | null;
  boundary_source?: string;
  boundary_reference?: string | null;
}
export interface VisitReceiptPayload {
  parcel_id: string;
  risk_id?: string | null;
  due_date: string;
  assignee?: string | null;
  note?: string | null;
}
export interface VisitPlanReceiptPayload {
  expected_revision: number;
  due_date: string;
  assignee?: string | null;
}
export interface FollowUpVisitReceiptPayload {
  due_date: string;
  assignee?: string | null;
  note?: string | null;
}
export interface FarmEventReceiptPayload { occurred_on: string; kind: string; note: string }
export interface VerificationReceiptPayload {
  client_submission_id: string;
  observed_at: string;
  label: string;
  note: string;
  photo_ids: string[];
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
// Pydantic's str_strip_whitespace uses Rust/Unicode White_Space, not JS trim:
// it strips U+0085 but preserves U+FEFF and controls such as U+001C–U+001F.
const normalizedText = (value: string): string => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
const identifier = (value: unknown): value is string => typeof value === 'string' && normalizedText(value).length > 0 && value === normalizedText(value);
const text = (value: unknown, max: number, required = false): value is string =>
  typeof value === 'string' && [...value].length <= max && (!required || normalizedText(value).length > 0);
function requireReceipt(valid: unknown): asserts valid {
  // A malformed 2xx result is uncertain, not an API rejection: callers must keep
  // the form and its original idempotency key available for a manual retry.
  if (!valid) throw new Error('服务回执与本次提交不一致，保存结果尚未确认。请保留原表单并原样重试核对。');
}

function calendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

// Accept compatible ISO timezone spellings, but do not let Date.parse silently
// roll February 30 into March or discard significant fractional-second digits.
function instant(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const parts = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(Z|[+-](\d{2})(?::?(\d{2}))?)$/i);
  if (!parts || !calendarDate(parts[1])) return;
  const hour = Number(parts[2]), minute = Number(parts[3]), second = Number(parts[4] || 0);
  const zoneHour = Number(parts[7] || 0), zoneMinute = Number(parts[8] || 0);
  if (hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59) return;
  const [year, month, day] = parts[1].split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  const offset = (zoneHour * 60 + zoneMinute) * (parts[6][0] === '-' ? -1 : 1);
  return `${date.getTime() / 1000 - offset * 60}:${(parts[5] || '').replace(/0+$/, '')}`;
}

function baseReceipt(raw: unknown): JsonObject {
  requireReceipt(object(raw) && identifier(raw.id) && instant(raw.created_at) !== undefined);
  return raw;
}

function submittedText(actual: unknown, expected: string, max: number, required = true) {
  requireReceipt(text(actual, max, required) && typeof expected === 'string' && actual === normalizedText(expected));
}

function optionalText(actual: unknown, expected: string | null | undefined, max: number) {
  // Missing and null both mean absent. An explicitly submitted empty string is
  // not absent: the backend preserves it after stripping surrounding whitespace.
  if (expected == null) requireReceipt(actual == null);
  else submittedText(actual, expected, max, false);
}

function immutableOptionalText(actual: unknown, original: unknown, max: number, isId = false) {
  if (original == null) requireReceipt(actual == null);
  else requireReceipt(text(actual, max) && actual === original && (!isId || identifier(actual)));
}

function submittedDate(actual: unknown, expected: string) {
  // Pydantic date fields, unlike string fields, do not strip whitespace.
  requireReceipt(calendarDate(actual) && actual === expected);
}

function optionalOrigin(receipt: JsonObject) {
  // Visit/FarmEvent's public contracts do not require data_origin on legacy
  // records, but a present value must not introduce an unknown provenance.
  if ('data_origin' in receipt) requireReceipt(receipt.data_origin === 'user' || receipt.data_origin === 'fixture');
}

function polygon(value: unknown): value is Parcel['geometry'] {
  if (!object(value) || value.type !== 'Polygon' || !Array.isArray(value.coordinates) || value.coordinates.length !== 1) return false;
  const ring: unknown = value.coordinates[0];
  if (!Array.isArray(ring) || ring.length < 4 || ring.length > 1000) return false;
  if (!ring.every(point => Array.isArray(point) && point.length === 2 &&
    point.every(n => typeof n === 'number' && Number.isFinite(n)) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 85)) return false;
  return ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1];
}

/** Confirm the actual submitted boundary, not JSON property order or a guessed area. */
export function validateParcelReceipt(raw: unknown, payload: ParcelReceiptPayload): Parcel {
  const receipt = baseReceipt(raw);
  submittedText(receipt.name, payload.name, 80);
  // Literal enums also compare exactly in the backend; they are not stripped.
  requireReceipt(receipt.region === (payload.region ?? 'shayang') && ['shayang', 'luotian', 'other'].includes(receipt.region as string));
  requireReceipt(receipt.crop === (payload.crop ?? 'oilseed_rape') && receipt.crop === 'oilseed_rape');
  submittedText(receipt.season, payload.season, 9);
  requireReceipt(/^20\d{2}-20\d{2}$/.test(receipt.season as string) &&
    Number((receipt.season as string).slice(5)) === Number((receipt.season as string).slice(0, 4)) + 1);
  optionalText(receipt.sowing_date, payload.sowing_date, 10);
  if (receipt.sowing_date != null) requireReceipt(calendarDate(receipt.sowing_date));
  optionalText(receipt.cultivar, payload.cultivar, 100);
  requireReceipt(receipt.boundary_source === (payload.boundary_source ?? 'user_provided') &&
    ['user_provided', 'user_survey', 'public_dataset'].includes(receipt.boundary_source as string));
  optionalText(receipt.boundary_reference, payload.boundary_reference, 500);
  requireReceipt(receipt.data_origin === 'user' && receipt.boundary_crs === 'EPSG:4326' &&
    receipt.area_method === 'local_equirectangular_estimate_not_survey' &&
    typeof receipt.area_ha === 'number' && Number.isFinite(receipt.area_ha) && receipt.area_ha > 0);
  requireReceipt(polygon(receipt.geometry) && polygon(payload.geometry));
  const actual = receipt.geometry.coordinates[0], expected = payload.geometry.coordinates[0];
  // Exact finite number equality also treats JSON 112 and 112.0 (and ±0) as
  // equal without an epsilon that could hide a changed boundary.
  requireReceipt(actual.length === expected.length &&
    actual.every((point, index) => point[0] === expected[index][0] && point[1] === expected[index][1]));
  return receipt as unknown as Parcel;
}

/** A create replay is the original pending snapshot, not the latest task state. */
function visitReceipt(raw: unknown, payload: VisitReceiptPayload): Visit {
  const receipt = baseReceipt(raw);
  requireReceipt(identifier(receipt.parcel_id) && receipt.parcel_id === normalizedText(payload.parcel_id) && receipt.status === 'pending');
  optionalText(receipt.risk_id, payload.risk_id, 200);
  if (receipt.risk_id != null) requireReceipt(identifier(receipt.risk_id));
  submittedDate(receipt.due_date, payload.due_date);
  optionalText(receipt.assignee, payload.assignee, 100);
  optionalText(receipt.note, payload.note, 2000);
  // Old creation receipts predate plan_revision; only an absent field means 0.
  requireReceipt(!('plan_revision' in receipt) || receipt.plan_revision === 0);
  if ('plan_updated_at' in receipt) requireReceipt(instant(receipt.plan_updated_at) !== undefined);
  optionalOrigin(receipt);
  return receipt as unknown as Visit;
}

export function validateVisitReceipt(raw: unknown, payload: VisitReceiptPayload): Visit {
  const receipt = visitReceipt(raw, payload);
  // Ordinary/candidate creation must never acquire an unrelated source report.
  requireReceipt(receipt.source_verification_id == null);
  return receipt;
}

export function validateFollowUpVisitReceipt(
  raw: unknown,
  source: { id: string; parcel_id: string },
  payload: FollowUpVisitReceiptPayload,
): Visit {
  requireReceipt(identifier(source.id) && identifier(source.parcel_id));
  const receipt = visitReceipt(raw, { ...payload, parcel_id: source.parcel_id, risk_id: null });
  requireReceipt(identifier(receipt.source_verification_id) && receipt.source_verification_id === source.id);
  return receipt;
}

/** Bind an edit to the immutable task snapshot captured when its form opened. */
export function validateVisitPlanReceipt(
  raw: unknown,
  original: Pick<Visit, 'id' | 'parcel_id' | 'risk_id' | 'source_verification_id' | 'note' | 'created_at'>,
  payload: VisitPlanReceiptPayload,
): Visit {
  const receipt = baseReceipt(raw);
  requireReceipt(receipt.id === original.id && identifier(receipt.parcel_id) && receipt.parcel_id === original.parcel_id &&
    receipt.status === 'pending' && instant(receipt.created_at) === instant(original.created_at));
  immutableOptionalText(receipt.risk_id, original.risk_id, 200, true);
  immutableOptionalText(receipt.source_verification_id, original.source_verification_id, 200, true);
  immutableOptionalText(receipt.note, original.note, 2000);
  submittedDate(receipt.due_date, payload.due_date);
  optionalText(receipt.assignee, payload.assignee, 100);
  requireReceipt(Number.isSafeInteger(payload.expected_revision) && payload.expected_revision >= 0 &&
    Number.isSafeInteger(receipt.plan_revision) && receipt.plan_revision === payload.expected_revision + 1 &&
    instant(receipt.plan_updated_at) !== undefined);
  optionalOrigin(receipt);
  return receipt as unknown as Visit;
}

export function validateFarmEventReceipt(raw: unknown, parcelId: string, payload: FarmEventReceiptPayload): FarmEvent {
  const receipt = baseReceipt(raw);
  requireReceipt(identifier(receipt.parcel_id) && receipt.parcel_id === parcelId);
  submittedDate(receipt.occurred_on, payload.occurred_on);
  requireReceipt(receipt.kind === payload.kind && ['sowing', 'fertilizing', 'spraying', 'drainage', 'other'].includes(receipt.kind as string));
  submittedText(receipt.note, payload.note, 2000);
  optionalOrigin(receipt);
  return receipt as unknown as FarmEvent;
}

function draftReceipt<T>(validate: () => T): T {
  try { return validate(); }
  catch {
    // Keep malformed successful responses distinct from API rejections. The
    // caller must retain the durable draft and its original submission key.
    throw new Error('服务回执与本次提交不一致，保存结果尚未确认。草稿已保留，请使用相同内容手动重试核对。');
  }
}

function submittedMicrosecondInstant(value: unknown): string | undefined {
  const parsed = instant(value);
  if (parsed === undefined) return;
  // Pydantic truncates submitted fractions beyond six digits, then persists a
  // UTC datetime. Never let Date.parse discard a meaningful microsecond.
  const [seconds, fraction] = parsed.split(':');
  return `${seconds}:${fraction.slice(0, 6).replace(/0+$/, '')}`;
}

/** Confirm the complete immutable submission before clearing its durable draft. */
export function validateVerificationReceipt(
  raw: unknown,
  original: { visit_id: string; parcel_id: string; data_origin?: 'user' | 'fixture' },
  payload: VerificationReceiptPayload,
): Verification {
  return draftReceipt(() => {
    const receipt = baseReceipt(raw);
    requireReceipt(identifier(original.visit_id) && identifier(original.parcel_id) &&
      receipt.visit_id === original.visit_id && receipt.parcel_id === original.parcel_id);
    submittedText(receipt.client_submission_id, payload.client_submission_id, 100);
    requireReceipt([...(receipt.client_submission_id as string)].length >= 8);
    const observed = instant(receipt.observed_at), submitted = submittedMicrosecondInstant(payload.observed_at);
    requireReceipt(observed !== undefined && submitted !== undefined && observed === submitted);
    requireReceipt(receipt.label === payload.label &&
      ['normal', 'waterlogging', 'frost', 'disease_suspected', 'other', 'uncertain'].includes(receipt.label as string));
    submittedText(receipt.note, payload.note, 2000);
    requireReceipt(Array.isArray(receipt.photo_ids) && Array.isArray(payload.photo_ids) &&
      receipt.photo_ids.length === payload.photo_ids.length && receipt.photo_ids.length <= 8 &&
      new Set(receipt.photo_ids).size === receipt.photo_ids.length);
    for (let index = 0; index < receipt.photo_ids.length; index++) {
      submittedText(receipt.photo_ids[index], payload.photo_ids[index], 200);
      requireReceipt(identifier(receipt.photo_ids[index]));
    }
    optionalOrigin(receipt);
    requireReceipt(original.data_origin === undefined || original.data_origin === 'user' || original.data_origin === 'fixture');
    if ('data_origin' in receipt && original.data_origin !== undefined) requireReceipt(receipt.data_origin === original.data_origin);
    if ('label_source' in receipt) requireReceipt(receipt.label_source === 'field_report_unadjudicated');
    return receipt as unknown as Verification;
  });
}

/** Check upload metadata and visit binding, not byte identity: no hash is returned. */
export function validatePhotoReceipt(raw: unknown, visitId: string, dataOrigin?: 'user' | 'fixture'): { id: string } {
  return draftReceipt(() => {
    const receipt = baseReceipt(raw);
    requireReceipt(identifier(visitId) && receipt.visit_id === visitId &&
      receipt.content_type === 'image/jpeg' && Number.isSafeInteger(receipt.size_bytes) &&
      (receipt.size_bytes as number) > 0 && receipt.metadata_stripped === true &&
      (receipt.state === 'staged' || receipt.state === 'confirmed') &&
      (receipt.data_origin === 'user' || receipt.data_origin === 'fixture') &&
      (dataOrigin === undefined || receipt.data_origin === dataOrigin));
    return receipt as { id: string };
  });
}
