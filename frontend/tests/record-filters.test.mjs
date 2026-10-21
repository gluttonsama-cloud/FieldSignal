import test from 'node:test';
import assert from 'node:assert/strict';
import * as display from '../src/display.ts';
import { verificationCsv } from '../src/record-export.ts';
import { harness } from './helpers/ui-harness.mjs';
import { readFileSync } from 'node:fs';
process.env.TZ='UTC';
const rows=[
 {id:'record-new',visit_id:'visit-new',parcel_id:'p1',observed_at:'2026-10-18T09:00:00Z',created_at:'2026-10-20T11:00:00Z',label:'normal',note:'Synthetic recent note',photo_ids:[]},
 {id:'record-backfill',visit_id:'visit-backfill',parcel_id:'p1',observed_at:'2026-08-01T09:00:00Z',created_at:'2026-10-21T11:00:00Z',label:'uncertain',note:'Synthetic Earlier drainage report',photo_ids:['photo-backfill']},
 {id:'record-other',visit_id:'visit-other',parcel_id:'p2',observed_at:'2026-10-18T10:00:00Z',created_at:'2026-10-19T11:00:00Z',label:'disease_suspected',note:'Synthetic other parcel',photo_ids:[]},
];
function uiFor(pathname='/admin'){
 const ui=harness({pathname}),downloads=[];Object.assign(ui.context,display,{verificationCsv,downloadVerificationCsv:csv=>downloads.push(csv)});
 ui.context.testRows=structuredClone(rows);ui.run("verifications=testRows;dashboard.parcels.forEach(p=>{p.name='Same synthetic field';p.region='other';p.area_ha=1});dashboard.parcels[0].data_origin='fixture';dashboard.verification_count=8;loading=false;risks=[];visits=testRows.map(r=>({id:r.visit_id,parcel_id:r.parcel_id,status:'completed'}));eventsParcelId='p1';eventsState='ready';events=[{id:'event1',parcel_id:'p1',occurred_on:'2026-10-17',kind:'sowing',note:'Farm history stays visible'}];drafts=[{visit_id:'saved-draft',parcel_id:'p1',parcel_name:'Local draft',photos:[]}];");
 ui.context.api=ui.context.post=ui.context.saveDraft=()=>assert.fail('Local filtering/export must not call services or storage');
 return {...ui,downloads};
}
const state=ui=>JSON.parse(ui.run('JSON.stringify(recordFilters)'));
const inputs=ui=>JSON.parse(ui.run('JSON.stringify(recordFilterInputs)'));
const visible=(ui,parcel)=>JSON.parse(ui.run(`JSON.stringify(visibleRecords(${parcel?JSON.stringify(parcel):''}).map(r=>r.id))`));
const formFor=(ui,changes={})=>({id:'record-filter-form',values:{...inputs(ui),...changes},reportValidity:()=>true});
async function apply(ui,changes={}){const form=formFor(ui,changes);let prevented=false;await ui.app.listeners.submit({target:form,preventDefault(){prevented=true;}});assert.equal(prevented,true);return form;}
function edit(ui,key,value){const id=({query:'record-query',from:'record-from',to:'record-to',label:'record-label',parcelId:'record-parcel'})[key];ui.app.listeners.input({target:{id,value,closest:selector=>selector==='#record-filter-form'?{}:null}});}
function csvRows(csv){
 const rows=[];let row=[],value='',quote=false;
 for(let i=1;i<csv.length;i++){const c=csv[i];if(c==='"'){if(quote&&csv[i+1]==='"'){value+='"';i++;}else quote=!quote;}else if(!quote&&c===','){row.push(value);value='';}else if(!quote&&c==='\r'&&csv[i+1]==='\n'){row.push(value);rows.push(row);row=[];value='';i++;}else value+=c;}
 return rows;
}
const shownIds=html=>[...html.matchAll(/data-action="view-record-evidence" data-record="([^"]+)"/g)].map(match=>match[1]);

test('admin applied combinations find historical observations, keep recent-save ordering and leave unrelated state unchanged',async()=>{
 const ui=uiFor(),before=ui.run('JSON.stringify([selectedId,region,visits,risks,drafts,dashboard,events,visitFilters])');
 assert.deepEqual(shownIds(ui.run('recordsPanel()')),['record-backfill','record-new','record-other']);
 await apply(ui,{parcelId:'p1',label:'uncertain',from:'2026-08-01',to:'2026-08-01',query:'EARLIER'});
 assert.deepEqual(visible(ui),['record-backfill']);const html=ui.run('recordsPanel()');assert.deepEqual(shownIds(html),visible(ui));assert.match(html,/显示 1 \/ 3 条已加载核查/);assert.match(html,/不是保存日期/);assert.match(html,/开发模拟数据/);
 assert.equal(ui.run('JSON.stringify([selectedId,region,visits,risks,drafts,dashboard,events,visitFilters])'),before);
});

