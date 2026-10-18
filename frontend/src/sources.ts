import { api } from './api.ts';
import { badge, empty, esc, sources as sourceNames } from './display.ts';
import type { Observation, Provenance, SampleObservation, SourceCatalog, SourceImport, SourceImportResult, SpatialSupport } from './types';

export interface SourceState { catalog?: SourceCatalog; loading: boolean; importing: boolean; error: string; message: string }
type Request = <T>(path: string, options?: RequestInit) => Promise<T>;

// Separate from parcel state: loading this page cannot create records or affect counts.
export function createSourceController(changed: () => void, request: Request = api) {
  const state: SourceState = { loading: false, importing: false, error: '', message: '' };
  let busy = false;
  const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。';
  async function readCatalog() {
    state.loading = true; state.catalog = undefined; state.error = ''; changed();
    try { state.catalog = await request<SourceCatalog>('/sources'); }
    catch (error) { state.error = `数据源状态读取失败：${errorText(error)}`; }
    finally { state.loading = false; }
  }
  return {
    state,
    async refresh() {
      if (busy) return;
      busy = true; state.message = '';
      try { await readCatalog(); }
      finally { busy = false; changed(); }
    },
    async importSample() {
      if (busy || !state.catalog?.public_sample.available) return;
      const sampleId = state.catalog.public_sample.sample_id;
      busy = true; state.importing = true; state.error = ''; state.message = ''; changed();
      try {
        const result = await request<SourceImportResult>('/source-imports/public-sample', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sample_id: sampleId }) });
        // Treat a mismatched response as unconfirmed; a manual retry remains safe.
        if (typeof result?.created !== 'boolean' || !result.import?.id || result.import.sample_id !== sampleId || result.import.scope !== 'public_sample' || result.import.status !== 'completed') throw new Error('服务未返回匹配的公开样本导入确认。');
        state.message = result.created ? '公开样本已导入本地样本库，未创建地块。' : '该版本公开样本已经导入，已复用原记录，没有重复创建。';
        await readCatalog();
        if (state.error) state.error = `导入已确认，但列表刷新失败。请刷新数据源记录。${state.error}`;
      } catch (error) {
        state.catalog = undefined;
        state.error = `导入结果未确认：${errorText(error)} 服务端可能已保存，请先刷新记录；再次手动导入同一版本不会重复创建。`;
      } finally { busy = false; state.importing = false; changed(); }
    }
  };
}

