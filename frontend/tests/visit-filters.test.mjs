import { syntheticRecordReceipt } from './helpers/record-receipts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as display from '../src/display.ts';
import { defaultVisitFilters, filterPendingVisits, visitFilterControls, visitPlanTiming } from '../src/visit-filters.ts';
import { harness, deferred } from './helpers/ui-harness.mjs';
import { readFileSync } from 'node:fs';
const day='2026-10-18';
const rows=[
 {id:'old',parcel_id:'p1',status:'pending',due_date:'2026-10-15',created_at:'2026-10-01T00:00:00Z',assignee:'Alice',note:'Old task note'},
 {id:'today',parcel_id:'p2',status:'pending',due_date:day,created_at:'2026-10-02T00:00:00Z',assignee:'unassigned',note:'Today task note'},
 {id:'future',parcel_id:'p1',status:'pending',due_date:'2026-10-21',created_at:'2026-10-03T00:00:00Z',assignee:null,note:'Future task note'},
 {id:'named-all',parcel_id:'p2',status:'pending',due_date:'2026-10-16',created_at:'2026-10-04T00:00:00Z',assignee:'all',note:'Named all task note'},
 {id:'lowercase',parcel_id:'p1',status:'pending',due_date:day,created_at:'2026-10-05T00:00:00Z',assignee:'alice',note:'Lowercase task note'},
 {id:'invalid',parcel_id:'p2',status:'pending',due_date:'2026-02-30',created_at:'2026-10-06T00:00:00Z',assignee:'Alice',note:'Invalid date task note'},
 {id:'missing',parcel_id:'p1',status:'pending',created_at:'2026-10-07T00:00:00Z',assignee:'',note:'Missing date task note'},
 {id:'completed',parcel_id:'p2',status:'completed',due_date:'2026-10-10',created_at:'2026-10-01T00:00:00Z',assignee:'Alice',note:'Completed task note'},
];
const filters = changes=>({...defaultVisitFilters(),...changes});
const ids = (f,source=rows)=>filterPendingVisits(source,filters(f),day).map(row=>row.id);
function uiFor(){
 const ui=harness({pathname:'/field'});Object.assign(ui.context,display,{today:()=>day});ui.context.testRows=structuredClone(rows);
 ui.run(`visits=testRows;dashboard.parcels.forEach(p=>Object.assign(p,{region:'other',season:'2026-2027',area_ha:1}));risks=[];drafts=[];connected=true`);
 return ui;
}
const change=(ui,id,value)=>ui.app.listeners.change({target:{id,value}});
const readFilters=ui=>JSON.parse(ui.run('JSON.stringify(visitFilters)'));
const fill=ui=>{const form=ui.modal.form;Object.assign(form.values,{due_date:day,assignee:'Alice',note:'Synthetic new task'});return form;};

test('plan date, exact assignee and parcel filters combine without mutating order or records',()=>{
 const before=JSON.stringify(rows);
 assert.deepEqual(ids({timing:'overdue'}),['old','named-all']);assert.deepEqual(ids({timing:'today'}),['today','lowercase']);assert.deepEqual(ids({timing:'upcoming'}),['future']);
 assert.deepEqual(ids({timing:'overdue',assignee:'name:Alice',parcelId:'p1'}),['old']);
 assert.deepEqual(ids({assignee:'name:Alice',parcelId:'p2'}),['invalid']);assert.equal(ids({}).length,7);assert.equal(JSON.stringify(rows),before);
});

test('sentinel-looking labels are distinct from all and unassigned; matching is exact not person identity',()=>{
 assert.deepEqual(ids({assignee:'unassigned'}),['future','missing']);assert.deepEqual(ids({assignee:'name:unassigned'}),['today']);
 assert.deepEqual(ids({assignee:'name:all'}),['named-all']);assert.deepEqual(ids({assignee:'name:alice'}),['lowercase']);assert.deepEqual(ids({assignee:'name:ALICE'}),[]);
});

test('invalid and missing calendar dates never become overdue or future across device timezone offsets',()=>{
 const original=process.env.TZ;
 try{for(const zone of ['Pacific/Kiritimati','America/Los_Angeles']){process.env.TZ=zone;assert.equal(visitPlanTiming({due_date:day},day),'today');for(const date of [undefined,'2026-02-30','2026-1-01','2026-10-18T00:00:00Z','not-a-date'])assert.equal(visitPlanTiming({due_date:date},day),'unknown');assert.deepEqual(ids({timing:'overdue'}),['old','named-all']);}}
 finally{if(original===undefined)delete process.env.TZ;else process.env.TZ=original;}
});