test('mobile keeps its existing parcel scope, has no second parcel selector and never filters farm history',async()=>{
 const ui=uiFor('/field');await apply(ui,{query:'Earlier',parcelId:'p2'});
 const html=ui.run('fieldRecords()');assert.doesNotMatch(html,/id="record-parcel"/);assert.match(html,/id="parcel-picker"/);assert.deepEqual(shownIds(html),['record-backfill']);assert.match(html,/Farm history stays visible/);assert.equal(state(ui).parcelId,'');assert.equal(ui.run('selectedId'),'p1');
 ui.run("selectedId='p2'");assert.deepEqual(shownIds(ui.run('fieldRecords()')),[]);assert.equal(state(ui).query,'Earlier');
});

test('CSV IDs and order exactly match current applied results and record criteria, API timestamps and completeness',async()=>{
 const ui=uiFor();await apply(ui,{parcelId:'p1'});const html=ui.run('recordsPanel()');await ui.click('export-records');
 const result=csvRows(ui.downloads[0]);assert.deepEqual(result.slice(1).map(row=>row[2]),shownIds(html));assert.deepEqual(result.slice(1).map(row=>row[8]),[rows[1].observed_at,rows[0].observed_at]);
 assert.match(result[1][0],/p1/);assert.match(result[1][1],/尚未全部加载/);assert.match(html,/仅下载当前已应用筛选的结果/);assert.match(html,/不含本机草稿、农事或照片文件/);
 await apply(ui,{from:'2026-08-01',to:'2026-08-01',query:'earlier'});await ui.click('export-records');const one=csvRows(ui.downloads[1]);assert.equal(one.length,2);assert.equal(one[1][2],'record-backfill');assert.match(one[1][0],/2026-08-01/);assert.match(one[1][0],/earlier/);
});

test('unapplied typing survives rerender, never changes visible/exported subset, and avoids input rerender or network/storage',async()=>{
 const ui=uiFor(),status={textContent:''},clear={disabled:true};ui.app.querySelector=selector=>selector==='#record-filter-input-status'?status:selector==='#clear-record-filters'?clear:null;
 ui.context.renders=0;ui.run('render=()=>{globalThis.renders++}');await apply(ui,{label:'uncertain'});const before=state(ui);ui.context.renders=0;
 edit(ui,'query','Other parcel');assert.equal(ui.context.renders,0);assert.deepEqual(state(ui),before);assert.equal(inputs(ui).query,'Other parcel');assert.match(status.textContent,/尚未应用/);assert.equal(clear.disabled,false);
 assert.match(ui.run('recordsPanel()'),/value="Other parcel"/);assert.deepEqual(shownIds(ui.run('recordsPanel()')),['record-backfill']);
 await ui.click('export-records');assert.deepEqual(csvRows(ui.downloads[0]).slice(1).map(row=>row[2]),['record-backfill']);
 await apply(ui);assert.deepEqual(visible(ui),[]);
});

test('zero matches, empty loaded list and invalid reversed range remain distinct; no empty or invalid export starts',async()=>{
 const ui=uiFor();await apply(ui,{query:'no such text'});let html=ui.run('recordsPanel()');assert.match(html,/没有符合筛选的核查记录/);assert.doesNotMatch(html,/还没有现场反馈/);assert.match(html,/data-action="export-records"[^>]*disabled/);
 await ui.click('export-records');assert.equal(ui.downloads.length,0);
 await apply(ui,{query:'',from:'2026-10-20',to:'2026-08-01'});html=ui.run('recordsPanel()');assert.match(html,/role="alert"/);assert.match(html,/当前不显示或导出记录/);assert.deepEqual(visible(ui),[]);await ui.click('export-records');assert.equal(ui.downloads.length,0);
 ui.run('verifications=[]');assert.match(ui.run('recordsPanel()'),/还没有现场反馈/);assert.match(ui.run('recordsPanel()'),/显示 0 \/ 0 条/);
});

test('unknown and stale literal choices remain visible and escaped without broadening matches',async()=>{
 const ui=uiFor();await apply(ui,{label:'<retired>',parcelId:'missing-<parcel>'});const html=ui.run('recordsPanel()');
 assert.match(html,/value="&lt;retired&gt;" selected/);assert.match(html,/value="missing-&lt;parcel&gt;" selected/);assert.match(html,/当前无已加载记录/);assert.doesNotMatch(html,/<retired>|missing-<parcel>/);assert.deepEqual(visible(ui),[]);
 ui.run("verifications=[{...verifications[0],label:'future-code'}]");await apply(ui,{label:'future-code',parcelId:'',query:''});assert.deepEqual(visible(ui),['record-new']);assert.match(ui.run('recordsPanel()'),/未识别代码：future-code/);
});

test('clear resets applied and drafted criteria, preserves selected parcel and task filters, and restores focus',async()=>{
 const ui=uiFor('/field'),focus=[];ui.app.querySelector=selector=>({focus(){focus.push(selector);}});ui.run("visitFilters={timing:'today',assignee:'name:Someone',parcelId:'p2'}");const taskFilters=ui.run('JSON.stringify(visitFilters)');
 await apply(ui,{query:'Earlier'});edit(ui,'query','Unapplied');await ui.click('clear-record-filters');
 assert.deepEqual(state(ui),{query:'',label:'',from:'',to:'',parcelId:''});assert.deepEqual(inputs(ui),state(ui));assert.equal(ui.run('selectedId'),'p1');assert.equal(ui.run('JSON.stringify(visitFilters)'),taskFilters);assert.equal(focus.at(-1),'#record-query');assert.ok(focus.includes('#record-filter-summary'));assert.deepEqual(visible(ui,'p1'),['record-backfill','record-new']);
});

