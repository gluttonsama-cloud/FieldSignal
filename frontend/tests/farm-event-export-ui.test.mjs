import test from 'node:test';
import assert from 'node:assert/strict';
import * as display from '../src/display.ts';
import { harness, deferred, turn } from './helpers/ui-harness.mjs';

const rows=[
 {id:'event-latest',parcel_id:'p1',kind:'drainage',occurred_on:'2026-10-20',created_at:'2026-10-20T01:30:00+08:00',note:'Latest synthetic drainage note'},
 {id:'event-earlier',parcel_id:'p1',kind:'sowing',occurred_on:'2026-09-01',note:'Earlier synthetic sowing note'},
];
function setup(pathname='/field'){
 const ui=harness({pathname}),downloads=[];Object.assign(ui.context,display,{downloadFarmEventCsv:csv=>downloads.push(csv),seedEvents:structuredClone(rows)});
 ui.run("events=seedEvents;eventsParcelId='p1';eventsState='ready';eventsLoadedAt='2026-10-20T10:00:00.000Z';loading=false;dashboard.parcels.forEach(p=>{p.region='other';p.area_ha=1});verifications=[];risks=[];visits=[];recordFilters.query='Unrelated record filter';drafts=[{visit_id:'local-draft',parcel_id:'p1',parcel_name:'Synthetic local draft',photos:[]}];");
 ui.context.api=ui.context.post=ui.context.saveDraft=ui.context.removeDraft=ui.context.uploadVerificationDraft=()=>assert.fail('Explicit local export must not read or write services or browser storage');
 return {...ui,downloads};
}
const state=ui=>ui.run('JSON.stringify([selectedId,events,eventsState,eventsLoadedAt,verifications,visits,risks,drafts,dashboard,recordFilters,recordFilterInputs,visitFilters])');

test('farm history export is an explicit separate action in admin and field views, with the same loaded order and no mutations',async()=>{
 for(const pathname of ['/field','/admin']){
  const ui=setup(pathname),before=state(ui),html=ui.run(pathname==='/field'?'fieldRecords()':'eventHistory(selected())');
  assert.match(html,/data-action="export-farm-events" data-parcel="p1"/);assert.match(html,/2 条农事/);assert.match(html,/不受核查筛选影响/);assert.match(html,/不含核查、草稿或照片/);assert.match(html,/不能代替服务端备份/);
  assert.ok(html.indexOf(rows[0].note)<html.indexOf(rows[1].note));assert.equal(ui.downloads.length,0,'Rendering cannot start a download');
  await ui.click('export-farm-events',{parcel:'p1'});assert.equal(ui.downloads.length,1);const csv=ui.downloads[0];
  assert.ok(csv.indexOf('"event-latest"')<csv.indexOf('"event-earlier"'));assert.ok(csv.includes(rows[0].created_at));assert.ok(csv.includes(rows[0].occurred_on));assert.match(csv,/读取时间（UTC）：2026-10-20T10:00:00.000Z/);assert.doesNotMatch(csv,/local-draft|Unrelated record filter/);
  assert.equal(state(ui),before);assert.match(ui.toast.textContent,/已发起 2 条已读取农事/);
 }
});

test('idle, loading, failed, empty and different-parcel reads never offer or start an export, including stale clicks',async()=>{
 for(const change of ["eventsState='idle'","eventsState='loading'","eventsState='error';eventsError='Synthetic failure'","events=[]","eventsParcelId='p2'"]){
  const ui=setup();ui.run(change);const before=state(ui);assert.doesNotMatch(ui.run('eventHistory(selected())'),/export-farm-events/);
  await ui.click('export-farm-events',{parcel:'p1'});assert.equal(ui.downloads.length,0);assert.match(ui.toast.textContent,/本次没有下载/);assert.equal(state(ui),before);
 }
});

