import './style.css';
import { api, post, ApiError } from './api';
import { parseObservationInput, observationImportSummary } from './observation-import';
import type { ObservationBundle } from './observation-import';
import { parseParcelGeometry, parcelGeometrySummary } from './parcel-geometry';
import { createSourceController, renderSources, provenanceDetails, qualityDetails, featureDetails, utcTime } from './sources';
import { DraftConflictError, listDrafts, saveDraft, removeDraft } from './drafts';
import { uploadVerificationDraft } from './sync';
import { regions, labels, kinds, sources, statuses, esc, fmtDate, fmtTime, today, localInput, fixture, badge, empty, boundaryMap, trend, usable } from './display';
import type { Parcel, Observation, Analysis, Risk, Visit, Verification, FarmEvent, Dashboard, Health, VerificationDraft } from './types';

const app = document.querySelector<HTMLDivElement>('#app')!;
const modal = document.querySelector<HTMLDialogElement>('#modal')!;
const isField = location.pathname.startsWith('/field');
let dashboard: Dashboard = { parcel_count: 0, open_risk_count: 0, pending_visit_count: 0, verification_count: 0, parcels: [], recent_verifications: [] };
let health: Health | undefined;
let risks: Risk[] = [], visits: Visit[] = [], verifications: Verification[] = [], observations: Observation[] = [], analyses: Analysis[] = [], events: FarmEvent[] = [];
let drafts: VerificationDraft[] = [];
let selectedId = '', region = 'all', adminTab = 'overview', fieldTab = 'visits';
let loading = true, connected = false, loadError = '', detailError = '', storageError = '', lastLoaded = '', detailToken = 0;
let eventsState: 'idle' | 'loading' | 'ready' | 'error' = 'idle', eventsError = '', eventsParcelId = '';
let currentDraft: VerificationDraft | undefined;
let storedDraftView: { draft: VerificationDraft; json: string; blobs: Blob[] } | undefined;
let saving: Promise<void> = Promise.resolve();
let submitting = false;
let draftRemoval: { draft: VerificationDraft; session: number; busy: boolean; blocked: boolean } | undefined;
let dialogSession = 0, refreshToken = 0, draftEpoch = 0, draftReadToken = 0;
let photoUrls: string[] = [];
const sourceController = createSourceController(render);
const selected = () => dashboard.parcels.find(p => p.id === selectedId);
const parcelFor = (id: string) => dashboard.parcels.find(p => p.id === id);
const shownParcels = () => dashboard.parcels.filter(p => region === 'all' || p.region === region);
const msg = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。';
const icon = (name: string) => ({ fields: '▧', visits: '◉', records: '≡', plus: '+', arrow: '↗', sources: '⇥' }[name] || '·');

// Request identities live only as long as this exact form. Reverting to an
// already attempted payload reuses its identity too, avoiding an A/B/A duplicate.
const recordRequests = new WeakMap<HTMLFormElement, Map<string, string>>();
function canonicalRecord(value: unknown): unknown {
  if(Array.isArray(value))return value.map(canonicalRecord);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonicalRecord(item)]));
  return value;
}
function postRecord<T>(form: HTMLFormElement, path: string, data: unknown) {
  const fingerprint=JSON.stringify([path,canonicalRecord(data)]);
  let requests=recordRequests.get(form);if(!requests){requests=new Map();recordRequests.set(form,requests);}
  let key=requests.get(fingerprint);if(!key){key=crypto.randomUUID();requests.set(fingerprint,key);}
  return post<T>(path,data,key);
}

const observationReads = new WeakMap<HTMLFormElement, object>();
const observationBundles = new WeakMap<HTMLFormElement, { bundle: ObservationBundle; selected?: number }>();
function clearObservationBundle(form: HTMLFormElement) {
  observationBundles.delete(form);
  const choices=form.querySelector<HTMLElement>('#observation-choices');if(choices){choices.hidden=true;choices.innerHTML='';}
}
function previewObservation(form: HTMLFormElement) {
  const preview=form.querySelector<HTMLElement>('#observation-preview');if(!preview)return;
  try { const parsed=parseObservationInput(form.querySelector<HTMLTextAreaElement>('textarea[name="json"]')!.value);preview.textContent=parsed.kind==='single'?observationImportSummary(parsed.record):'请从 JSON 文件读取规范化结果，再明确选择一条记录。'; }
  catch { preview.textContent='当前 JSON 尚不能预览，请检查内容后再提交。'; }
}
function selectObservation(input: HTMLSelectElement) {
  const form=input.closest<HTMLFormElement>('#observation-form');
  if(!form||form.dataset.submitting==='true'||!modal.contains(form)||!modal.open)return;
  const state=observationBundles.get(form);if(!state)return;
  const index=/^\d+$/.test(input.value)?Number(input.value):-1;
  state.selected=index>=0&&index<state.bundle.observations.length?index:undefined;
  const submit=form.querySelector<HTMLButtonElement>('[type="submit"]')!;submit.disabled=state.selected===undefined;
  if(state.selected===undefined){const preview=form.querySelector<HTMLElement>('#observation-preview');if(preview)preview.textContent='尚未选择记录，不能提交；下方 JSON 保留上次内容。';observationReadStatus(form,'请明确选择一条记录；尚未发送任何观测。');return;}
  form.querySelector<HTMLTextAreaElement>('textarea[name="json"]')!.value=JSON.stringify(state.bundle.observations[index],null,2);
  previewObservation(form);
  const error=modal.querySelector<HTMLElement>('.form-error');if(error)error.hidden=true;
  observationReadStatus(form,`已选择第 ${index+1} / ${state.bundle.observations.length} 条；仅在点击「校验并导入」时提交这一条。`);
}
function observationReadStatus(form: HTMLFormElement, text: string) {
  const status=form.querySelector<HTMLElement>('#observation-file-status');if(status)status.textContent=text;
}
function editObservationJson(input: HTMLInputElement|HTMLTextAreaElement) {
  const form=input.closest<HTMLFormElement>('#observation-form');
  if(input.name!=='json'||!form||form.dataset.submitting==='true')return;
  observationReads.delete(form);clearObservationBundle(form);previewObservation(form);
  const submit=form.querySelector<HTMLButtonElement>('[type="submit"]');if(submit)submit.disabled=false;
  observationReadStatus(form,'已改为手动输入，请核对后提交；先前文件读取不会覆盖当前内容。');
}
async function readObservationFile(input: HTMLInputElement) {
  const form=input.closest<HTMLFormElement>('#observation-form');
  if(!form||form.dataset.submitting==='true')return;
  const token={},session=dialogSession;observationReads.set(form,token);clearObservationBundle(form);
  const current=()=>modal.open&&session===dialogSession&&modal.contains(form)&&observationReads.get(form)===token;
  const submit=form.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const file=input.files?.[0];submit.disabled=Boolean(file);
  if(!file){observationReads.delete(form);observationReadStatus(form,'未选择文件，当前 JSON 保持不变。');return;}
  observationReadStatus(form,'正在读取所选文件，请稍候；手动编辑 JSON 可取消本次读取。');
  try {
    if(file.size>1024*1024)throw new Error('JSON 文件请小于 1 MB。');
    const text=await file.text();if(!current())return;
    const parsed=parseObservationInput(text);
    if(parsed.kind==='bundle'){
      const bundle=parsed.bundle;observationBundles.set(form,{bundle});
      const choices=form.querySelector<HTMLElement>('#observation-choices')!;choices.hidden=false;
      choices.innerHTML=`<label>选择一条观测（共 ${bundle.observations.length} 条）<select id="observation-record"><option value="">请选择，不会自动导入</option>${bundle.observations.map((record,index)=>`<option value="${index}">${index+1} · ${esc(record.source||'来源未知')} · ${esc(record.observed_at||'时间未知')} · ${esc(record.source_record_id||'记录未知')}</option>`).join('')}</select></label><p class="caption">批次 ${esc(bundle.bundle_id)} · 处理版本 ${esc(bundle.processing_version)}<br>原始 manifest SHA-256：${esc(bundle.bundle_sha256)}（文件声明，非本次重新计算）</p>${bundle.limitations.length?`<ul class="source-limitations">${bundle.limitations.map(item=>`<li>${esc(item)}</li>`).join('')}</ul>`:''}`;
      const preview=form.querySelector<HTMLElement>('#observation-preview');if(preview)preview.textContent='请先选择一条记录，再核对来源、时间、质量与地块绑定。';
      observationReadStatus(form,`已读取 ${file.name}，共 ${bundle.observations.length} 条。选择一条后可预览；本次只导入所选记录。`);
    }else{
      form.querySelector<HTMLTextAreaElement>('textarea[name="json"]')!.value=text;previewObservation(form);
      observationReadStatus(form,`已读取 ${file.name}，请核对来源与时间后提交。`);
    }
    const error=modal.querySelector<HTMLElement>('.form-error');if(error)error.hidden=true;
  } catch(error) {
    if(current()){observationReadStatus(form,'文件未读入，原有 JSON 已保留；请检查内容后再提交。');formError(error instanceof SyntaxError?'JSON 格式不正确，请检查文件内容。':msg(error));}
  } finally {
    if(observationReads.get(form)===token){observationReads.delete(form);submit.disabled=form.dataset.submitting==='true'||(observationBundles.has(form)&&observationBundles.get(form)!.selected===undefined);}
  }
}

