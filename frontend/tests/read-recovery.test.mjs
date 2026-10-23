import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/api.ts';
import * as display from '../src/display.ts';
import * as sourceView from '../src/sources.ts';
import { harness, deferred, turn } from './helpers/ui-harness.mjs';

const parcel={id:'p1',name:'Synthetic retained parcel',region:'other',season:'2026-2027',crop:'oilseed_rape',data_origin:'user',area_ha:1,geometry:{type:'Polygon',coordinates:[[[0,0],[0.001,0],[0.001,0.001],[0,0]]]},created_at:'2026-10-18T00:00:00Z'};
const visit={id:'v1',parcel_id:'p1',status:'pending',due_date:'2026-10-20',created_at:'2026-10-18T00:00:00Z'};
const record={id:'r1',visit_id:'old-visit',parcel_id:'p1',label:'uncertain',note:'Retained saved report',observed_at:'2026-10-18T00:00:00Z',created_at:'2026-10-18T01:00:00Z',photo_ids:[]};
const dashboard={parcel_count:1,open_risk_count:0,pending_visit_count:1,verification_count:1,parcels:[parcel],recent_verifications:[record]};
const risk={id:'risk1',parcel_id:'p1',observation_id:'o1',status:'open',priority:'high',summary:'Synthetic only',method:'statistical',model_version:'test',created_at:'2026-10-18T00:00:00Z',evidence:{metric:'ndvi',latest_value:0.3,baseline_count:0,baseline_observation_ids:[],limitations:[]}};
const observation={id:'o1',parcel_id:'p1',source:'sentinel2',source_record_id:'synthetic',observed_at:'2026-10-18T00:00:00Z',created_at:'2026-10-18T00:00:00Z',features:{ndvi:0.4},quality:{usable:false,valid_fraction:0.4,flags:[]},provenance:{provider:'synthetic',collection:'synthetic',item_id:'synthetic',processing_version:'test'},data_origin:'user'};
const analysis={id:'a1',parcel_id:'p1',method:'statistical',evaluated_at:'2026-10-18T00:00:00Z',status:'insufficient_data',observation_count:1,message:'Synthetic incomplete history'};
const event={id:'e1',parcel_id:'p1',kind:'drainage',occurred_on:'2026-10-18',note:'Independent farm history'};
const draft={visit_id:'saved-v',parcel_id:'saved-p',parcel_name:'Saved local draft',parcel_season:'2026-2027',data_origin:'user',client_submission_id:'saved-submission',observed_at:'2026-10-18T12:00:00Z',label:'uncertain',note:'Preserve my local note',photos:[],state:'draft',updated_at:'2026-10-18T12:00:00Z',revision:1};
const valid=()=>({'/health':{status:'ok',version:'test',demo_enabled:false},'/dashboard':structuredClone(dashboard),'/risks':[], '/visits':[structuredClone(visit)], '/verifications':[structuredClone(record)],'/parcels/p1/observations':[],'/parcels/p1/analyses':[],'/parcels/p1/events':[]});
function setup(pathname='/field'){
 const ui=harness({pathname}),responses=valid(),calls=[];
 Object.assign(ui.context,display,sourceView,{api,seedDashboard:structuredClone(dashboard),seedVisit:structuredClone(visit),seedRecord:structuredClone(record),seedRisk:structuredClone(risk)});
 ui.run("dashboard=seedDashboard;visits=[seedVisit];verifications=[seedRecord];risks=[];health={status:'ok',version:'retained',demo_enabled:false};selectedId='p1';lastLoaded='retained-load';loading=false;connected=true;render=()=>{document.querySelector('#app').innerHTML=isField?renderField():renderAdmin();};");
 const fetchBefore=globalThis.fetch;
 globalThis.fetch=async(url,options={})=>{const path=String(url).replace('/api/v1','');calls.push({path,method:options.method||'GET'});const value=responses[path];return Response.json(typeof value==='function'?await value():value??[]);};
 ui.context.post=ui.context.uploadVerificationDraft=ui.context.removeDraft=()=>assert.fail('Read recovery must not write or upload');
 return {...ui,responses,calls,restore(){globalThis.fetch=fetchBefore;}};
}
const core=ui=>ui.run('JSON.stringify({health,dashboard,risks,visits,verifications,selectedId,lastLoaded})');

