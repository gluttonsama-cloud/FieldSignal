import type { Parcel, Verification } from './types.ts';

export interface RecordFilters {
  query: string;
  label: string;
  from: string;
  to: string;
  parcelId: string;
}

export const defaultRecordFilters = (): RecordFilters => ({ query: '', label: '', from: '', to: '', parcelId: '' });

function calendarDay(value: string): boolean {
  if (value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

export function recordFilterError(filters: RecordFilters): string | undefined {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters) ||
    !['query', 'label', 'from', 'to', 'parcelId'].every(key => typeof filters[key as keyof RecordFilters] === 'string')) {
    return '筛选条件格式无效，请清除后重试。';
  }
  // HTML maxlength counts UTF-16 code units, including surrounding whitespace.
  if (filters.query.length > 200) return '关键词不能超过 200 个字符，请缩短后重试。';
  if (filters.from && !calendarDay(filters.from)) return '观察日期起始日无效，请输入有效日期。';
  if (filters.to && !calendarDay(filters.to)) return '观察日期结束日无效，请输入有效日期。';
  if (filters.from && filters.to && filters.from > filters.to) return '观察日期起始日不能晚于结束日。';
}

export function recordFiltersActive(filters: RecordFilters): boolean {
  if (recordFilterError(filters)) return true;
  return Boolean(filters.query.trim() || filters.label || filters.from || filters.to || filters.parcelId);
}

function observedLocalDay(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  // Accept aware ISO spellings used by API receipts, including UTC microseconds.
  // Validate components before constructing the instant: Date.parse can silently
  // roll impossible dates forward. Never interpret a naive timestamp as local.
  const parts = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(Z|[+-](\d{2})(?::?(\d{2}))?)$/i);
  if (!parts || parts[0] !== value || !calendarDay(parts[1])) return;
  const hour = Number(parts[2]), minute = Number(parts[3]), second = Number(parts[4] || 0);
  const zoneHour = Number(parts[7] || 0), zoneMinute = Number(parts[8] || 0);
  if (hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59) return;
  const [year, month, day] = parts[1].split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  // Truncate, never round sub-millisecond precision into the following day.
  date.setUTCHours(hour, minute, second, Number((parts[5] || '').slice(0, 3).padEnd(3, '0')));
  const offset = (zoneHour * 60 + zoneMinute) * (parts[6][0] === '-' ? -1 : 1);
  date.setTime(date.getTime() - offset * 60_000);
  const localYear = date.getFullYear();
  if (!Number.isFinite(date.getTime()) || localYear < 1 || localYear > 9999) return;
  return `${String(localYear).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function filterVerifications(
  records: readonly Verification[],
  parcels: readonly Parcel[],
  filters: RecordFilters,
): Verification[] {
  if (recordFilterError(filters)) return [];
  const query = filters.query.trim().toLowerCase();
  const parcelById = new Map<string, Parcel>();
  for (const parcel of parcels) if (!parcelById.has(parcel.id)) parcelById.set(parcel.id, parcel);
  // Preserve the caller's existing ordering and record identities, including
  // backfilled reports. Saved/created time never participates in this selector.
  return records.filter(record => {
    if (filters.parcelId && record.parcel_id !== filters.parcelId) return false;
    if (filters.label && record.label !== filters.label) return false;
    if (filters.from || filters.to) {
      const day = observedLocalDay(record.observed_at);
      if (!day || (filters.from && day < filters.from) || (filters.to && day > filters.to)) return false;
    }
    if (!query) return true;
    const parcel = parcelById.get(record.parcel_id);
    return [record.note, parcel?.name, parcel?.season, record.parcel_id, record.visit_id, record.id]
      .some(value => typeof value === 'string' && value.toLowerCase().includes(query));
  });
}

/** Plain text for status/CSV use. HTML callers must escape the returned text. */
export function recordFilterDescription(
  filters: RecordFilters,
  labels: Record<string, string>,
  parcels: readonly Parcel[],
): string {
  const error = recordFilterError(filters);
  if (error) return `筛选无效：${error}`;
  const parts: string[] = [];
  const query = filters.query.trim();
  if (query) parts.push(`关键词：${query}（字面包含，不区分大小写）`);
  if (filters.label) {
    const label = Object.hasOwn(labels, filters.label) ? `${labels[filters.label]}（${filters.label}）` : filters.label;
    parts.push(`现场判断：${label}（精确匹配）`);
  }
  if (filters.from || filters.to) {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '本机设置';
    parts.push(`观察日期：${filters.from || '不限'} 至 ${filters.to || '不限'}（本机时区 ${zone}，含起止日）`);
  }
  if (filters.parcelId) {
    const parcel = parcels.find(item => item.id === filters.parcelId);
    const name = parcel ? `${parcel.name} · ${parcel.season} · 地块 ID：${filters.parcelId}` : `地块 ID：${filters.parcelId}（档案未读取）`;
    parts.push(`地块：${name}（精确匹配）`);
  }
  return parts.join('；') || '无附加筛选';
}