function singleObservation(text: string) { const parsed=parseObservationInput(text);if(parsed.kind!=='single')throw new Error('请从 JSON 文件读取规范化结果，并明确选择一条观测。');return parsed.record; }

const parcelReads = new WeakMap<HTMLFormElement, object>();
function parcelFileStatus(form: HTMLFormElement, text: string) {
  const status=form.querySelector<HTMLElement>('#parcel-file-status');if(status)status.textContent=text;
}
function previewParcelGeometry(form: HTMLFormElement) {
  const preview=form.querySelector<HTMLElement>('#parcel-geometry-preview'),summary=form.querySelector<HTMLElement>('#parcel-geometry-summary');
  if(!preview||!summary)return;
  try {
    const geometry=parseParcelGeometry(form.querySelector<HTMLTextAreaElement>('textarea[name="geometry"]')!.value);
    preview.innerHTML=boundaryMap([{id:'preview',name:'待保存边界',geometry}],'preview');
    summary.textContent=parcelGeometrySummary(geometry);
  } catch { preview.innerHTML='';summary.textContent='边界尚不能预览，请检查 JSON。保存地块前会继续校验。'; }
}
function editParcelGeometry(input: HTMLInputElement|HTMLTextAreaElement) {
  const form=input.closest<HTMLFormElement>('#parcel-form');
  if(input.name!=='geometry'||!form||form.dataset.submitting==='true')return;
  parcelReads.delete(form);previewParcelGeometry(form);
  const submit=form.querySelector<HTMLButtonElement>('[type="submit"]');if(submit)submit.disabled=false;
  parcelFileStatus(form,'已改为手动输入，之前文件读取不会覆盖当前边界。');
}
async function readParcelFile(input: HTMLInputElement) {
  const form=input.closest<HTMLFormElement>('#parcel-form');if(!form||form.dataset.submitting==='true')return;
  const token={},session=dialogSession;parcelReads.set(form,token);
  const current=()=>modal.open&&session===dialogSession&&modal.contains(form)&&parcelReads.get(form)===token;
  const submit=form.querySelector<HTMLButtonElement>('[type="submit"]')!,file=input.files?.[0];submit.disabled=Boolean(file);
  input.value=''; // Allow choosing the same file again after an edit or read error.
  if(!file){parcelReads.delete(form);parcelFileStatus(form,'未选择文件，当前边界保持不变。');return;}
  parcelFileStatus(form,'正在读取边界文件；完成后请核对预览，再保存地块。');
  try {
    if(file.size>1024*1024)throw new Error('边界 JSON 文件请小于 1 MB。');
    const raw=await file.text();if(!current())return;
    const geometry=parseParcelGeometry(raw);
    form.querySelector<HTMLTextAreaElement>('textarea[name="geometry"]')!.value=JSON.stringify(geometry,null,2);
    previewParcelGeometry(form);parcelFileStatus(form,`已读取 ${file.name}，仅取一块边界；名称、区域和种植季保持不变。尚未保存地块。`);
    const error=modal.querySelector<HTMLElement>('.form-error');if(error)error.hidden=true;
  } catch(error) {
    if(current()){parcelFileStatus(form,'边界文件未读入，原有输入已保留；请检查后重新选择。');formError(error instanceof SyntaxError?'JSON 格式不正确，请检查边界文件。':msg(error));}
  } finally { if(parcelReads.get(form)===token){parcelReads.delete(form);submit.disabled=form.dataset.submitting==='true';} }
}