test('a first-load failure never presents the action overview as zero work, and an explicit refresh restores it',async()=>{
 const ui=setup('/admin');try{
  ui.run("dashboard={parcel_count:0,open_risk_count:0,pending_visit_count:0,verification_count:0,parcels:[],recent_verifications:[]};visits=[];verifications=[];selectedId='';lastLoaded='';connected=false;");
  ui.responses['/visits']={};await ui.run('realRefresh()');
  assert.match(ui.app.innerHTML,/待办尚未读取/);
  assert.doesNotMatch(ui.app.innerHTML,/目前没有待巡田任务|还没有需要复核的报告|先建立地块档案|<b>0<\/b>/);
  Object.assign(ui.responses,valid());ui.run('refresh=realRefresh');await ui.click('refresh');
  assert.equal(ui.run('loadError'),'');assert.match(ui.app.innerHTML,/Synthetic retained parcel/);assert.match(ui.app.innerHTML,/1<\/b> 次待巡田/);
  assert.doesNotMatch(ui.app.innerHTML,/待办尚未读取/);assert.ok(ui.calls.every(call=>call.method==='GET'));
 }finally{ui.restore();}
});

test('malformed successful core responses are rejected atomically without poisoning either real rendered interface',async()=>{
 for(const pathname of ['/field','/admin'])for(const [path,bad] of [
  ['/visits',{}],['/visits',[null]],['/visits',[{...visit,due_date:{}}]],['/verifications',{}],['/verifications',[{}]],['/verifications',[{...record,photo_ids:{}}]],
  ['/risks',[{...risk,evidence:null}]],['/dashboard',{}],['/dashboard',{...dashboard,parcels:[null]}],['/dashboard',{...dashboard,parcels:[{...parcel,geometry:{coordinates:'broken'}}]}],
 ]){
  const ui=setup(pathname);try{
   ui.run(pathname==='/field'?"fieldTab='records'":"adminTab='overview'");const before=core(ui);ui.responses[path]=bad;
   await assert.doesNotReject(ui.run('realRefresh()'));
   assert.equal(core(ui),before,`${pathname} ${path} must retain every prior core value`);assert.equal(ui.run('connected'),false);assert.equal(ui.run('loading'),false);assert.match(ui.run('loadError'),/读取失败.*响应结构无效/);
   assert.match(ui.app.innerHTML,/刷新/);assert.equal(ui.calls.filter(call=>call.path.includes('/parcels/')).length,0,'invalid core never starts dependent detail reads');assert.ok(ui.calls.every(call=>call.method==='GET'));
  }finally{ui.restore();}
 }
});

test('a delayed saved local draft stays visible and can reopen after a malformed remote success, with no storage or upload writes',async()=>{
 const ui=setup(),local=deferred();try{
  const saved=structuredClone(draft),before=JSON.stringify(saved);let writes=0;
  ui.context.listDrafts=()=>local.promise;ui.context.saveDraft=()=>{writes++;assert.fail('Opening an existing durable draft must not rewrite it');};ui.responses['/visits']={};
  const attempt=ui.run('realRefresh()');attempt.catch(()=>{});await turn();
  assert.equal(ui.run('loading'),false);assert.equal(ui.run('connected'),false);assert.match(ui.app.innerHTML,/刷新/);
  local.resolve([saved]);await assert.doesNotReject(attempt);assert.match(ui.app.innerHTML,/data-action="resume-draft" data-id="saved-v"/);assert.match(ui.app.innerHTML,/Saved local draft/);
  await ui.click('resume-draft',{id:'saved-v'});assert.equal(ui.run('currentDraft.note'),draft.note);assert.equal(ui.modal.open,true);assert.equal(writes,0);assert.equal(JSON.stringify(saved),before);assert.ok(ui.calls.every(call=>call.method==='GET'));
 }finally{ui.restore();}
});

test('manual refresh after malformed core response sends new reads and publishes recovered data, while retaining selected scope and filters',async()=>{
 const ui=setup();try{
  ui.run("recordFilters.query='Retained';recordFilterInputs.query='Unapplied';visitFilters.timing='today'");ui.responses['/verifications']={};await ui.run('realRefresh()');const initial=ui.calls.length;
  Object.assign(ui.responses,valid());ui.responses['/verifications']=[{...record,note:'Recovered report'}];await ui.run('realRefresh()');
  assert.ok(ui.calls.length>initial);assert.equal(ui.run('connected'),true);assert.equal(ui.run('loadError'),'');assert.equal(ui.run('loading'),false);assert.equal(ui.run('verifications[0].note'),'Recovered report');assert.notEqual(ui.run('lastLoaded'),'retained-load');assert.equal(ui.run('selectedId'),'p1');assert.equal(ui.run('recordFilters.query'),'Retained');assert.equal(ui.run('recordFilterInputs.query'),'Unapplied');assert.equal(ui.run('visitFilters.timing'),'today');
 }finally{ui.restore();}
});

