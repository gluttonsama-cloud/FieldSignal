import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceController, renderSources, safeSourceLink, utcTime, spatialSupport, provenanceDetails, qualityDetails, featureDetails } from '../src/sources.ts';

const sampleId = 'shayang-public-window-20250428-v1';
const observation = (source = 'sentinel2') => ({
  id: `o-${source}`, source, source_record_id: `record-${source}`, observed_at: '2025-04-28T03:16:59Z', ingested_at: '2026-10-16T01:02:03Z',
  features: source === 'sentinel2' ? { ndvi: 0.42 } : { temperature_min_c: 12.3, temperature_max_c: 21.4, precipitation_mm: null },
  quality: { usable: true, valid_fraction: 0.8, cloud_fraction: 0.05, flags: ['public_sample_not_a_parcel'] },
  provenance: { provider: source === 'sentinel2' ? 'Element 84' : 'NASA POWER', collection: 'public-archive', item_id: 'item-1', processing_version: 'sample-v1', license: 'Contains modified Copernicus Sentinel data 2025', retrieved_at: '2026-10-15T00:00:00Z', source_uri: 'https://example.com/source?a=1&b=2', temporal_support: source === 'sentinel2' ? 'instantaneous' : 'daily_utc', asset_checksums: { b04: 'abc123' }, spatial_support: source === 'sentinel2' ? { kind: 'public_window', crs: 'EPSG:32649', pixel_size_m: 10, scl_pixel_size_m: 20, bounds: [1, 2, 3, 4], valid_pixels: 819, total_pixels: 1024 } : { kind: 'coarse_grid', grid_degrees: { latitude: 0.5, longitude: 0.625 } } },
  data_origin: 'public_sample', data_status: 'stale'
});
const imported = () => ({ id: 'import-1', sample_id: sampleId, scope: 'public_sample', status: 'completed', bundle_sha256: 'bundle-hash', processing_version: 'sample-v1', imported_at: '2026-10-16T01:02:03Z', created_at: '2026-10-16T01:02:03Z', observations: [observation(), observation('weather')], limitations: ['No crop ground truth'], analysis_status: 'insufficient_data' });
const catalog = (imports = []) => ({ capabilities: [{ key: 'sentinel2', modality: 'optical', availability: 'public_sample_only', parcel_ingestion_ready: false, limitations: ['历史样本不代表地块接通'] }, { key: 'sentinel1_cdse', modality: 'sar', availability: 'auth_required', parcel_ingestion_ready: false, limitations: ['No asset access'] }], public_sample: { sample_id: sampleId, title: '沙洋附近公开样本', acquired_at: '2025-04-28T03:16:59Z', retrieved_at: '2026-10-15T00:00:00Z', center_wgs84: [112.3, 30.7], window_size_m: 320, optical_observation_count: 1, weather_observation_count: 3, expected_observation_count: 4, limitations: ['Not a known rapeseed field'], bundle_sha256: 'bundle-hash', available: true }, imports });
const state = (overrides = {}) => ({ catalog: catalog(), loading: false, importing: false, error: '', message: '', ...overrides });

// Request mocks are injected, so these tests cannot contact an external source or write a parcel.
test('source controller performs no request at creation; refresh only GETs local sources', async () => {
  const calls = [];
  const controller = createSourceController(() => {}, async (path, options) => { calls.push([path, options]); return catalog(); });
  assert.equal(calls.length, 0);
  renderSources(controller.state);
  assert.equal(calls.length, 0);
  await controller.refresh();
  assert.deepEqual(calls, [['/sources', undefined]]);
  assert.deepEqual(controller.state.catalog.imports, []);
});

test('empty source page distinguishes no import, unavailable data, and separate real parcel workflow', () => {
  const html = renderSources(state());
  assert.match(html, /尚未导入公开样本/);
  assert.match(html, /不是已知油菜田，也不是你的地块/);
  assert.match(html, /真实地块观测请在「地块总览」/);
  assert.match(html, /320 m 方窗/);
  assert.match(html, /1 条光学 \+ 3 条气象，共 4 条/);
  assert.doesNotMatch(html, /data-action="(?:analyze|new-visit|confirm-fixtures|select-parcel)"/);
  const unavailable = catalog(); unavailable.public_sample.available = false;
  assert.match(renderSources(state({ catalog: unavailable })), /data-action="import-public-sample" disabled/);
  assert.match(renderSources(state({ catalog: unavailable })), /本地样本包不可用/);
});

test('sample evidence retains source acquisition, retrieval, import times and stale insufficient-data status', () => {
  const html = renderSources(state({ catalog: catalog([imported()]) }));
  for (const text of ['2025-04-28 03:16:59 UTC', '2026-10-15 00:00:00 UTC', '2026-10-16 01:02:03 UTC', '数据已过期', '数据不足', '不计入用户地块', '不能生成巡田任务', 'B04/B08 为 10 m，SCL 为 20 m', '0.5° × 0.625°', 'UTC 日', '°C', 'mm/day', '80.0%', 'Contains modified Copernicus Sentinel data 2025', 'abc123', 'bundle-hash', '重新核对公开样本（幂等）']) assert.ok(html.includes(text), text);
  assert.match(html, /<details class="source-evidence"><summary>许可、署名与资产校验和/);
  assert.doesNotMatch(html, /data-action="(?:analyze|new-visit|select-parcel)"/);
});