function toast(text: string) { const element = document.querySelector<HTMLElement>('#toast')!; element.textContent = text; element.classList.add('visible'); setTimeout(() => element.classList.remove('visible'), 4800); }
function formError(text: string) { const el=modal.querySelector<HTMLElement>('.form-error'); if(el) { el.textContent=text; el.hidden=false; el.focus(); } else toast(text); }
function notice() {
  if(loading) return `<div class="notice">${isField?'正在读取本地服务数据，本机草稿可先继续填写。':'正在读取本地数据…'}</div>`;
  if(loadError) return `<div class="notice danger" role="alert">${esc(loadError)} ${lastLoaded ? '当前显示上次读取内容，请勿当作实时状态。' : '尚未读取到数据，统计暂不可用。'} <button data-action="refresh">重试连接</button></div>`;
  if(!navigator.onLine) return '<div class="notice warning">浏览器报告网络不可用。已打开页面的核查草稿可保存在本机；连接恢复后请手动重试提交。</div>';
  return '';
}
function headerStatus() { return `<span class="connection ${connected?'':'disconnected'}"><i></i>${connected?'本地服务已连接':'本地服务未连接'}</span>`; }
function render() {
  app.innerHTML = isField ? renderField() : renderAdmin();
  document.title = isField ? '田间助手 · FieldSignal' : adminTab === 'sources' ? '数据接入 · FieldSignal' : '地块监测 · FieldSignal';
}
function renderAdmin() {
  return `<div class="admin-shell"><aside class="sidebar"><a class="brand" href="/admin" aria-label="FieldSignal 管理端"><img src="/icon.svg" alt=""><span>FieldSignal<small>油菜监测工作台</small></span></a><div class="side-label">管理空间</div><nav aria-label="管理导航">${[['overview','fields','地块总览'],['risks','visits','待核查候选'],['records','records','田间记录'],['sources','sources','数据接入']].map(([id,i,title])=>`<button class="nav-item ${adminTab===id?'active':''}" data-action="admin-tab" data-tab="${id}" aria-label="${title}" ${adminTab===id?'aria-current="page"':''}><span>${icon(i)}</span>${title}${id==='risks'&&risks.filter(r=>r.status!=='verified').length?`<b>${risks.filter(r=>r.status!=='verified').length}</b>`:''}</button>`).join('')}</nav><div class="side-bottom"><span class="version">V0 · 本地原型</span><p>从观测变化到田间核查</p><a class="field-link" href="/field">打开田间助手 <span>↗</span></a><small>数据存储在本地服务。<br>未启用外部地图与遥测。</small></div></aside><main class="main"><header class="topbar"><span>工作台 <span class="crumb">/ ${adminTab==='overview'?'地块总览':adminTab==='risks'?'待核查候选':adminTab==='sources'?'数据接入':'田间记录'}</span></span><div>${headerStatus()}<button class="icon-button" data-action="refresh" aria-label="刷新数据" title="刷新">↻</button></div></header><div class="workspace">${notice()}<div class="page-heading"><div><div class="eyebrow">FIELD OBSERVATIONS</div><h1>${adminTab==='overview'?'油菜地块监测':adminTab==='risks'?'待核查候选':adminTab==='sources'?'数据接入':'田间核查记录'}</h1><p>${adminTab==='overview'?'查看观测质量与变化，安排有依据的田间核查。':adminTab==='risks'?'候选由统计变化产生，需要到田确认；不代表灾害诊断。':adminTab==='sources'?'查看来源能力、历史公开样本与可追溯的本地导入记录。':'田间反馈为人工报告，保留照片状态与原始备注。'}</p></div>${adminTab!=='sources'?'<button class="button primary" data-action="new-parcel">＋ 录入地块</button>':''}</div><section class="stats" aria-label="全局概览">${[['已录入地块',dashboard.parcel_count,'块','本地地块档案'],['待核查候选',dashboard.open_risk_count,'项','统计变化，待人工核实'],['待完成巡田',dashboard.pending_visit_count,'次','从候选到现场'],['已收集核查',dashboard.verification_count,'条','用户报告，非确诊']].map(([title,value,unit,foot],i)=>`<div class="stat"><div>${title}<span class="stat-index">0${i+1}</span></div><strong>${loadError&&!lastLoaded?'—':value}<small>${unit}</small></strong><p>${foot}</p></div>`).join('')}</section>${adminTab==='overview'?adminOverview():adminTab==='risks'?riskPanel():adminTab==='sources'?renderSources(sourceController.state):recordsPanel()}<footer class="footer"><span><i class="dot green"></i> 本地优先 · 保留来源与质量</span><span>无观测不推断；未触发候选不等于健康。${lastLoaded?` · 更新于 ${esc(fmtTime(lastLoaded))}`:''}</span></footer></div></main></div>`;
}
function adminOverview() {
  const list=shownParcels(), p=selected();
  return `<div class="section-tools"><h2>监测范围 <span>${list.length} 块地</span></h2><label class="inline-label">区域 <select id="region-filter" aria-label="按区域筛选"><option value="all">全部区域</option>${Object.entries(regions).map(([v,t])=>`<option value="${v}" ${region===v?'selected':''}>${t}</option>`).join('')}</select></label></div><div class="overview-grid"><section class="card map-card"><div class="card-head"><h3>地块空间分布</h3><span class="subtle">WGS84 · 边界示意</span></div><div class="map-surface">${boundaryMap(list,selectedId)}<div class="map-legend"><i></i> 地块边界 <i class="selected"></i> 当前地块</div></div><p class="map-attribution">地块边界示意，未加载外部底图 · 不用于测绘或精确空间分析</p></section><section class="card parcel-list-card"><div class="card-head"><h3>地块目录</h3><span class="subtle">${list.length} 块</span></div><div class="parcel-list">${list.length?list.map(p=>`<button class="parcel-row ${p.id===selectedId?'selected':''}" data-action="select-parcel" data-id="${esc(p.id)}"><span class="parcel-icon">▧</span><span><strong>${esc(p.name)}</strong><small>${regions[p.region]} · ${Number(p.area_ha).toFixed(2)} ha</small>${fixture(p)}${badge(p.data_status)}</span><span class="chevron">›</span></button>`).join(''):empty('从第一块田开始', '录入地块边界，再接入观测记录。','<button class="button secondary" data-action="new-parcel">录入地块</button>')}</div>${health?.demo_enabled?'<div class="fixture-loader"><button class="text-button" data-action="load-fixtures">加载开发模拟数据 ↗</button><small>仅用于验证流程，非真实农情</small></div>':''}</section></div>${p?parcelDetail(p):`<section class="card onboarding"><span class="step-number">01</span><div><h3>先建立地块档案</h3><p>支持粘贴 GeoJSON Polygon，建立区域、季节与作物档案。</p></div><span class="step-number muted">02</span><div><h3>接入有来源的观测</h3><p>质量不足或数据过期会明确提示，不生成新的异常候选。</p></div><span class="step-number muted">03</span><div><h3>到田核实并留痕</h3><p>将候选转为巡田任务，手机端保存草稿与照片。</p></div></section>`}`;
}
function parcelDetail(p: Parcel) {
  return `<section class="detail-heading"><div><div class="eyebrow">SELECTED PARCEL</div><h2>${esc(p.name)} ${fixture(p)}</h2><p>${regions[p.region]} · 油菜 · ${esc(p.season)} · ${Number(p.area_ha).toFixed(2)} ha（估算，非测绘） ${p.sowing_date?`· 播种 ${esc(fmtDate(p.sowing_date))}`:''}</p><p>边界来源：${esc(p.boundary_source==='synthetic_fixture'?'开发模拟边界':p.boundary_source==='user_survey'?'用户测绘':p.boundary_source==='public_dataset'?'公开数据集':'用户提供')} · ${esc(p.boundary_crs||'EPSG:4326')}${p.boundary_reference?` · ${esc(p.boundary_reference)}`:''}</p></div><div class="button-group"><button class="button secondary" data-action="new-routine-visit">安排自主巡田</button><button class="button secondary" data-action="import-observation" ${p.data_origin==='fixture'?'disabled title="模拟地块不接收真实观测"':''}>导入真实地块观测</button><button class="button primary" data-action="analyze">运行统计分析</button></div></section>${detailError?`<div class="notice danger" role="alert">${esc(detailError)}</div>`:''}<div class="detail-grid"><section class="card"><div class="card-head"><h3>植被指数变化 <span class="subtle">NDVI</span></h3>${badge(p.data_status)}</div><div class="chart-wrap">${trend(observations)}</div></section><section class="card"><div class="card-head"><h3>分析与核查</h3><span class="subtle">统计基线 V0</span></div><div class="analysis-body">${analyses.length?`<div class="analysis-status">${badge(analyses[0].status)}<small>${esc(fmtTime(analyses[0].evaluated_at))}</small></div><p>${esc(analyses[0].message)}</p><small>参与观测 ${analyses[0].observation_count} 条 · ${esc(analyses[0].method)}</small>`:empty('尚未分析', '可用观测达到条件后，执行统计变化筛查。')}<div class="guardrail">统计异常仅是巡田线索，不自动判定灾害类型或损失。</div>${risks.filter(r=>r.parcel_id===p.id&&r.status!=='verified').map(r=>riskCard(r,true)).join('')}</div></section></div><section class="card observation-card"><div class="card-head"><h3>观测记录与来源</h3><span class="subtle">${observations.length} 条 · 点击展开</span></div>${observations.length?`<div class="observation-list">${observations.slice().reverse().map(observationRow).join('')}</div>`:empty('待接入数据', '真实地块尚未接入；可导入经处理的本地观测，公开样本请在数据接入页查看。')}</section>`;
}
function observationRow(o: Observation) { return `<details class="observation"><summary><span class="observation-date">${esc(fmtDate(o.observed_at))}</span><span>${esc(sources[o.source]||o.source)}</span><span class="observation-ndvi">NDVI <b>${esc(o.features.ndvi??'—')}</b></span><span class="badge ${usable(o)?'available':'quality_limited'}">${usable(o)?'声明质量达标':'质量受限'}</span><span class="subtle">展开 ＋</span></summary><div class="observation-detail"><div><dl><dt>观测编号</dt><dd>${esc(o.id)}</dd><dt>原始观测时间</dt><dd>${esc(utcTime(o.observed_at))}</dd><dt>本地入库时间</dt><dd>${esc(utcTime(o.ingested_at||o.created_at))}</dd><dt>来源记录</dt><dd>${esc(o.source_record_id)}</dd></dl>${provenanceDetails(o.provenance)}</div><div><h4>观测特征与单位</h4>${featureDetails(o.features,o.provenance.temporal_support)}<h4 class="source-subheading">质量声明</h4>${qualityDetails(o)}<p class="caption">${o.data_origin==='fixture'?'开发模拟记录，不代表真实农情。':'来源与质量由提交记录声明，尚未独立核验；缺失信息明确保留为未知。'}</p>${o.data_origin==='fixture'?'<span class="badge fixture">开发模拟数据</span>':''}</div></div></details>`; }