test('captured parcel scope cannot silently switch to a newer selected parcel, and absent or inconsistent scope fails closed',async()=>{
 const ui=setup();ui.run("selectedId='p2';loadError='Synthetic offline refresh'");await ui.click('export-farm-events',{parcel:'p1'});
 assert.equal(ui.downloads.length,1);assert.match(ui.downloads[0],/"p1","Parcel one"/);assert.doesNotMatch(ui.downloads[0],/Parcel two/);assert.match(ui.downloads[0],/页面概览刷新失败/);assert.equal(ui.run('selectedId'),'p2');
 await ui.click('export-farm-events',{parcel:'p2'});assert.equal(ui.downloads.length,1);
 ui.run("dashboard.parcels=dashboard.parcels.filter(p=>p.id!=='p1')");await ui.click('export-farm-events',{parcel:'p1'});assert.equal(ui.downloads.length,1);assert.match(ui.toast.textContent,/档案尚未读取/);
 const mixed=setup();mixed.run("events.push({...events[0],id:'other-event',parcel_id:'p2'})");await mixed.click('export-farm-events',{parcel:'p1'});assert.equal(mixed.downloads.length,0);assert.match(mixed.toast.textContent,/农事导出已取消/);
});

test('successful detail reads establish a new snapshot timestamp; failed reads clear it and expose no export',async()=>{
 const ui=setup();ui.context.api=async path=>path.endsWith('/events')?structuredClone(rows).reverse():[];
 await ui.run('loadDetail()');const loaded=ui.run('eventsLoadedAt');assert.match(loaded,/^\d{4}-\d\d-\d\dT/);assert.notEqual(loaded,'2026-10-20T10:00:00.000Z');
 assert.equal(ui.run('events[0].id'),'event-latest');await ui.click('export-farm-events',{parcel:'p1'});assert.ok(ui.downloads[0].includes(loaded));
 ui.context.api=async()=>{throw new Error('Synthetic read failure');};await ui.run('loadDetail()');assert.equal(ui.run('eventsLoadedAt'),'');assert.equal(ui.run('eventsState'),'error');assert.doesNotMatch(ui.run('eventHistory(selected())'),/export-farm-events/);
 await ui.click('export-farm-events',{parcel:'p1'});assert.equal(ui.downloads.length,1);
 ui.run('clearDetail()');assert.equal(ui.run('eventsLoadedAt'),'');assert.equal(ui.run('eventsState'),'idle');
});

test('late previous-parcel event reads cannot replace the current parcel export or its timestamp',async()=>{
 const ui=setup(),old=deferred();ui.context.api=async path=>path==='/parcels/p1/events'?old.promise:path==='/parcels/p2/events'?[{...rows[0],id:'p2-event',parcel_id:'p2'}]:[];
 const prior=ui.run('loadDetail()');await turn();assert.equal(ui.run('eventsLoadedAt'),'');ui.run("selectedId='p2'");await ui.run('loadDetail()');
 const ready=state(ui);old.resolve(rows);await prior;assert.equal(state(ui),ready);await ui.click('export-farm-events',{parcel:'p1'});assert.equal(ui.downloads.length,0);await ui.click('export-farm-events',{parcel:'p2'});assert.equal(ui.downloads.length,1);assert.match(ui.downloads[0],/p2-event/);assert.doesNotMatch(ui.downloads[0],/event-latest/);
});

test('unknown inherited-property farm kind codes remain literal in both visible history and CSV',async()=>{
 for(const kind of ['__proto__','constructor','toString']){
  const ui=setup();ui.context.testKind=kind;ui.run('events=[{...events[0],kind:testKind}]');const html=ui.run('eventHistory(selected())');assert.ok(html.includes(`<h3>${kind} `));assert.doesNotMatch(html,/\[object Object\]|native code/);
  await ui.click('export-farm-events',{parcel:'p1'});assert.ok(ui.downloads[0].includes(`"${kind}","${kind}"`));
 }
});