test('capability states never claim live external connectivity; unknown and empty remain explicit', () => {
  assert.match(renderSources(state()), /需要账户授权 · 未接通/);
  assert.match(renderSources(state()), /本地记录 · 非实时在线检测/);
  assert.match(renderSources(state()), /尚未接入真实地块/);
  const data = catalog(); data.capabilities = [];
  assert.match(renderSources(state({ catalog: data })), /暂无来源能力记录/);
  data.capabilities = [{ key: '<script>', modality: 'new', availability: 'unknown_state', parcel_ingestion_ready: false, limitations: [] }];
  const html = renderSources(state({ catalog: data }));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /unknown_state/);
  assert.doesNotMatch(html, /<script>/);
});

test('only safe HTTPS provenance links render and all labels/attributes are escaped', () => {
  for (const uri of ['javascript:alert(1)', 'data:text/html,hello', 'http://example.com', '//example.com', 'file:///tmp/local', 'https://name:password@example.com']) assert.doesNotMatch(safeSourceLink(uri), /<a /, uri);
  const html = safeSourceLink('https://example.com/?a=1&b=2', '<img onerror="x">');
  assert.match(html, /href="https:\/\/example.com\/\?a=1&amp;b=2"/);
  assert.match(html, /&lt;img onerror=&quot;x&quot;&gt;/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /referrerpolicy="no-referrer"/);
  assert.equal(safeSourceLink(), '未提供来源链接');
});

test('missing spatial/provenance/quality/units stay unknown, zero and missing are distinct', () => {
  assert.equal(utcTime(), '未提供');
  assert.equal(utcTime('not a date'), '时间无效，待核验');
  assert.equal(utcTime('2025-04-28T08:00:00+08:00'), '2025-04-28 00:00:00 UTC');
  assert.match(spatialSupport(), /未提供空间支持，待核验/);
  assert.match(spatialSupport(undefined, 10), /空间覆盖未提供，待核验/);
  assert.match(spatialSupport({ kind: 'coarse_grid', grid_degrees: { latitude: 0.5, longitude: 0.625 } }), /纬向 0.5° × 经向 0.625°/);
  assert.match(provenanceDetails({ provider: '', collection: '', item_id: '', processing_version: '' }), /未提供，待核验/);
  assert.match(qualityDetails({ quality: { flags: [] } }), /未提供，待核验/);
  assert.match(featureDetails({ precipitation_mm: 0 }, 'daily_utc'), />0 mm\/day</);
  assert.match(featureDetails({ precipitation_mm: null }, 'daily_utc'), /缺失，未补零/);
  assert.match(featureDetails({ arbitrary_metric: 12 }), /单位未声明/);
  assert.match(featureDetails({ precipitation_mm: 12 }), /时间支持待核验/);
});

test('explicit sample import refreshes list, repeated import reuses same record and never calls parcel API', async () => {
  const calls = []; let saved = false;
  const controller = createSourceController(() => {}, async (path, options) => {
    calls.push([path, options]);
    if (path === '/sources') return catalog(saved ? [imported()] : []);
    const result = { created: !saved, import: imported() }; saved = true; return result;
  });
  await controller.refresh(); await controller.importSample();
  assert.match(controller.state.message, /公开样本已导入本地样本库/);
  assert.equal(controller.state.catalog.imports.length, 1);
  await controller.importSample();
  assert.equal(controller.state.catalog.imports.length, 1);
  assert.match(controller.state.message, /复用原记录，没有重复创建/);
  const posts = calls.filter(([, options]) => options?.method === 'POST');
  assert.equal(posts.length, 2);
  assert.deepEqual(JSON.parse(posts[0][1].body), { sample_id: sampleId });
  assert.equal(posts[0][1].body, posts[1][1].body);
  assert.ok(calls.every(([path]) => ['/sources', '/source-imports/public-sample'].includes(path)));
});

test('single-flight import disables both actions, absorbs repeated clicks and overlapping refresh', async () => {
  let release; let posts = 0; let gets = 0;
  const controller = createSourceController(() => {}, async (path) => {
    if (path === '/sources') { gets++; return catalog(); }
    posts++; return new Promise(resolve => { release = () => resolve({ created: true, import: imported() }); });
  });
  await controller.refresh();
  const pending = controller.importSample();
  assert.equal(controller.state.importing, true);
  assert.match(renderSources(controller.state), /data-action="import-public-sample" disabled/);
  assert.match(renderSources(controller.state), /data-action="refresh-sources" disabled/);
  await controller.importSample(); await controller.refresh();
  assert.equal(posts, 1); assert.equal(gets, 1);
  release(); await pending;
  assert.equal(posts, 1); assert.equal(gets, 2); assert.equal(controller.state.importing, false);
});