function riskCard(r: Risk, compact = false) { const p=parcelFor(r.parcel_id); return `<article class="risk-card ${compact?'compact':''}"><div class="risk-top"><span class="badge ${r.priority==='high'?'high':'warning'}">${r.priority==='high'?'优先核查':'待核查'}</span>${fixture(p)}<small>${esc(fmtDate(r.created_at))}</small></div>${!compact?`<h3>${esc(p?.name||r.parcel_id)}</h3>`:''}<p>${esc(r.summary)}</p><details><summary>查看统计依据</summary><dl><dt>指标 / 观测值</dt><dd>${esc(r.evidence.metric)} / ${esc(r.evidence.latest_value)}</dd><dt>基线中位数 / 样本</dt><dd>${esc(r.evidence.baseline_median)} / ${esc(r.evidence.baseline_count)} 条</dd><dt>观测编号</dt><dd>${esc(r.observation_id)}</dd><dt>模型版本</dt><dd>${esc(r.model_version)}</dd><dt>限制</dt><dd>${esc(Array.isArray(r.evidence.limitations)?r.evidence.limitations.join('；'):r.evidence.limitations)}</dd></dl></details>${r.status==='open'?`<button class="button ${compact?'secondary':'primary'}" data-action="new-visit" data-id="${esc(r.id)}">安排田间核查 <span>↗</span></button>`:`<span class="assigned">${r.status==='verified'?'已收集田间反馈':'已安排巡田任务'}</span>`}</article>`; }
function pendingVisits() { return visits.filter(v=>v.status==='pending').sort((a,b)=>(a.due_date||'9999-12-31').localeCompare(b.due_date||'9999-12-31')||(a.created_at||'').localeCompare(b.created_at||'')||a.id.localeCompare(b.id)); }
function riskPanel() { const active=risks.filter(r=>r.status!=='verified'); return `<section class="card"><div class="card-head"><h3>需要现场确认</h3><span class="subtle">${active.length} 项</span></div>${active.length?`<div class="risk-grid">${active.map(r=>riskCard(r)).join('')}</div>`:empty('暂无待核查候选', '候选需要足够、近期且质量合格的观测。没有候选并不表示地块健康。')}</section><section class="card below"><div class="card-head"><h3>待完成巡田 <span class="subtle">按计划日期</span></h3><a href="/field" class="text-link">进入田间助手 ↗</a></div><p class="caption schedule-note">已过计划日仅表示任务尚未完成，不代表农情严重程度。按本机日期 ${esc(fmtDate(today()))} 判断。</p>${pendingVisits().length?`<div class="task-grid">${pendingVisits().map(v=>visitCard(v,false)).join('')}</div>`:empty('暂无待完成巡田', '可从地块档案安排自主巡田，也可从异常候选安排核查。')}</section>`; }
function recordCard(v: Verification) { const p=parcelFor(v.parcel_id), visit=visits.find(item=>item.id===v.visit_id); return `<article class="record-card"><div class="record-icon">✓</div><div class="record-content"><div class="record-top"><h3>${esc(p?.name||v.parcel_id)}</h3><small><span>观察 ${esc(fmtTime(v.observed_at,true))}</span><span>保存 ${esc(fmtTime(v.created_at,true))}</span></small></div><p><strong>${esc(labels[v.label]||v.label)}</strong> <span class="badge reported">用户报告 · 非确诊</span> ${fixture(p)}</p><p class="record-origin">${visit?(visit.risk_id?'异常候选核查':'自主巡田 · 未关联异常候选'):'巡田来源待读取'}</p><p class="record-note">${esc(v.note||'未填写备注')}</p><span class="subtle">${v.photo_ids.length?`${v.photo_ids.length} 张现场照片`:'未附现场照片'}</span>${v.photo_ids.length?`<div class="record-photos">${v.photo_ids.map(id=>`<a href="/api/v1/photos/${encodeURIComponent(id)}" target="_blank" rel="noopener" aria-label="查看核查照片"><img src="/api/v1/photos/${encodeURIComponent(id)}" alt="用户提交的田间照片" loading="lazy"></a>`).join('')}</div>`:''}</div></article>`; }
function recentVerifications(parcelId?: string) { return verifications.filter(v=>!parcelId||v.parcel_id===parcelId).sort((a,b)=>+new Date(b.created_at)-+new Date(a.created_at)||+new Date(b.observed_at)-+new Date(a.observed_at)||a.id.localeCompare(b.id)); }
function recordsPanel() { const records=recentVerifications();return `<section class="card"><div class="card-head"><h3>现场反馈</h3><span class="subtle">${records.length} 条</span></div><p class="caption history-note">最近保存优先 · 时间按本机时区显示</p>${records.length?records.map(recordCard).join(''):empty('还没有现场反馈', '在田间助手中完成巡田后，核查记录会显示在这里。')}</section>`; }
function visitCard(v: Visit, field=true) { const p=parcelFor(v.parcel_id); const r=risks.find(r=>r.id===v.risk_id); const draft=drafts.find(d=>d.visit_id===v.id);const plan=v.due_date&&v.due_date<today()?'已过计划日':v.due_date===today()?'计划今天':'计划'; return `<article class="visit-card"><div class="visit-top"><span class="badge ${r?.priority==='high'?'high':'warning'}">${r?.priority==='high'?'优先核查':'待巡田'}</span><small class="${plan==='已过计划日'?'schedule-late':plan==='计划今天'?'schedule-today':''}">${plan} · ${esc(fmtDate(v.due_date))}</small></div><h3>${esc(p?.name||v.parcel_id)}</h3><p>${p?`${regions[p.region]} · 油菜 · ${Number(p.area_ha).toFixed(2)} ha`:'地块信息待连接后读取'}</p>${fixture(p)}<p class="visit-origin">${v.risk_id?'异常候选核查':'自主巡田 · 未关联异常候选'}${p?` · ${esc(p.season)}`:''}</p><div class="visit-reason">${esc(v.note||r?.summary||'请到田查看实际情况，记录现场反馈。')}</div>${v.assignee?`<p class="subtle">执行人：${esc(v.assignee)}</p>`:''}${field?`<button class="button primary full" data-action="verify" data-id="${esc(v.id)}">${draft?'继续本地草稿':'开始现场核查'} <span>→</span></button>`:''}</article>`; }
function renderField() { return `<div class="field-shell"><header class="field-header"><a class="field-brand" href="/field"><img src="/icon.svg" alt=""><span>田间助手<small>FieldSignal · 油菜</small></span></a><a href="/admin" class="admin-link" aria-label="打开管理工作台">管理端 ↗</a></header><div class="field-status">${headerStatus()}<button class="text-button" data-action="refresh">刷新 ↻</button></div><main class="field-main">${notice()}${storageError?`<div class="notice danger" role="alert">${esc(storageError)}</div>`:''}${fieldTab==='visits'?fieldVisits():fieldTab==='parcels'?fieldParcels():fieldRecords()}<p class="field-footnote">浏览器移动原型 · 非原生 App<br>本地草稿不会自动上传。服务可连接后，请在本页手动重试。未提供离线页面缓存。</p></main><nav class="bottom-nav" aria-label="田间助手导航">${[['visits','visits','巡田'],['parcels','fields','地块'],['records','records','记录']].map(([id,i,title])=>`<button data-action="field-tab" data-tab="${id}" class="${fieldTab===id?'active':''}" ${fieldTab===id?'aria-current="page"':''}><span>${icon(i)}</span>${title}</button>`).join('')}</nav></div>`; }
function fieldVisits() { const pending=pendingVisits(); return `<div class="field-heading"><div class="eyebrow">FIELD CHECKS</div><h1>巡田任务</h1><p>待完成 <strong>${pending.length}</strong> 次巡田 · 本机草稿 <strong>${drafts.length}</strong> 条</p><p class="caption">任务按计划日期从早到晚；已过计划日仅表示任务尚未完成，不代表农情严重程度。按本机日期 ${esc(fmtDate(today()))} 判断。</p></div>${drafts.length?`<section class="draft-section"><div class="section-tools"><h2>保存在这台设备</h2><span class="badge warning">待提交</span></div>${drafts.map(d=>`<div class="draft-item"><button class="draft-row" data-action="resume-draft" data-id="${esc(d.visit_id)}"><span class="draft-symbol">↥</span><span><strong>${esc(d.parcel_name)}</strong><small>${d.state==='error'?'上次提交未完成，点击重试':d.state==='pending_upload'?'等待手动上传':'草稿已保存'} · ${d.photos.length} 张照片</small>${fixture(d)}</span><span>›</span></button><button type="button" class="text-button draft-remove" data-action="remove-draft" data-id="${esc(d.visit_id)}" aria-label="移除 ${esc(d.parcel_name)} 的本机草稿">移除本机草稿</button></div>`).join('')}<p class="caption">草稿和照片保存在当前浏览器。清理网站数据、隐私模式或更换设备可能使其丢失。</p></section>`:''}<div class="section-tools"><h2>待巡田任务</h2><span>${pending.length} 项</span></div>${pending.length?pending.map(v=>visitCard(v)).join(''):empty('暂时没有巡田任务', connected?'可从地块档案安排自主巡田；无需等待遥感观测或异常候选。':'连接本地服务后读取任务；已有草稿仍可继续填写。',dashboard.parcels.length?'<button class="button secondary" data-action="field-tab" data-tab="parcels">选择地块并安排巡田</button>':'')}<div class="field-tip"><span>ⓘ</span><p>先看现场，再记录现象。疑似病害、冻害等选择仅表示你的现场判断。</p></div>`; }
function parcelPicker() { return `<label class="field-select">选择地块<select id="parcel-picker">${dashboard.parcels.map(p=>`<option value="${esc(p.id)}" ${selectedId===p.id?'selected':''}>${esc(p.name)}${p.data_origin==='fixture'?' · 开发模拟数据':''}</option>`).join('')}</select></label>`; }
function fieldParcels() { const p=selected(); return `<div class="field-heading"><div class="eyebrow">MY PARCELS</div><h1>地块档案</h1><p>观测、农事与现场情况，放在一起看。</p></div>${!p?empty('还没有地块', '请先在管理端录入地块与边界。','<a href="/admin" class="button secondary">打开管理端</a>'):`${parcelPicker()}<section class="card field-parcel"><div class="card-head"><h2>${esc(p.name)}</h2>${fixture(p)}</div><div class="parcel-facts"><span>${regions[p.region]}</span><span>油菜 · ${esc(p.season)}</span><span>${Number(p.area_ha).toFixed(2)} ha</span></div><div class="map-surface small-map">${boundaryMap([p],p.id)}</div><p class="map-attribution">地块边界示意，未加载外部底图</p><div class="field-quality">${badge(p.data_status)}<small>最近观测：${esc(fmtDate(p.latest_observed_at))}</small></div></section><section class="card field-chart"><div class="card-head"><h3>NDVI 变化</h3></div>${detailError?`<p class="notice danger">${esc(detailError)}</p>`:trend(observations)}</section><div class="field-actions"><button class="button primary full" data-action="new-routine-visit">安排自主巡田</button><button class="button secondary full" data-action="new-event">＋ 记一笔农事</button></div><p class="caption">自主巡田无需异常候选。新任务需连接本地服务创建；已有核查草稿可离线填写。</p>`}`; }
function fieldRecords() { const p=selected(); const records=recentVerifications(p?.id); return `<div class="field-heading"><div class="eyebrow">FIELD JOURNAL</div><h1>田间记录</h1><p>核查记录最近保存优先；时间按本机时区显示。</p></div>${p?parcelPicker():''}<section class="card"><div class="card-head"><h3>现场核查</h3><span>${records.length} 条</span></div>${records.length?records.map(recordCard).join(''):empty('暂无核查记录','完成现场核查后显示；本机草稿仍在「巡田」页。')}</section><section class="card below"><div class="card-head"><h3>农事记录</h3>${p?'<button class="text-button" data-action="new-event">＋ 添加</button>':''}</div>${eventHistory(p)}</section>`; }
function eventHistory(p?: Parcel) {
  if(!p)return empty('请选择地块','选择地块后读取对应农事记录。');
  if(eventsParcelId!==p.id)return '<p class="notice" role="status">此地块农事记录尚未读取。 <button class="text-button" data-action="refresh-detail">读取记录</button></p>';
  if(eventsState==='loading')return '<p class="notice" role="status">正在读取农事记录…</p>';
  if(eventsState!=='ready')return `<div class="notice ${eventsState==='error'?'danger':''}" ${eventsState==='error'?'role="alert"':''}>${eventsState==='error'?`农事记录未能读取：${esc(eventsError)}`:'农事记录尚未读取。'} <button class="text-button" data-action="refresh-detail">重试读取</button></div>`;
  return events.length?events.map(e=>`<article class="event-row"><span class="event-symbol">≋</span><div><h3>${esc(kinds[e.kind]||e.kind)} ${fixture(p)}</h3><small>${esc(fmtDate(e.occurred_on))}</small><p>${esc(e.note||'无备注')}</p></div></article>`).join(''):empty('暂无农事记录','记录播种、施肥、植保作业和排水情况。');
}
async function refreshDraftList(serviceRefresh?: number) {
  const token=++draftReadToken,epoch=draftEpoch;
  const current=()=>token===draftReadToken&&epoch===draftEpoch&&(serviceRefresh===undefined||serviceRefresh===refreshToken);
  try { const saved=await listDrafts();if(!current())return;drafts=saved;storageError=''; }
  catch(error) { if(!current())return;storageError=msg(error); }
  render();
}
async function refresh() {
  const token=++refreshToken;
  loading=true; render();
  const localDrafts=refreshDraftList(token);
  try {
    const result=await Promise.all([api<Health>('/health'),api<Dashboard>('/dashboard'),api<Risk[]>('/risks'),api<Visit[]>('/visits'),api<Verification[]>('/verifications')]);
    if(token!==refreshToken)return;
    [health,dashboard,risks,visits,verifications]=result;
    connected=true;loadError='';lastLoaded=new Date().toISOString();
    if(!dashboard.parcels.some(p=>p.id===selectedId))selectedId=dashboard.parcels[0]?.id||'';
    await loadDetail();
  } catch(error) { if(token!==refreshToken)return;connected=false;loadError=msg(error); }
  if(token!==refreshToken)return;
  loading=false; render();
  await localDrafts;
  if(token===refreshToken&&!isField&&adminTab==='sources')await sourceController.refresh();
}
function clearDetail() {
  ++detailToken;detailError='';eventsError='';observations=[];analyses=[];events=[];eventsParcelId='';eventsState='idle';
}
async function loadDetail() {
  clearDetail();const token=detailToken,id=selectedId;
  eventsParcelId=id;eventsState=id?'loading':'idle';
  if(!id)return;
  render();
  // Farm history remains usable even if observation/analysis reads fail or stall.
  await Promise.all([
    (async()=>{
      try { const [o,a]=await Promise.all([api<Observation[]>(`/parcels/${encodeURIComponent(id)}/observations`),api<Analysis[]>(`/parcels/${encodeURIComponent(id)}/analyses`)]);if(token===detailToken){observations=o;analyses=a.slice().sort((x,y)=>+new Date(y.evaluated_at)-+new Date(x.evaluated_at));} }
      catch(error) { if(token===detailToken)detailError=msg(error); }
      finally { if(token===detailToken)render(); }
    })(),
    (async()=>{
      try { const result=await api<FarmEvent[]>(`/parcels/${encodeURIComponent(id)}/events`);if(token===detailToken){events=result.slice().sort((x,y)=>y.occurred_on.localeCompare(x.occurred_on));eventsState='ready';} }
      catch(error) { if(token===detailToken){eventsError=msg(error);eventsState='error';} }
      finally { if(token===detailToken)render(); }
    })(),
  ]);
}
// Invalidate synchronously: native close events may arrive after another dialog opens.
function closeModal() { ++dialogSession; draftRemoval=undefined; storedDraftView=undefined; modal.close(); revokePhotos(); }
function openModal(title: string, body: string, wide=false) { ++dialogSession; draftRemoval=undefined; revokePhotos(); modal.className=wide?'wide':''; modal.innerHTML=`<div class="dialog-head"><div><div class="eyebrow">FIELDSIGNAL</div><h2 id="dialog-title">${title}</h2></div><button class="icon-button" data-action="close-dialog" aria-label="关闭对话框">×</button></div><div class="form-error notice danger" role="alert" tabindex="-1" hidden></div>${body}`; if(!modal.open) modal.showModal(); }
function revokePhotos() { photoUrls.forEach(URL.revokeObjectURL); photoUrls=[]; }
function parcelModal() { openModal('录入地块',`<form id="parcel-form"><fieldset id="parcel-fields"><p class="form-intro">录入真实地块档案。边界仅发送至本地服务，不加载外部地图。</p><div class="form-grid"><label>地块名称<input name="name" required maxlength="80" placeholder="例如：北侧一号田"></label><label>所属区域<select name="region">${Object.entries(regions).map(([v,t])=>`<option value="${v}">${t}</option>`).join('')}</select></label><label>种植季<input name="season" required maxlength="40" placeholder="例如：2026-2027"></label><label>播种日期（选填）<input name="sowing_date" type="date"></label></div><label>品种（选填）<input name="cultivar" maxlength="100"></label><label class="file-label">从 GeoJSON 文件读取边界<input id="parcel-file" type="file" accept="application/geo+json,application/json,.geojson,.json"></label><p class="caption" id="parcel-file-status" role="status">文件仅在此页面读取（1 MB 内），不会自动保存。支持 Polygon、单个 Feature 或仅含一个 Polygon Feature 的 FeatureCollection；不支持多地块或坐标转换。</p><div id="parcel-geometry-preview" class="geometry-preview"></div><pre id="parcel-geometry-summary" class="caption">选择文件或粘贴边界后可查看形状；示意图不用于定位或测绘。</pre><label>地块边界 · GeoJSON Polygon<textarea name="geometry" required rows="8" spellcheck="false" placeholder='{"type":"Polygon","coordinates":[[[经度,纬度], … , [首点经度,首点纬度]]]}'></textarea></label><p class="caption">使用 WGS84 经度、纬度顺序；首尾坐标一致；V0 不支持内环、高度坐标或多面。文件属性不会填入地块名称或种植季；仅发送 geometry 坐标，忽略 bbox 与属性。</p><p class="caption">请求中断可在此表单原样重试；改内容或重开表单前，请先确认原记录是否已保存。</p></fieldset><div class="dialog-actions"><button type="button" class="button secondary" data-action="close-dialog">取消</button><button type="submit" class="button primary">保存地块</button></div></form>`,true); }
function observationModal() { const p=selected(); if(!p||p.data_origin==='fixture')return; const sample={observed_at:new Date().toISOString(),source:'manual',source_record_id:'',features:{ndvi:null},quality:{usable:false,valid_fraction:0,flags:['待检查']},provenance:{provider:'',collection:'',item_id:'',processing_version:''}}; openModal('导入真实地块观测',`<form id="observation-form" data-parcel="${esc(p.id)}"><p class="form-intro">${esc(p.name)} · 地块 ${esc(p.id)} · 种植季 ${esc(p.season)}<br>高级录入。此入口接收单条已处理特征，不直接接收影像文件。请提供可追溯的真实来源与质量信息。提交的来源与质量声明尚未独立核验；未知信息请保留缺失，不能填零或猜测。</p><fieldset id="observation-fields"><label class="file-label">从 JSON 文件读取<input id="observation-file" type="file" accept="application/json,.json"></label><p class="caption" id="observation-file-status" role="status">支持单条观测或本地规范化脚本输出（1 MB 内）。选择文件不上传；规范化文件需明确选择一条记录。本次导入完成后，如需其他记录请重新打开并选择文件。</p><div id="observation-choices" class="observation-selection" hidden></div><pre id="observation-preview" class="observation-selection" aria-label="待导入观测核对">选择记录后显示来源、时间、质量和地块绑定；文件声明尚未独立核验。</pre><label>单条观测 JSON<textarea name="json" rows="17" spellcheck="false" required>${esc(JSON.stringify(sample,null,2))}</textarea></label><p class="caption">请填写特征、来源记录与处理版本；不要将示例或猜测值当作真实观测。</p></fieldset><div class="dialog-actions"><button type="button" class="button secondary" data-action="close-dialog">取消</button><button type="submit" class="button primary">校验并导入</button></div></form>`,true); }
function visitModal(riskId?:string) {
  const r=riskId?risks.find(r=>r.id===riskId):undefined;
  if(riskId&&!r)return;
  const p=r?parcelFor(r.parcel_id):selected();if(!p)return;
  const related=visits.filter(v=>v.parcel_id===p.id&&v.status==='pending');
  openModal(r?'安排候选核查':'安排自主巡田',`<form id="visit-form" data-parcel="${esc(p.id)}" ${r?`data-risk="${esc(r.id)}"`:''}><p class="form-intro">${esc(p.name)} ${fixture(p)}<br>地块 ${esc(p.id)} · 种植季 ${esc(p.season)}<br>${r?`异常候选核查 · ${esc(r.summary)}`:'自主巡田 · 不关联异常候选，可记录日常现场情况。'}</p>${!r&&related.length?`<div class="notice warning">此地块已有 ${related.length} 个待完成任务，请先核对是否已有本次巡田安排。</div>`:''}<label>计划巡田日期<input name="due_date" type="date" value="${today()}" required></label><label>执行人（选填）<input name="assignee" maxlength="100" placeholder="姓名或工作代号"></label><label>核查提示（选填）<textarea name="note" rows="3" maxlength="2000" placeholder="建议查看的位置、需要记录的现象…"></textarea></label><p class="caption">计划日期与现场观察时间分别保存。提交现场记录时，观察时间须在此地块种植季内。</p><div class="notice">任务保存在本地服务，不发送短信或推送通知。照片只在现场核查时选择，并在你手动提交核查后上传至本地服务。</div><p class="caption">请求中断可在此表单原样重试；改内容或重开表单前，请先确认原任务是否已创建。</p><div class="dialog-actions"><button type="button" class="button secondary" data-action="close-dialog">取消</button><button type="submit" class="button primary">创建巡田任务</button></div></form>`);
}
function eventModal() { const p=selected(); if(!p)return; openModal('记一笔农事',`<form id="event-form" data-parcel="${esc(p.id)}"><p class="form-intro">${esc(p.name)} ${fixture(p)}</p><div class="form-grid"><label>日期<input type="date" name="occurred_on" value="${today()}" required></label><label>农事类型<select name="kind">${Object.entries(kinds).map(([v,t])=>`<option value="${v}">${t}</option>`).join('')}</select></label></div><label>记录内容<textarea name="note" rows="5" maxlength="2000" required placeholder="记录做了什么、现场情况，以及需要留意的事项。"></textarea></label><p class="caption">农事记录需连接本地服务保存；离线草稿功能目前仅用于现场核查。请求中断可在此表单原样重试；改内容或重开表单前，请先确认原记录是否已保存。</p><div class="dialog-actions"><button type="button" class="button secondary" data-action="close-dialog">取消</button><button type="submit" class="button primary">保存农事记录</button></div></form>`); }
async function openVerification(visitId:string) {
  const session=++dialogSession;
  try {
    if(currentDraft)await flushDraft();else await saving;
    if(session!==dialogSession)return;
    const saved=(await listDrafts()).find(d=>d.visit_id===visitId);
    if(session!==dialogSession)return;
    const v=visits.find(v=>v.id===visitId); const p=v?parcelFor(v.parcel_id):undefined;
    if(!saved&&!v)throw new Error('未找到巡田任务，请刷新后重试。');
    const draft: VerificationDraft=saved||{visit_id:visitId,parcel_id:v!.parcel_id,parcel_name:p?.name||v!.parcel_id,...(p?.season?{parcel_season:p.season}:{}),data_origin:p?.data_origin||'user',client_submission_id:crypto.randomUUID(),observed_at:new Date().toISOString(),label:'uncertain',note:'',photos:[],state:'draft',updated_at:new Date().toISOString()};
    // Viewing an existing durable draft must not require a new storage write.
    if(!saved)await writeDraft(draft,true);
    if(session!==dialogSession)return;
    currentDraft=draft;storedDraftView=saved?{draft,json:JSON.stringify(draft),blobs:draft.photos.map(photo=>photo.blob)}:undefined;verificationModal();
  } catch(error) { if(session===dialogSession)toast(msg(error)); }
}
async function openDraftRemoval(visitId: string) {
  // List-only: never replace an editor or discard its unsaved in-memory changes.
  if(modal.open||currentDraft||submitting)return;
  const session=++dialogSession;
  try {
    await saving.catch(()=>{});
    if(session!==dialogSession||modal.open||currentDraft||submitting)return;
    const draft=(await listDrafts()).find(item=>item.visit_id===visitId);
    if(session!==dialogSession||modal.open||currentDraft||submitting)return;
    if(!draft){toast('此本机草稿已不存在，请查看最新列表。');await refreshDraftList();return;}
    openModal('移除本机草稿',`<p class="form-intro"><strong>${esc(draft.parcel_name)}</strong> ${fixture(draft)}<br>地块 ${esc(draft.parcel_id)}<br>巡田任务 ${esc(draft.visit_id)}<br>本机保存：${esc(fmtTime(draft.updated_at,true))}</p><div class="notice danger">将永久移除这台设备当前浏览器中的这一条草稿：现场观察时间、判断、备注和 ${draft.photos.length} 张照片（约 ${(draft.photos.reduce((total,photo)=>total+photo.blob.size,0)/1024/1024).toFixed(1)} MB）。未提交内容不可恢复。仅保留防止旧页面恢复草稿的标识，不保留备注或照片。</div><p class="caption">不会删除服务端已保存的核查记录或已上传照片，也不会取消巡田任务或其他页面已开始的提交。移除后，本机上传与待删除照片信息也会丢失，不能继续用此草稿重试；服务端未关联照片仍可能占用此任务的照片额度。若先前提交结果不确定，请先取消并到记录页核对。</p><div class="dialog-actions"><button type="button" class="button secondary" data-action="close-dialog" autofocus>取消，保留草稿</button><button type="button" class="button destructive" data-action="confirm-remove-draft">确认永久移除本机草稿</button></div>`);
    draftRemoval={draft,session:dialogSession,busy:false,blocked:false};
  } catch(error) { if(session===dialogSession)toast(msg(error)); }
}
async function confirmDraftRemoval(button: HTMLButtonElement) {
  const removal=draftRemoval;
  if(!removal||removal.busy||removal.blocked||removal.session!==dialogSession||!modal.open)return;
  const current=()=>draftRemoval===removal&&removal.session===dialogSession&&modal.open;
  removal.busy=true;button.disabled=true;++draftEpoch;
  try {
    await removeDraft(removal.draft);
    drafts=drafts.filter(item=>item.visit_id!==removal.draft.visit_id||item.client_submission_id!==removal.draft.client_submission_id||item.revision!==removal.draft.revision);
    if(current())closeModal();
    toast('这一条本机草稿已移除，服务端记录与照片未改动。');
  } catch(error) {
    removal.blocked=error instanceof DraftConflictError;
    if(current())formError(msg(error));else toast(msg(error));
  } finally {
    ++draftEpoch;removal.busy=false;button.disabled=removal.blocked;
    await refreshDraftList();
  }
}
function validVerificationSeason(season?: string): string | undefined {
  if(!season||!/^20\d{2}-20\d{2}$/.test(season))return;
  const [first,last]=season.split('-').map(Number);
  return last===first+1?season:undefined;
}
function verificationSeason(draft: VerificationDraft): string | undefined {
  return validVerificationSeason(parcelFor(draft.parcel_id)?.season)||validVerificationSeason(draft.parcel_season);
}
function verificationTimeError(draft: VerificationDraft, now=Date.now()): string {
  const timestamp=Date.parse(draft.observed_at);
  if(!Number.isFinite(timestamp))return '请填写真实的现场观察时间。';
  if(timestamp>now)return '观察时间晚于本机当前时间，请核对实际观察时间及设备时钟。';
  const season=verificationSeason(draft);if(!season)return '';
  const [first,last]=season.split('-');
  const parts=new Intl.DateTimeFormat('en',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(timestamp));
  const day=['year','month','day'].map(type=>parts.find(part=>part.type===type)!.value).join('-');
  return day<`${first}-07-01`||day>`${last}-06-30`?`观察时间不在 ${season} 种植季内（北京时间 ${first}-07-01 至 ${last}-06-30）。请核对任务地块、种植季及真实观察时间，不要代填历史日期。`:'';
}
function verificationTimeHelp(draft: VerificationDraft): string {
  const season=verificationSeason(draft);
  return season?`种植季 ${season} · 北京时间 ${season.slice(0,4)}-07-01 至 ${season.slice(5)}-06-30。输入按本机时区显示，提交时仍由服务端核对。`:'本机未保存此地块种植季。可继续编辑及保存；手动提交时须先连接本地服务核对地块与季节，之后才发送照片。输入按本机时区显示。';
}
async function checkVerificationTimeBeforeUpload(draft: VerificationDraft): Promise<{ error: string; season?: string }> {
  const issue=verificationTimeError(draft);if(issue)return {error:issue};
  if(verificationSeason(draft))return {error:''};
  try {
    const parcel=await api<Parcel>(`/parcels/${encodeURIComponent(draft.parcel_id)}`);
    if(parcel?.id!==draft.parcel_id||!validVerificationSeason(parcel.season))return {error:'尚未确认对应地块及种植季，未发送照片或核查。请保留草稿，连接本地服务后重试。'};
    const checked=verificationTimeError({...draft,parcel_season:parcel.season});
    return checked?{error:checked}:{error:'',season:parcel.season};
  } catch(error) { return {error:`提交前未能核对地块种植季：${msg(error)} 草稿与照片保留在本机，本次未发送照片或核查，请连接本地服务后重试。`}; }
}
function verificationModal() { const d=currentDraft!; openModal('现场核查',`<form id="verification-form"><fieldset id="verification-fields"><div class="verification-parcel"><span class="parcel-icon">▧</span><div><strong>${esc(d.parcel_name)}</strong>${fixture(d)}<small>你的观察将作为用户报告保存，不是确诊结果。</small></div></div><div class="draft-save" id="draft-save" role="status">已保存到本机 · ${esc(fmtTime(d.updated_at))}</div><button type="button" id="retry-draft-save" class="text-button" data-action="retry-draft-save" hidden>重试保存到本机</button>${d.error?`<div class="notice warning">上次提交未完成：${esc(d.error)}<br>草稿与照片仍在，点击下方按钮手动重试。</div>`:''}<label>现场观察时间<input name="observed_at" type="datetime-local" value="${localInput(d.observed_at)}" required></label><p class="caption">${esc(verificationTimeHelp(d))}</p><p id="verification-time-error" class="notice warning" role="status" ${verificationTimeError(d)?'':'hidden'}>${esc(verificationTimeError(d))}</p><span class="label-title" id="observation-label">看到什么情况？</span><div class="label-options" role="group" aria-labelledby="observation-label">${Object.entries(labels).map(([v,t])=>`<label class="radio-option"><input type="radio" name="label" value="${v}" ${d.label===v?'checked':''}><span>${t}</span></label>`).join('')}</div><label>现场备注<textarea name="note" rows="4" maxlength="2000" required placeholder="记录叶片、土壤、积水范围等所见现象。">${esc(d.note)}</textarea></label><div class="photo-heading"><span class="label-title">现场照片 <small>选填</small></span><span class="subtle" id="photo-count">${d.photos.length} 张</span></div><div class="photo-picker"><label class="button secondary">拍照 / 选择照片<input id="photo-input" type="file" accept="image/jpeg,image/png,image/webp" multiple></label><p class="caption">JPG、PNG、WebP，最多 8 张，每张最多 10 MB、1600 万像素。照片会随草稿保存在当前浏览器，仅在你提交时上传至本地服务。</p></div><div id="draft-photos" class="draft-photos"></div><p class="caption" id="no-photo">${d.photos.length?'':'当前未附现场照片，仍可提交核查。'}</p><div class="notice subtle-notice">离线时可继续填写并保存草稿。不会自动后台上传；不要在提交前清理浏览器数据。</div><div class="dialog-actions"><button type="button" class="button secondary" data-action="save-close">保存并返回</button><button type="submit" class="button primary">${d.state==='error'||d.state==='pending_upload'?'重试提交核查':'提交核查'}</button></div></fieldset></form>`); renderDraftPhotos(); }
function renderDraftPhotos() { revokePhotos(); const d=currentDraft; const container=modal.querySelector('#draft-photos'); if(!d||!container)return; container.innerHTML=d.photos.map(p=>{ const url=URL.createObjectURL(p.blob);photoUrls.push(url);return `<div class="draft-photo"><img src="${url}" alt="待提交现场照片 ${esc(p.name)}"><button type="button" data-action="remove-photo" data-id="${esc(p.key)}" aria-label="移除照片 ${esc(p.name)}">×</button><small>${p.uploaded_id?'已上传 · 等待核查提交':`${(p.blob.size/1024/1024).toFixed(1)} MB`}</small></div>`; }).join(''); const count=modal.querySelector('#photo-count');if(count)count.textContent=`${d.photos.length} 张`;const none=modal.querySelector('#no-photo');if(none)none.textContent=d.photos.length?'':'当前未附现场照片，仍可提交核查。'; }
async function writeDraft(draft: VerificationDraft, startNew=false) {
  ++draftEpoch;
  try { await saveDraft(draft,startNew); }
  finally { ++draftEpoch; }
}
function showDraftSaveFailure(error: unknown) {
  storageError=msg(error);
  const el=modal.querySelector('#draft-save');
  if(el)el.textContent=`${storageError} 当前编辑尚未确认保存，请保留此页面；备注和照片仍在当前页面中。`;
  const button=modal.querySelector<HTMLButtonElement>('#retry-draft-save');
  if(button){button.hidden=error instanceof DraftConflictError;button.disabled=false;}
}
function queueSave() {
  if(!currentDraft)return Promise.resolve();
  storedDraftView=undefined;
  currentDraft.updated_at=new Date().toISOString();currentDraft.state='draft';currentDraft.error=undefined;
  const snapshot=structuredClone(currentDraft),session=dialogSession;
  const status=modal.querySelector('#draft-save'),retry=modal.querySelector<HTMLButtonElement>('#retry-draft-save');
  if(status)status.textContent='正在保存到本机…';
  if(retry){retry.hidden=true;retry.disabled=true;}
  const task=saving.catch(()=>{}).then(async()=>{
    if(currentDraft?.client_submission_id===snapshot.client_submission_id)snapshot.revision=currentDraft.revision;
    await writeDraft(snapshot);
    if(currentDraft?.client_submission_id===snapshot.client_submission_id)currentDraft.revision=snapshot.revision;
  });
  saving=task;
  task.then(()=>{
    if(task!==saving)return;
    storageError='';
    if(modal.open&&session===dialogSession&&currentDraft?.visit_id===snapshot.visit_id){
      const el=modal.querySelector('#draft-save');if(el)el.textContent=`已保存到本机 · ${fmtTime(snapshot.updated_at)}`;
    }
  },error=>{
    if(task!==saving)return;
    storageError=msg(error);
    if(session===dialogSession)showDraftSaveFailure(error);
  });
  return task;
}
async function flushDraft() {
  const unchanged=storedDraftView&&currentDraft===storedDraftView.draft&&JSON.stringify(currentDraft)===storedDraftView.json&&currentDraft.photos.every((photo,index)=>photo.blob===storedDraftView!.blobs[index]);
  let task=currentDraft&&!unchanged?queueSave():saving;
  // Keep the dialog open until edits queued while saving are also acknowledged.
  for(;;){await task;if(task===saving)return;task=saving;}
}
async function submitVerification() {
  if(!currentDraft||submitting)return;
  const timeError=verificationTimeError(currentDraft);if(timeError){formError(timeError);return;}
  submitting=true;const d=currentDraft,session=dialogSession;let uploadStarted=false;
  const ownsDialog=()=>session===dialogSession&&currentDraft===d;
  const fields=modal.querySelector<HTMLFieldSetElement>('#verification-fields');if(fields)fields.disabled=true;
  try {
    const preflight=await checkVerificationTimeBeforeUpload(d);
    if(!ownsDialog()){toast('先前核查尚未发送；表单已切换，请重新打开草稿后手动提交。');return;}
    if(preflight.error){formError(preflight.error);return;}
    if(preflight.season)d.parcel_season=preflight.season;
    storedDraftView=undefined;
    await flushDraft();
    if(!ownsDialog()){toast('先前核查尚未发送；表单已切换，请重新打开草稿后手动提交。');return;}
    d.state='pending_upload';d.error=undefined;await writeDraft(d);
    if(!ownsDialog()){toast('先前核查尚未发送；表单已切换，请重新打开草稿后手动提交。');return;}
    uploadStarted=true;
    const status=modal.querySelector('#draft-save');if(status)status.textContent='正在上传至本地服务，请勿关闭…';
    ++draftEpoch;
    let result: Verification;
    try { result=await uploadVerificationDraft(d); } finally { ++draftEpoch; }
    // Keep the acknowledged record visible if the following list refresh fails.
    verifications=[result,...verifications.filter(item=>item.id!==result.id)];
    visits=visits.map(visit=>visit.id===result.visit_id?{...visit,status:'completed'}:visit);
    const sameSession=session===dialogSession&&currentDraft===d;
    if(currentDraft===d){currentDraft=undefined;storedDraftView=undefined;}
    if(sameSession){
      closeModal();
      if(isField){
        if(selectedId!==d.parcel_id){selectedId=d.parcel_id;clearDetail();detailError='此地块详情尚未读取，请刷新后查看。';}
        fieldTab='records';
      }
    }
    toast('核查已保存，巡田任务已完成。');await refresh();
  } catch(error) {
    d.state='error';d.error=msg(error);
    if(!uploadStarted){
      if(ownsDialog()){showDraftSaveFailure(error);formError(`${d.error} 本次尚未发送核查，请先保存当前编辑。`);}else toast(`先前核查尚未发送：${d.error}`);
    } else {
      let saveError: unknown;
      try{await writeDraft(d);}catch(storage){saveError=storage;d.error+=` ${msg(storage)}`;}
      if(ownsDialog()){
        formError(`${d.error} 草稿和照片未删除。`);
        if(saveError)showDraftSaveFailure(saveError);
        else {
          const status=modal.querySelector('#draft-save');
          if(status)status.textContent=d.error.includes('提交已确认')?'服务端已确认提交 · 本机新版草稿已保留，请先查看记录':'草稿已保存在本机 · 提交未完成，请手动重试';
        }
      }else toast(`先前核查提交未确认：${d.error}`);
    }
    if(ownsDialog()){
      const submit=modal.querySelector<HTMLButtonElement>('button[type="submit"]');if(submit)submit.textContent='重试提交核查';
      renderDraftPhotos();
    }
  } finally {submitting=false;if(fields)fields.disabled=false;}
}