test('malformed event rows stay in the independent recoverable error state instead of becoming ready and breaking render',async()=>{
 for(const bad of [{},[null],[{...event,occurred_on:42}],[{...event,parcel_id:'wrong-parcel'}]]){
  const ui=setup();try{
   ui.run("fieldTab='records'");ui.responses['/parcels/p1/events']=bad;ui.responses['/parcels/p1/observations']=[observation];ui.responses['/parcels/p1/analyses']=[analysis];
   await assert.doesNotReject(ui.run('loadDetail()'));assert.equal(ui.run('eventsState'),'error');assert.equal(ui.run('events.length'),0);assert.equal(ui.run('observations.length'),1);assert.equal(ui.run('detailError'),'');assert.match(ui.app.innerHTML,/农事记录未能读取/);assert.doesNotMatch(ui.app.innerHTML,/暂无农事记录/);
   ui.responses['/parcels/p1/events']=[event];await ui.click('refresh-detail');assert.equal(ui.run('eventsState'),'ready');assert.match(ui.app.innerHTML,/Independent farm history/);
  }finally{ui.restore();}
 }
});

test('malformed observation or analysis groups are validated together and do not suppress independently valid farm history',async()=>{
 for(const [path,bad] of [
  ['/parcels/p1/observations',{}],['/parcels/p1/observations',[null]],['/parcels/p1/observations',[{...observation,features:null}]],['/parcels/p1/observations',[{...observation,quality:{...observation.quality,flags:{}}}]],['/parcels/p1/observations',[{...observation,parcel_id:'wrong-parcel'}]],
  ['/parcels/p1/analyses',{}],['/parcels/p1/analyses',[null]],
 ]){
  const ui=setup();try{
   ui.run("fieldTab='records'");ui.responses['/parcels/p1/observations']=[observation];ui.responses['/parcels/p1/analyses']=[analysis];ui.responses['/parcels/p1/events']=[event];ui.responses[path]=bad;
   await assert.doesNotReject(ui.run('loadDetail()'));assert.match(ui.run('detailError'),/读取失败.*响应结构无效/);assert.equal(ui.run('observations.length'),0);assert.equal(ui.run('analyses.length'),0);assert.equal(ui.run('eventsState'),'ready');assert.match(ui.app.innerHTML,/Independent farm history/);
  }finally{ui.restore();}
 }
});

test('candidate-evidence malformed observations show an explicit retry without replacing the original candidate snapshot',async()=>{
 const ui=setup();try{
  ui.run('risks=[seedRisk]');ui.responses['/parcels/p1/observations']=[null];await ui.click('view-candidate-evidence',{id:'risk1'});await turn();
  assert.match(ui.modal.candidateObservations.innerHTML,/原观测读取失败/);assert.match(ui.modal.candidateObservations.innerHTML,/retry-candidate-evidence/);assert.match(ui.modal.innerHTML,/当时保存的算法候选/);
  ui.responses['/parcels/p1/observations']=[observation];await ui.click('retry-candidate-evidence');assert.doesNotMatch(ui.modal.candidateObservations.innerHTML,/原观测读取失败/);assert.match(ui.modal.candidateObservations.innerHTML,/o1/);assert.ok(ui.calls.every(call=>call.method==='GET'));
 }finally{ui.restore();}
});

test('stale malformed core and detail responses cannot replace newer successful reads or their error state',async()=>{
 const ui=setup(),coreGate=deferred(),eventGate=deferred();try{
  ui.responses['/visits']=()=>coreGate.promise;const older=ui.run('realRefresh()');await turn();ui.responses['/visits']=[visit];await ui.run('realRefresh()');const retained=core(ui);
  coreGate.resolve({});await older;assert.equal(core(ui),retained);assert.equal(ui.run('loadError'),'');
  ui.responses['/parcels/p1/events']=()=>eventGate.promise;const detail=ui.run('loadDetail()');await turn();ui.responses['/parcels/p1/events']=[event];await ui.run('loadDetail()');eventGate.resolve([null]);await detail;assert.equal(ui.run('eventsState'),'ready');assert.equal(ui.run('eventsError'),'');assert.equal(ui.run('events[0].id'),event.id);
 }finally{ui.restore();}
});