test('refresh success/failure retains applied and drafted filters without widening stale selections',async()=>{
 const ui=uiFor();await apply(ui,{parcelId:'p1',label:'uncertain'});edit(ui,'query','Unapplied text');const prior=state(ui),draft=inputs(ui),dashboard=ui.run('structuredClone(dashboard)');
 ui.context.api=async path=>path==='/health'?{status:'ok'}:path==='/dashboard'?dashboard:[];ui.context.listDrafts=async()=>[];await ui.run('realRefresh()');assert.deepEqual(state(ui),prior);assert.deepEqual(inputs(ui),draft);assert.match(ui.run('recordsPanel()'),/当前无已加载记录/);
 ui.context.api=async()=>{throw new Error('Offline')};await ui.run('realRefresh()');assert.deepEqual(state(ui),prior);assert.deepEqual(inputs(ui),draft);assert.equal(ui.run('connected'),false);
});

test('captured mobile export scope never follows a newer selected parcel, including stale-loaded warning',async()=>{
 const ui=uiFor('/field');await apply(ui,{label:'uncertain'});ui.run("selectedId='p2';loadError='offline'");await ui.click('export-records',{parcel:'p1'});
 const result=csvRows(ui.downloads[0]);assert.deepEqual(result.slice(1).map(row=>row[2]),['record-backfill']);assert.match(result[1][0],/p1/);assert.match(result[1][1],/读取失败/);assert.equal(ui.run('selectedId'),'p2');
});

test('filtered cards retain full escaped identity and original photo/evidence targets',async()=>{
 const ui=uiFor();await apply(ui,{query:'Earlier'});const html=ui.run('recordsPanel()');
 assert.match(html,/任务 visit-backfill/);assert.match(html,/核查 record-backfill/);assert.match(html,/地块 p1/);assert.match(html,/2026-2027/);assert.match(html,/data-record="record-backfill" data-photo="photo-backfill"/);
 await ui.click('view-record-photo',{record:'record-backfill',photo:'photo-backfill'});assert.match(ui.modal.innerHTML,/核查记录 record-backfill/);await ui.click('close-dialog');
 await ui.click('view-record-evidence',{record:'record-backfill'});assert.match(ui.modal.innerHTML,/记录 record-backfill/);assert.equal(state(ui).query,'Earlier');
 ui.context.malicious={...rows[0],id:'<record>',visit_id:'<visit>',parcel_id:'<parcel>'};const escaped=ui.run('recordCard(malicious)');assert.match(escaped,/核查 &lt;record&gt;/);assert.match(escaped,/任务 &lt;visit&gt;/);assert.doesNotMatch(escaped,/<record>|<visit>|<parcel>/);
 const css=readFileSync(new URL('../src/style.css',import.meta.url),'utf8');assert.match(css,/\.record-card \.record-content \.record-identity\{[^}]*color:#425b35/);
});

test('native invalid filter input leaves the previous applied scope intact and sends nothing',async()=>{
 const ui=uiFor();await apply(ui,{label:'uncertain'});const before=state(ui),form=formFor(ui,{from:'bad-date'});form.reportValidity=()=>false;
 await ui.app.listeners.submit({target:form,preventDefault(){}});assert.deepEqual(state(ui),before);assert.deepEqual(visible(ui),['record-backfill']);
});

test('raw search length is not bypassed by trimming, while whitespace-only draft input remains clearable',async()=>{
 const ui=uiFor(),clear={disabled:true};ui.app.querySelector=selector=>selector==='#clear-record-filters'?clear:null;
 edit(ui,'query','   ');assert.equal(clear.disabled,false);await apply(ui);assert.equal(state(ui).query,'   ');assert.deepEqual(visible(ui),['record-backfill','record-new','record-other']);
 await ui.click('clear-record-filters');assert.equal(inputs(ui).query,'');await apply(ui,{query:' '.repeat(201)});assert.deepEqual(visible(ui),[]);assert.match(ui.run('recordsPanel()'),/关键词不能超过/);await ui.click('export-records');assert.equal(ui.downloads.length,0);
});

test('unrecognized inherited-property label codes remain literal on record cards, filter summaries and CSV',async()=>{
 for(const label of ['__proto__','constructor','toString']){
  const ui=uiFor();ui.context.unknownLabel=label;ui.run('verifications=[{...verifications[0],label:unknownLabel}]');
  await apply(ui,{label});const html=ui.run('recordsPanel()');assert.ok(html.includes(`<strong>${label}</strong>`));assert.doesNotMatch(html,/\[object Object\]|native code/);
  await ui.click('export-records');assert.ok(ui.downloads[0].includes(label));
 }
});