export function utcTime(value?: string | null) {
  if (!value) return '未提供';
  const date = new Date(value);
  return Number.isNaN(+date) ? '时间无效，待核验' : `${date.toISOString().replace('T', ' ').replace('.000Z', '').replace('Z', '')} UTC`;
}
export function safeSourceLink(uri?: string, label = '打开原始来源') {
  if (!uri) return '未提供来源链接';
  try {
    const url = new URL(uri);
    if (url.protocol !== 'https:' || url.username || url.password) return '来源链接未显示：仅允许无凭据的 HTTPS 地址';
    return `<a class="text-link" href="${esc(url.href)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${esc(label)} ↗</a>`;
  } catch { return '来源链接无效，待核验'; }
}
const valueOrUnknown = (value: unknown) => value == null || value === '' ? '未提供，待核验' : esc(value);
const percent = (value?: number) => Number.isFinite(value) ? `${(value! * 100).toFixed(1)}%` : '未提供，待核验';
const limitations = (items: string[]) => items.length ? `<ul class="source-limitations">${items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : '<p class="caption">未声明限制，不表示没有限制。</p>';

export function spatialSupport(support?: SpatialSupport, resolution?: number) {
  if (!support) return resolution == null ? '未提供空间支持，待核验' : `声明分辨率 ${esc(resolution)} m；空间覆盖未提供，待核验`;
  const kind = { public_window: '公开任意方窗', coarse_grid: '粗网格上下文', parcel: '声明为地块支持（未独立核验）', unknown: '空间支持未知' }[support.kind] || '空间支持未知';
  const parts = [kind];
  if (support.pixel_size_m != null) parts.push(`B04/B08 像元 ${support.pixel_size_m} m`);
  if (support.scl_pixel_size_m != null) parts.push(`SCL 像元 ${support.scl_pixel_size_m} m`);
  if (support.grid_degrees) parts.push(`纬向 ${support.grid_degrees.latitude}° × 经向 ${support.grid_degrees.longitude}°`);
  if (support.crs) parts.push(support.crs);
  if (support.bounds) parts.push(`范围 [${support.bounds.join(', ')}]`);
  if (support.total_pixels != null) parts.push(`有效 / 总像元 ${support.valid_pixels ?? '未知'} / ${support.total_pixels}`);
  return esc(parts.join(' · '));
}
export function provenanceDetails(provenance: Provenance) {
  const hashes = provenance.asset_checksums ? Object.entries(provenance.asset_checksums) : [];
  const usageScope = provenance.usage_scope === 'public_sample' ? '公开样本，非用户地块' : provenance.usage_scope === 'parcel' ? '声明为地块观测，需核对空间支持与边界' : '未核验（unverified）';
  const temporal = { instantaneous: '瞬时采集（instantaneous）', daily_utc: 'UTC 日（daily_utc）', daily_local_solar: '当地太阳时日（daily_local_solar）', daily_beijing: '北京时间日（daily_beijing）' }[provenance.temporal_support || ''] || provenance.temporal_support;
  return `<dl><dt>提供方 / 集合</dt><dd>${valueOrUnknown(provenance.provider)} / ${valueOrUnknown(provenance.collection)}</dd><dt>来源项目</dt><dd>${valueOrUnknown(provenance.item_id)}</dd><dt>处理版本</dt><dd>${valueOrUnknown(provenance.processing_version)}</dd><dt>来源获取时间</dt><dd>${esc(utcTime(provenance.retrieved_at))}</dd><dt>空间支持</dt><dd>${spatialSupport(provenance.spatial_support, provenance.spatial_resolution_m)}</dd><dt>时间支持</dt><dd>${valueOrUnknown(temporal)}</dd><dt>声明使用范围</dt><dd>${esc(usageScope)}</dd><dt>地块边界 SHA-256</dt><dd>${provenance.usage_scope === 'public_sample' ? '不适用，未关联用户地块' : valueOrUnknown(provenance.parcel_geometry_sha256)}</dd><dt>支持范围说明</dt><dd>${valueOrUnknown(provenance.support_note)}</dd><dt>来源链接</dt><dd>${safeSourceLink(provenance.source_uri)}</dd></dl><details class="source-evidence"><summary>许可、署名与资产校验和</summary><dl><dt>许可 / 署名</dt><dd>${valueOrUnknown(provenance.license)}</dd>${hashes.length ? hashes.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('') : '<dt>资产校验和</dt><dd>未提供，待核验</dd>'}</dl></details>`;
}
export function qualityDetails(o: Pick<Observation, 'quality'> & Partial<Pick<Observation, 'source' | 'provenance'>>) {
  const knownWindow = ['public_window', 'parcel'].includes(o.provenance?.spatial_support?.kind || '');
  const sclCloud = o.source === 'sentinel2' && knownWindow && o.quality.flags?.includes('scl45_only');
  const validLabel = o.source === 'weather' ? '有效参数比例' : knownWindow ? '有效像元比例' : '声明有效比例';
  const cloudLabel = sclCloud ? '范围内云比例' : '声明云比例';
  const cloudDetail = o.source === 'weather' && o.quality.cloud_fraction == null ? '气象参数记录不适用' : `${percent(o.quality.cloud_fraction)}${sclCloud ? '（SCL 8/9/10，不是 1 − 有效比例）' : '（空间范围与口径待核验，不与整景云量混用）'}`;
  return `<dl><dt>来源声明可用</dt><dd>${o.quality.usable === true ? '是' : o.quality.usable === false ? '否' : '未提供，待核验'}</dd><dt>${validLabel}</dt><dd>${percent(o.quality.valid_fraction)}</dd><dt>${cloudLabel}</dt><dd>${cloudDetail}</dd><dt>质量标记</dt><dd>${esc(o.quality.flags?.join('；') || '无额外标记，不表示已核验')}</dd></dl>`;
}

export function featureDetails(features: Record<string, number | null>, temporalSupport?: string) {
  const definitions: Record<string, [string, string]> = { ndvi: ['NDVI', '无量纲'], ndre: ['NDRE', '无量纲'], evi: ['EVI', '无量纲'], ndwi: ['NDWI', '无量纲'], vv_db: ['VV', 'dB'], vh_db: ['VH', 'dB'], temperature_min_c: ['最低气温', '°C'], temperature_max_c: ['最高气温', '°C'], precipitation_mm: ['降水', temporalSupport?.toLowerCase().includes('day') || temporalSupport?.toLowerCase().includes('daily') ? 'mm/day' : 'mm（时间支持待核验）'] };
  const entries = Object.entries(features);
  return entries.length ? `<dl>${entries.map(([key, value]) => { const [title, unit] = definitions[key] || [key, '单位未声明']; return `<dt>${esc(title)}</dt><dd>${value == null || !Number.isFinite(value) ? '缺失，未补零' : `${esc(value)} ${esc(unit)}`}</dd>`; }).join('')}</dl>` : '<p class="caption">未提供观测特征</p>';
}
function sampleObservation(o: SampleObservation) {
  return `<details class="observation sample-observation"><summary><span>${esc(utcTime(o.observed_at))}</span><span>${esc(sourceNames[o.source] || o.source)}</span>${badge(o.data_status)}<span class="subtle">展开 ＋</span></summary><div class="observation-detail"><div><h4>观测与溯源</h4><dl><dt>观测编号</dt><dd>${esc(o.id)}</dd><dt>来源记录</dt><dd>${esc(o.source_record_id)}</dd><dt>原始观测时间</dt><dd>${esc(utcTime(o.observed_at))}</dd><dt>本地入库时间</dt><dd>${esc(utcTime(o.ingested_at))}</dd><dt>记录类型</dt><dd>公开样本，不关联用户地块</dd></dl>${provenanceDetails(o.provenance)}</div><div><h4>指标与单位</h4>${featureDetails(o.features, o.provenance.temporal_support)}<h4 class="source-subheading">质量说明</h4>${qualityDetails(o)}<p class="caption">来源质量与时效分别判断。质量合格的历史观测仍可能过期。</p></div></div></details>`;
}
function importRecord(record: SourceImport) {
  return `<article class="source-import"><div class="card-head"><div><h3>已导入公开样本</h3><p class="caption">${esc(record.id)}</p></div><span class="badge reported">本地导入完成</span></div><div class="source-body"><div class="source-tags"><span class="badge public-sample">公开样本 · 非农户地块</span>${badge(record.analysis_status)}</div><p class="caption">本次包含 ${record.observations.filter(o => o.source === 'sentinel2').length} 条光学观测与 ${record.observations.filter(o => o.source === 'weather').length} 条气象记录；公开样本不满足地块时序异常分析条件，不能生成巡田任务。</p><dl><dt>本地导入时间</dt><dd>${esc(utcTime(record.imported_at))}</dd><dt>记录创建时间</dt><dd>${esc(utcTime(record.created_at))}</dd><dt>样本编号</dt><dd>${esc(record.sample_id)}</dd></dl><details class="source-evidence"><summary>处理版本、样本包 SHA-256 与限制</summary><dl><dt>处理版本</dt><dd>${esc(record.processing_version)}</dd><dt>样本包 SHA-256</dt><dd>${esc(record.bundle_sha256)}</dd></dl>${limitations(record.limitations)}</details></div>${record.observations.length ? record.observations.map(sampleObservation).join('') : empty('导入记录尚无观测', '请刷新核对本地导入结果；空记录不代表有效数据。')}</article>`;
}
const capabilityNames: Record<string, string> = { 'earthsearch-sentinel2-c1-l2a': 'Earth Search · Sentinel-2 C1 L2A', 'nasa-power-daily': 'NASA POWER 逐日气象', 'sentinel1-cdse': 'CDSE · Sentinel-1', 'sentinel1-pc-rtc': 'Planetary Computer · S1 RTC', 'sentinel1-earthsearch': 'Earth Search · S1 GRD', sentinel2: 'Sentinel-2 光学', sentinel2_earth_search: 'Earth Search · Sentinel-2', earth_search_sentinel2: 'Earth Search · Sentinel-2', nasa_power: 'NASA POWER 气象', weather: 'NASA POWER 气象', sentinel1: 'Sentinel-1 雷达', sentinel1_cdse: 'CDSE · Sentinel-1', sentinel1_rtc: 'Planetary Computer · S1 RTC', sentinel1_grd: 'Earth Search · S1 GRD', gscloud_gf1: 'GSCloud · GF-1', cma_cldas: 'CMA · CLDAS' };
const availabilityNames: Record<string, string> = { catalog_only: '仅目录可读 · 未接通资产', ready: '声明能力已就绪，非实时在线检测', public_sample_only: '仅已验证公开样本', sample_available: '已有本地公开样本', sample_verified: '公开样本已验证', available: '有已记录的来源能力', auth_required: '需要账户授权 · 未接通', cost_approval_required: '需要费用批准 · 未接通', authorization_required: '需要授权 · 未接通', not_connected: '未接通', unverified: '资产 / 权利待验证', not_implemented: '尚未实现', unavailable: '当前不可用' };

export function renderSources(state: SourceState) {
  const disabled = state.loading || state.importing ? 'disabled' : '';
  const top = `<div class="source-intro notice">公开数据验证、真实地块观测和开发模拟数据分别保存。此页只导入随工程提供的历史公开样本包，不发起外网下载，不发送用户地块位置或照片。</div><div class="section-tools"><h2>数据源与公开样本</h2><button class="button secondary" data-action="refresh-sources" ${disabled}>${state.loading ? '正在读取…' : '刷新接入记录'}</button></div>${state.message ? `<div class="notice" role="status">${esc(state.message)}</div>` : ''}${state.error ? `<div class="notice danger" role="alert">${esc(state.error)} 旧状态已隐藏。</div>` : ''}`;
  if (state.loading) return `${top}<section class="card" aria-busy="true">${empty('正在读取数据源', '只读取本地记录，不会自动导入。')}</section>`;
  const catalog = state.catalog;
  if (!catalog) return `${top}<section class="card">${empty('尚未读取到接入记录', '请刷新本地数据源状态；未读取不等于没有已导入样本。')}</section>`;
  const sample = catalog.public_sample;
  const existing = catalog.imports.some(item => item.sample_id === sample.sample_id && item.bundle_sha256 === sample.bundle_sha256);
  return `${top}<section class="card source-catalog"><div class="card-head"><h3>能力清单</h3><span class="subtle">本地记录 · 非实时在线检测</span></div><div class="source-capabilities">${catalog.capabilities.length ? catalog.capabilities.map(capability => `<article><h3>${esc(capabilityNames[capability.key] || capability.key)}</h3><div class="source-tags"><span class="badge warning">${esc(availabilityNames[capability.availability] || capability.availability)}</span><span class="badge">${capability.parcel_ingestion_ready ? '声明支持地块接入，需核对范围' : '尚未接入真实地块'}</span></div><p class="caption">来源标识：${esc(capability.key)} · ${esc(capability.modality)}</p>${limitations(capability.limitations)}</article>`).join('') : empty('暂无来源能力记录', '没有记录不能推断来源已在线或已接通。')}</div></section><section class="card below"><div class="card-head"><div><h3>${esc(sample.title)}</h3><p class="caption">公开任意${sample.window_size_m == null ? '方窗（尺度待核验）' : ` ${esc(sample.window_size_m)} m 方窗`} · 历史样本</p></div><span class="badge public-sample">公开样本</span></div><div class="source-body"><div class="notice warning">沙洋附近任意公开方窗，不是已知油菜田，也不是你的地块。没有作物类别真值；NDVI 仅验证读取、缩放、掩膜与计算，不能据此判断农情或灾害。</div><div class="source-sample-grid"><dl><dt>光学原始采集</dt><dd>${esc(utcTime(sample.acquired_at))}</dd><dt>证据获取时间</dt><dd>${esc(utcTime(sample.retrieved_at))}</dd><dt>本地导入时间</dt><dd>点击导入后记录，详见下方导入记录</dd><dt>公开中心坐标</dt><dd>${sample.center_wgs84.length === 2 ? `${esc(sample.center_wgs84.join(', '))} · WGS84 经度、纬度` : '未提供，待核验'}</dd><dt>样本规模</dt><dd>${esc(sample.optical_observation_count)} 条光学 + ${esc(sample.weather_observation_count)} 条气象，共 ${esc(sample.expected_observation_count)} 条</dd></dl><div><h4>空间与时间支持</h4><p>S2 B04/B08 为 10 m，SCL 为 20 m；最近邻对齐不会增加空间信息。整景云量不等于方窗有效比例。</p><p>POWER 为 0.5° × 0.625° 粗网格，按 UTC 日统计；气温为 °C、降水为 mm/day。它是回溯气象上下文，不是地块测站或未来预报。</p></div></div><details class="source-evidence"><summary>样本包校验和与使用限制</summary><dl><dt>样本编号</dt><dd>${esc(sample.sample_id)}</dd><dt>样本包 SHA-256</dt><dd>${esc(sample.bundle_sha256)}</dd></dl>${limitations(sample.limitations)}</details><div class="source-import-action"><button class="button primary" data-action="import-public-sample" ${!sample.available || disabled ? 'disabled' : ''}>${state.importing ? '正在导入并核对…' : existing ? '重新核对公开样本（幂等）' : '导入公开样本到本地'}</button><p class="caption">${sample.available ? '只在点击后导入；同一版本重复导入复用原记录，不创建重复观测。' : '本地样本包不可用，暂不能导入。'} 真实地块观测请在「地块总览」选中地块后导入。</p></div></div></section><section class="card below"><div class="card-head"><h3>公开样本导入记录</h3><span class="subtle">${catalog.imports.length} 次独立导入 · 不计入用户地块</span></div>${catalog.imports.length ? catalog.imports.map(importRecord).join('') : empty('尚未导入公开样本', '能力验证不等于已入库。使用上方按钮可将公开历史样本保存到独立样本库。')}</section>`;
}