app.addEventListener('change',async event=>{const target=event.target as HTMLSelectElement;if(target.id==='region-filter'){++dialogSession;region=target.value;const list=shownParcels();if(!list.some(p=>p.id===selectedId)){selectedId=list[0]?.id||'';await loadDetail();}render();}if(target.id==='parcel-picker'){++dialogSession;selectedId=target.value;await loadDetail();render();}});
document.addEventListener('click',async event=>{ const button=(event.target as Element).closest<HTMLElement>('[data-action]');if(!button)return;const action=button.dataset.action,id=button.dataset.id||'';const actionSession=dialogSession;
  try { if(action==='refresh')return await refresh(); if(action==='refresh-detail')return await loadDetail(); if(action==='admin-tab'){++dialogSession;adminTab=button.dataset.tab!;render();if(adminTab==='sources')await sourceController.refresh();} if(action==='refresh-sources')return await sourceController.refresh(); if(action==='import-public-sample')return await sourceController.importSample(); if(action==='field-tab'){++dialogSession;fieldTab=button.dataset.tab!;render();window.scrollTo({top:0});} if(action==='select-parcel'){++dialogSession;selectedId=id;await loadDetail();render();}
    if(action==='remove-draft')return await openDraftRemoval(id);if(action==='confirm-remove-draft')return await confirmDraftRemoval(button as HTMLButtonElement);
    if(action==='new-parcel')parcelModal();if(action==='import-observation')observationModal();if(action==='new-visit')visitModal(id);if(action==='new-routine-visit')visitModal();if(action==='new-event')eventModal();if(action==='verify'||action==='resume-draft')await openVerification(id);
    if(action==='close-dialog'||action==='save-close'){if(submitting||draftRemoval?.busy)return;if(draftRemoval){closeModal();return;}const session=++dialogSession;await flushDraft();if(session!==dialogSession)return;closeModal();currentDraft=undefined;await refreshDraftList();}
    if(action==='retry-draft-save'&&currentDraft&&!submitting){if((button as HTMLButtonElement).disabled)return;await flushDraft();if(actionSession===dialogSession){const error=modal.querySelector<HTMLElement>('.form-error');if(error)error.hidden=true;renderDraftPhotos();toast('草稿已重新保存到本机。');}}
    if(action==='remove-photo'&&currentDraft&&!submitting){const removed=currentDraft.photos.find(p=>p.key===id);if(removed?.uploaded_id)currentDraft.pending_delete_photo_ids=[...(currentDraft.pending_delete_photo_ids||[]),removed.uploaded_id];currentDraft.photos=currentDraft.photos.filter(p=>p.key!==id);await queueSave();renderDraftPhotos();}
    if(action==='analyze'&&selectedId){(button as HTMLButtonElement).disabled=true;button.textContent='正在分析…';const result=await post<Analysis>(`/parcels/${encodeURIComponent(selectedId)}/analyses`,{method:'statistical'});toast(`${statuses[result.status]||result.status}：${result.message}`);await refresh();}
    if(action==='load-fixtures'){openModal('加载开发模拟数据',`<p class="form-intro">将创建一个明确标记为「开发模拟数据」的地块及模拟观测，用于验证流程。模拟数据不代表实际农情，也不作为真实标签。</p><div class="dialog-actions"><button class="button secondary" data-action="close-dialog">取消</button><button class="button primary" data-action="confirm-fixtures">确认加载模拟数据</button></div>`);}
    if(action==='confirm-fixtures'){if((button as HTMLButtonElement).disabled)return;const session=dialogSession;(button as HTMLButtonElement).disabled=true;const result=await post<{created:boolean;parcel_id:string}>('/dev/fixtures',{});if(session===dialogSession){selectedId=result.parcel_id;closeModal();}toast(result.created?'开发模拟数据已加载。':'已有开发模拟数据，已定位该地块。');await refresh();}
  } catch(error){if(modal.open&&actionSession===dialogSession)formError(msg(error));else toast(msg(error));if(button instanceof HTMLButtonElement)button.disabled=false;if(action==='analyze')button.textContent='运行统计分析';}
});
modal.addEventListener('cancel',event=>{if(submitting||draftRemoval?.busy){event.preventDefault();return;}const session=++dialogSession;if(currentDraft){event.preventDefault();void flushDraft().then(async()=>{if(session!==dialogSession)return;closeModal();currentDraft=undefined;await refreshDraftList();}).catch(e=>{if(session===dialogSession)formError(msg(e));});}});
modal.addEventListener('close',()=>{if(!modal.open){currentDraft=undefined;storedDraftView=undefined;draftRemoval=undefined;revokePhotos();}});
modal.addEventListener('input',event=>{const input=event.target as HTMLInputElement|HTMLTextAreaElement;editObservationJson(input);editParcelGeometry(input);if(!currentDraft||submitting||!input.closest('#verification-form'))return;if(input.name==='note')currentDraft.note=input.value;if(input.name==='label')currentDraft.label=input.value;if(input.name==='observed_at'&&input.value&&!Number.isNaN(+new Date(input.value)))currentDraft.observed_at=new Date(input.value).toISOString();if(input.name==='observed_at'){const hint=modal.querySelector<HTMLElement>('#verification-time-error');if(hint){hint.textContent=input.value?verificationTimeError(currentDraft):'请填写真实的现场观察时间。';hint.hidden=!hint.textContent;}}void queueSave();});
modal.addEventListener('change',async event=>{const input=event.target as HTMLInputElement;const changeSession=dialogSession;try{if(input.id==='observation-record'){selectObservation(input as unknown as HTMLSelectElement);return;}if(input.id==='observation-file')await readObservationFile(input);if(input.id==='parcel-file')await readParcelFile(input);if(input.id==='photo-input'&&input.files&&currentDraft&&!submitting){const files=Array.from(input.files);if(currentDraft.photos.length+files.length>8)throw new Error('每次核查最多 8 张照片，请减少所选照片。');for(const file of files){if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('仅支持 JPG、PNG 或 WebP 照片。');if(file.size>10*1024*1024)throw new Error(`照片 ${file.name} 超过 10 MB，请选择较小照片。`);}for(const file of files)currentDraft.photos.push({key:crypto.randomUUID(),blob:file,name:file.name});await queueSave();renderDraftPhotos();input.value='';}}catch(error){if(changeSession===dialogSession)formError(msg(error));else toast(`先前表单处理未完成：${msg(error)}`);}});
modal.addEventListener('submit',async event=>{event.preventDefault();const form=event.target as HTMLFormElement;if(form.id==='parcel-form'&&parcelReads.has(form)){formError('边界文件仍在读取，请等待完成或手动编辑边界后再保存。');return;}if(form.id==='observation-form'&&observationBundles.has(form)&&observationBundles.get(form)!.selected===undefined){formError('请先选择规范化文件中的一条观测，或手动编辑 JSON。');return;}if(form.id==='observation-form'&&observationReads.has(form)){formError('所选文件仍在读取，请等待完成或手动编辑 JSON 后再提交。');return;}if(!form.reportValidity())return;if(form.id==='verification-form')return submitVerification();const submit=form.querySelector<HTMLButtonElement>('[type="submit"]')!;if(submit.disabled)return;const data=new FormData(form);submit.disabled=true;form.dataset.submitting='true';const fields=form.querySelector<HTMLFieldSetElement>('#observation-fields')||form.querySelector<HTMLFieldSetElement>('#parcel-fields');if(fields)fields.disabled=true;const session=dialogSession;const isCurrent=()=>modal.open&&session===dialogSession;const value=(key:string)=>String(data.get(key)||'').trim();let recordAttempted=false;try{
  if(form.id==='parcel-form'){const geometry=parseParcelGeometry(value('geometry'));recordAttempted=true;const p=await postRecord<Parcel>(form,'/parcels',{name:value('name'),region:value('region'),season:value('season'),geometry,...(value('sowing_date')?{sowing_date:value('sowing_date')}:{}),...(value('cultivar')?{cultivar:value('cultivar')}:{})});if(isCurrent()){selectedId=p.id;region='all';}toast('地块已录入，等待接入观测数据。');}
  if(form.id==='observation-form'){const json=singleObservation(value('json'));await post(`/parcels/${encodeURIComponent(form.dataset.parcel!)}/observations`,json);toast('观测已导入，来源与质量记录已保留。');}
  if(form.id==='visit-form'){recordAttempted=true;await postRecord(form,'/visits',{parcel_id:form.dataset.parcel!,risk_id:form.dataset.risk||null,due_date:value('due_date'),assignee:value('assignee')||null,note:value('note')||null});if(isCurrent()&&isField)fieldTab='visits';toast('巡田任务已创建，可在田间助手查看。');}
  if(form.id==='event-form'){recordAttempted=true;await postRecord(form,`/parcels/${encodeURIComponent(form.dataset.parcel!)}/events`,{occurred_on:value('occurred_on'),kind:value('kind'),note:value('note')});toast('农事记录已保存。');}
  if(isCurrent())closeModal();await refresh();
}catch(error){let text=error instanceof SyntaxError?'JSON 格式不正确，请检查括号、引号与逗号。':msg(error);if(recordAttempted&&!(error instanceof ApiError&&error.status<500))text+=' 原记录可能已经保存。保持内容重试可核对原结果；改内容或重开表单前请先检查列表。';if(isCurrent())formError(text);else toast(`先前表单保存未确认：${text}`);}finally{delete form.dataset.submitting;if(fields)fields.disabled=false;submit.disabled=parcelReads.has(form)||observationReads.has(form)||(observationBundles.has(form)&&observationBundles.get(form)!.selected===undefined);}});
window.addEventListener('online',()=>{render();toast('网络状态已恢复。草稿不会自动上传，请手动提交。');});
window.addEventListener('offline',()=>render());
void refresh();