test('refresh failure clears old imports and labels unavailable state instead of an empty success', async () => {
  let fail = false;
  const controller = createSourceController(() => {}, async () => { if (fail) throw new Error('connection lost'); return catalog([imported()]); });
  await controller.refresh(); fail = true; await controller.refresh();
  assert.equal(controller.state.catalog, undefined);
  const html = renderSources(controller.state);
  assert.match(html, /读取失败：connection lost/);
  assert.match(html, /旧状态已隐藏/);
  assert.match(html, /未读取不等于没有已导入样本/);
  assert.doesNotMatch(html, /本地导入完成/);
});

test('ambiguous POST failure hides stale results and requires manual refresh before retry', async () => {
  let fail = true; let posts = 0;
  const controller = createSourceController(() => {}, async path => { if (path === '/sources') return catalog(); posts++; if (fail) throw new Error('response lost'); return { created: false, import: imported() }; });
  await controller.refresh(); await controller.importSample();
  assert.equal(controller.state.catalog, undefined);
  assert.match(controller.state.error, /服务端可能已保存/);
  assert.equal(controller.state.importing, false);
  await controller.importSample(); assert.equal(posts, 1);
  fail = false; await controller.refresh(); await controller.importSample();
  assert.equal(posts, 2); assert.match(controller.state.message, /复用原记录/);
});

test('confirmed import plus failed list refresh preserves confirmation but hides prior snapshot', async () => {
  let importedOnce = false;
  const controller = createSourceController(() => {}, async path => {
    if (path === '/sources') { if (importedOnce) throw new Error('read unavailable'); return catalog(); }
    importedOnce = true; return { created: true, import: imported() };
  });
  await controller.refresh(); await controller.importSample();
  assert.equal(controller.state.catalog, undefined);
  assert.match(controller.state.message, /已导入本地样本库/);
  assert.match(controller.state.error, /导入已确认，但列表刷新失败/);
});

test('mismatched import response never becomes a success notification', async () => {
  const controller = createSourceController(() => {}, async path => path === '/sources' ? catalog() : { created: true, import: { ...imported(), sample_id: 'other-sample' } });
  await controller.refresh(); await controller.importSample();
  assert.equal(controller.state.message, ''); assert.equal(controller.state.catalog, undefined);
  assert.match(controller.state.error, /未返回匹配的公开样本导入确认/);
});

test('full source rendering escapes all API text, including error, licenses and hashes', () => {
  const data = catalog([imported()]);
  data.public_sample.title = '<img onerror="attack">';
  data.imports[0].observations[0].provenance.license = '<script>attack</script>';
  data.imports[0].bundle_sha256 = '" onmouseover="attack';
  const html = renderSources(state({ catalog: data, error: '<svg onload="attack">' }));
  assert.doesNotMatch(html, /<(?:img|svg|script)/);
  assert.match(html, /&lt;script&gt;attack&lt;\/script&gt;/);
  assert.match(html, /&quot; onmouseover=&quot;attack/);
  assert.match(html, /&lt;svg onload=&quot;attack&quot;&gt;/);
});

test('unavailable bundle accepts backend null dates and empty coordinates without claiming acquisition metadata', () => {
  const data = catalog();
  Object.assign(data.public_sample, { available: false, acquired_at: null, retrieved_at: null, center_wgs84: [], expected_observation_count: 0, optical_observation_count: 0, weather_observation_count: 0 });
  const html = renderSources(state({ catalog: data }));
  assert.match(html, /光学原始采集<\/dt><dd>未提供/);
  assert.match(html, /公开中心坐标<\/dt><dd>未提供，待核验/);
  assert.match(html, /data-action="import-public-sample" disabled/);
});

test('manual provenance is explicitly unverified and temporal definitions are not relabeled UTC', () => {
  const base = { provider: 'manual', collection: 'user records', item_id: 'u1', processing_version: 'v1' };
  assert.match(provenanceDetails(base), /未核验（unverified）/);
  assert.match(provenanceDetails({ ...base, temporal_support: 'daily_local_solar' }), /当地太阳时日（daily_local_solar）/);
  assert.match(provenanceDetails({ ...base, temporal_support: 'daily_beijing' }), /北京时间日（daily_beijing）/);
  assert.match(provenanceDetails({ ...base, usage_scope: 'public_sample' }), /不适用，未关联用户地块/);
});

test('normalized S2 cloud fraction is scoped to the window and is not confused with scene cloud or invalid pixels', () => {
  const o = observation();
  o.quality = { usable: true, valid_fraction: 0.98828125, cloud_fraction: 0, flags: ['scl45_only'] };
  const html = qualityDetails(o);
  assert.match(html, /有效像元比例<\/dt><dd>98\.8%/);
  assert.match(html, /范围内云比例<\/dt><dd>0\.0%（SCL 8\/9\/10，不是 1 − 有效比例）/);
  assert.doesNotMatch(html, /整景云量<\/dt>/);
  const weather = observation('weather'); delete weather.quality.cloud_fraction;
  assert.match(qualityDetails(weather), /有效参数比例/);
  assert.match(qualityDetails(weather), /气象参数记录不适用/);
});