test('mobile and admin filter the sorted pending base but do not hide candidates or change global counters',()=>{
 const ui=uiFor();ui.run("visitFilters={timing:'all',assignee:'',parcelId:'p1'};risks=[{id:'r1',parcel_id:'p2',priority:'high',status:'open',summary:'Candidate remains visible',evidence:{limitations:[]}}]");const before=ui.run('JSON.stringify(visits)');
 for(const html of [ui.run('fieldVisits()'),ui.run('riskPanel()')]){
  assert.ok(html.indexOf('Old task note')<html.indexOf('Lowercase task note'));assert.ok(html.indexOf('Lowercase task note')<html.indexOf('Future task note'));
  assert.doesNotMatch(html,/Today task note|Named all task note|Completed task note/);assert.match(html,/显示 4 \/ 7 项已加载待巡田任务/);assert.match(html,/不代表农情严重程度/);
 }
 assert.match(ui.run('riskPanel()'),/Candidate remains visible/);assert.equal(ui.run('JSON.stringify(visits)'),before);assert.equal(ui.run('dashboard.pending_visit_count'),0);
});

test('all local drafts remain visible, resumable and removable even with zero matching tasks',()=>{
 const ui=uiFor();ui.run(`visitFilters={timing:'today',assignee:'name:Not loaded',parcelId:'p2'};drafts=[{visit_id:'draft-A',parcel_id:'p1',parcel_name:'Draft snapshot A',parcel_season:'2025-2026',state:'draft',photos:[],data_origin:'fixture'},{visit_id:'draft-B',parcel_id:'p2',parcel_name:'Draft snapshot B',state:'error',photos:[],data_origin:'user'}]`);
 const html=ui.run('fieldVisits()');assert.match(html,/没有符合筛选的待巡田任务/);assert.doesNotMatch(html,/暂时没有巡田任务/);assert.match(html,/Draft snapshot A/);assert.match(html,/Draft snapshot B/);assert.match(html,/data-action="resume-draft" data-id="draft-A"/);assert.match(html,/data-action="remove-draft" data-id="draft-B"/);assert.match(html,/本机草稿不受下方筛选影响/);assert.match(html,/种植季未保存/);assert.match(html,/2025-2026 · #p1/);assert.doesNotMatch(html,/任务 draft-A/);
});

test('empty source list is distinct from nonempty zero-match filter results',()=>{
 const ui=uiFor();ui.run("visits=[];visitFilters={timing:'all',assignee:'name:Stale',parcelId:'p2'}");const html=ui.run('fieldVisits()');
 assert.match(html,/暂时没有巡田任务/);assert.match(html,/显示 0 \/ 0/);assert.match(html,/Stale（当前无待任务）/);assert.match(html,/清除筛选/);
});

test('stale assignee/parcel choices stay visibly selected instead of silently broadening',()=>{
 const parcels=[{id:'p1',name:'Same name',season:'2026-2027',data_origin:'user'},{id:'p2',name:'Same name',season:'2025-2026',data_origin:'fixture'}];
 const f=filters({assignee:'name:<Retired>',parcelId:'missing-id'});const html=visitFilterControls(rows.filter(row=>row.status==='pending'),parcels,f,0);
 assert.match(html,/value="name:&lt;Retired&gt;" selected/);assert.match(html,/value="missing-id" selected/);assert.match(html,/当前无待任务/);assert.match(html,/档案未读取/);assert.doesNotMatch(html,/<Retired>/);
 assert.match(html,/Same name · 2026-2027/);assert.match(html,/Same name · 2025-2026.*开发模拟数据/);assert.deepEqual(ids(f),[]);
});

test('unknown runtime filter modes fail closed with visible retained values',()=>{
 for(const f of [filters({timing:'unexpected'}),filters({assignee:'bad-sentinel'})]){
  assert.deepEqual(filterPendingVisits(rows,f,day),[]);assert.match(visitFilterControls(rows,[],f,0),/未知条件/);assert.match(visitFilterControls(rows,[],f,0),/selected/);
 }
});

test('actual select change and clear events preserve target and issue no API or storage calls; focus returns after render',async()=>{
 const ui=uiFor(),focused=[];ui.app.querySelector=selector=>({focus:()=>focused.push(selector)});ui.context.api=ui.context.post=ui.context.saveDraft=()=>assert.fail('Filters must not read or write external/local state');
 await change(ui,'visit-timing-filter','today');await change(ui,'visit-assignee-filter','name:unassigned');await change(ui,'visit-parcel-filter','p2');
 assert.deepEqual(readFilters(ui),filters({timing:'today',assignee:'name:unassigned',parcelId:'p2'}));assert.equal(ui.run('selectedId'),'p1');assert.equal(ui.run('region'),'all');assert.equal(ui.run('dialogSession'),0);assert.deepEqual(focused,['#visit-timing-filter','#visit-assignee-filter','#visit-parcel-filter']);
 await change(ui,'visit-timing-filter','invalid');await change(ui,'visit-assignee-filter','raw-label');assert.equal(readFilters(ui).timing,'today');assert.equal(readFilters(ui).assignee,'name:unassigned');
 await ui.click('clear-visit-filters');assert.deepEqual(readFilters(ui),defaultVisitFilters());assert.equal(focused.at(-1),'#visit-timing-filter');
});

test('one device day is captured per list render, keeping filter labels and task cards consistent at midnight',()=>{
 for(const render of ['fieldVisits()','riskPanel()']){const ui=uiFor();let calls=0;ui.context.today=()=>++calls===1?day:'2026-10-19';ui.run("visitFilters={timing:'today',assignee:'',parcelId:''}");const html=ui.run(render);assert.equal(calls,1);assert.match(html,/Today task note/);assert.match(html,/计划今天/);}
});

test('same-name parcels and tasks retain escaped full identity in cards and saved draft snapshots',()=>{
 const ui=uiFor();ui.run("dashboard.parcels.forEach(p=>p.name='Same <parcel>');visits[0].id='task_<one>';visits[1].id='task_<two>'");
 for(const [index,id] of [[0,'one'],[1,'two']]){const html=ui.run(`visitCard(visits[${index}])`);assert.match(html,new RegExp(`任务 task_&lt;${id}&gt;`));assert.match(html,/地块 p[12]/);assert.doesNotMatch(html,/<parcel>|task_<one>|task_<two>/);}
 const css=readFileSync(new URL('../src/style.css',import.meta.url),'utf8');assert.match(css,/\.visit-card \.visit-identity,\.draft-row \.draft-identity\{[^}]*color:#425b35/);
});

test('service refresh success/failure and local draft refresh retain filters without widening stale choices',async()=>{
 const ui=uiFor();await change(ui,'visit-assignee-filter','name:Alice');await change(ui,'visit-parcel-filter','p2');const before=readFilters(ui),dashboard=ui.run('structuredClone(dashboard)');
 ui.context.api=async path=>path==='/health'?{status:'ok'}:path==='/dashboard'?dashboard:[];ui.context.listDrafts=async()=>[];await ui.run('realRefresh()');assert.deepEqual(readFilters(ui),before);assert.match(ui.run('fieldVisits()'),/Alice（当前无待任务）/);
 ui.context.api=async()=>{throw new Error('Offline')};await ui.run('realRefresh()');await ui.run('refreshDraftList()');assert.deepEqual(readFilters(ui),before);assert.equal(ui.run('connected'),false);
});

test('confirmed current task creation clears filters but never inserts a potentially stale creation receipt',async()=>{
 const ui=uiFor();await change(ui,'visit-timing-filter','overdue');await change(ui,'visit-parcel-filter','p2');await ui.click('new-routine-visit');const form=fill(ui),before=ui.run('JSON.stringify(visits)');
 ui.context.post=async(path,body)=>syntheticRecordReceipt(path,body,'already-completed-task');await ui.submit(form);assert.deepEqual(readFilters(ui),defaultVisitFilters());assert.equal(ui.run('fieldTab'),'visits');assert.equal(ui.run('JSON.stringify(visits)'),before);assert.match(ui.toast.textContent,/当前任务状态请以刷新后的列表为准/);
});

test('failed or cancelled creation does not reset task filters',async()=>{
 const ui=uiFor();await change(ui,'visit-timing-filter','today');const before=readFilters(ui);await ui.click('new-routine-visit');await ui.click('close-dialog');assert.deepEqual(readFilters(ui),before);
 await ui.click('new-routine-visit');const form=fill(ui);ui.context.post=async()=>{throw new Error('Unknown result')};await ui.submit(form);assert.deepEqual(readFilters(ui),before);assert.match(ui.modal.error.textContent,/原记录可能已经保存/);
});

test('late create success after dialog replacement and newer filter choices during a pending request are preserved',async()=>{
 for(const replace of [true,false]){const ui=uiFor(),pending=deferred();await change(ui,'visit-timing-filter','today');await ui.click('new-routine-visit');const form=fill(ui);let request;ui.context.post=async(path,body)=>{request={path,body};return pending.promise;};const saving=ui.submit(form);
  if(replace){await ui.click('close-dialog');await ui.click('new-routine-visit');}
  await change(ui,'visit-assignee-filter','name:Alice');const before=readFilters(ui);pending.resolve(syntheticRecordReceipt(request.path,request.body,'old-task'));await saving;assert.deepEqual(readFilters(ui),before);
 }
});

test('plan edits retain filters even when the updated task leaves their result set',async()=>{
 const ui=uiFor();await change(ui,'visit-timing-filter','overdue');await change(ui,'visit-assignee-filter','name:Alice');await ui.click('edit-visit-plan',{id:'old'});const form=ui.modal.form;Object.assign(form.values,{due_date:'2026-11-01',assignee:'Alice'});const before=readFilters(ui);
 ui.context.post=async(path,body)=>syntheticRecordReceipt(path,body,'old',rows[0]);await ui.submit(form);assert.deepEqual(readFilters(ui),before);assert.match(ui.run('fieldVisits()'),/没有符合筛选的待巡田任务/);
});
