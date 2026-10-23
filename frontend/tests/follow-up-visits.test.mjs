import test from 'node:test';
import assert from 'node:assert/strict';
import * as display from '../src/display.ts';
import * as sourceView from '../src/sources.ts';
import { ApiError } from '../src/api.ts';
import { harness, deferred, turn, verificationResult } from './helpers/ui-harness.mjs';
import { syntheticRecordReceipt } from './helpers/record-receipts.mjs';

const source = () => ({id:'source/<report>',visit_id:'original-visit',parcel_id:'p1',risk_id:'original-risk',observed_at:'2026-10-17T08:00:00Z',created_at:'2026-10-18T09:00:00Z',label:'uncertain',note:'Original <field> observation\nDo not change',photo_ids:[]});
const followUp = () => ({id:'follow-up-1',parcel_id:'p1',source_verification_id:source().id,risk_id:'original-risk',status:'pending',due_date:'2026-10-22',assignee:null,note:'Check again',plan_revision:0,created_at:'2026-10-18T12:00:00Z'});
function receipt(body, changes={}) { return {...followUp(),...structuredClone(body),...changes}; }
function setup(pathname='/field') {
  const ui=harness({pathname}),calls=[],reads=[];
  Object.assign(ui.context,display,sourceView,{sourceRecord:source(),followUp:followUp(),post:async(path,body,key)=>{calls.push({path,body:structuredClone(body),key});return receipt(body);},api:async path=>{reads.push(path);return [];}});
  ui.run("verifications=[sourceRecord];visits=[{id:'original-visit',parcel_id:'p1',risk_id:'original-risk',status:'completed',due_date:'2026-10-17'}];dashboard.parcels.forEach(p=>Object.assign(p,{region:'other',area_ha:1}));fieldTab='records';");
  return {...ui,calls,reads};
}
async function openForm(ui) { await ui.click('new-follow-up-visit',{record:source().id});const form=ui.modal.form;Object.assign(form.values,{due_date:'2026-10-22',assignee:'  Field person  ',note:'  Check again  '});return form; }
function addFollowUp(ui) { ui.run('visits.push(structuredClone(followUp))'); }

// Production click/submit handlers, not detached markup tests.
test('saved records open an explicit fixed-source form on both surfaces, with no automatic read or POST',async()=>{
  for(const pathname of ['/admin','/field']){
    const ui=setup(pathname);assert.match(ui.run('recordCard(verifications[0])'),/data-action="new-follow-up-visit"[^>]*>安排复查/);
    const form=await openForm(ui),html=ui.modal.innerHTML;
    for(const text of ['source/&lt;report&gt;','original-visit','p1','2026-2027','2026-10-17','Original &lt;field&gt; observation','用户报告，非确诊','不发送短信或推送'])assert.ok(html.includes(text),text);
    assert.doesNotMatch(html,/name="(?:source|parcel|label|observed_at|risk)/);assert.equal(ui.calls.length,0);assert.equal(ui.reads.length,0);
    ui.run("selectedId='p2';verifications[0].id='changed-source';verifications[0].parcel_id='p2';verifications[0].note='Changed cached note';dashboard.parcels[0].season='2030-2031';verifications=[];");
    assert.equal(ui.modal.innerHTML,html);await ui.submit(form);
    assert.equal(ui.calls[0].path,`/verifications/${encodeURIComponent(source().id)}/follow-up-visits`);
    assert.deepEqual(ui.calls[0].body,{due_date:'2026-10-22',assignee:'Field person',note:'Check again'});
    assert.match(ui.calls[0].key,/^[0-9a-f-]{36}$/);assert.equal(ui.run('selectedId'),'p2');assert.equal(ui.run('visits.length'),1,'create receipts never optimistically insert a stale pending task');
    assert.equal(ui.modal.open,false);assert.match(ui.toast.textContent,/复查任务创建已确认/);if(pathname==='/field')assert.equal(ui.run('fieldTab'),'visits');
  }
});

test('cancel, Escape, missing source, and invalid fields do not submit or repurpose an old form',async()=>{
  const ui=setup();await ui.click('new-follow-up-visit',{record:'unloaded'});assert.equal(ui.modal.open,false);assert.match(ui.toast.textContent,/尚未读取/);
  let form=await openForm(ui);form.reportValidity=()=>false;await ui.submit(form);assert.equal(ui.calls.length,0);form.reportValidity=()=>true;
  await ui.click('close-dialog');await ui.submit(form);assert.equal(ui.calls.length,0);
  form=await openForm(ui);let prevented=false;ui.modal.listeners.cancel({preventDefault(){prevented=true;}});assert.equal(prevented,false);ui.modal.close();await ui.submit(form);assert.equal(ui.calls.length,0);
});

test('invalid, unknown, and mismatched receipts retain the form and original retry identity',async()=>{
  const corruptions=[undefined,null,[],{}, {id:'only-id'},receipt({due_date:'2026-10-22',assignee:'Field person',note:'Check again'}, {source_verification_id:'another-source'}),receipt({due_date:'2026-10-22',assignee:'Field person',note:'Check again'}, {parcel_id:'p2'}),receipt({due_date:'2026-10-22',assignee:'Field person',note:'Check again'}, {risk_id:'foreign-risk'}),receipt({due_date:'2026-10-22',assignee:'Field person',note:'Check again'}, {status:'completed'}),receipt({due_date:'2026-10-22',assignee:'Field person',note:'Check again'}, {plan_revision:1}),receipt({due_date:'2026-10-22',assignee:'Field person',note:'Check again'}, {due_date:'2026-11-01'})];
  for(const invalid of corruptions){
    const ui=setup(),form=await openForm(ui);ui.run("visitFilters={timing:'overdue',assignee:'unassigned',parcelId:'p2'}");
    ui.context.post=async(path,body,key)=>{ui.calls.push({path,body:structuredClone(body),key});return invalid;};await ui.submit(form);await ui.submit(form);
    assert.equal(ui.calls.length,2);assert.equal(ui.calls[0].key,ui.calls[1].key);assert.equal(ui.modal.form,form);assert.equal(ui.modal.open,true);assert.equal(form.submit.disabled,false);assert.equal(form.recordFields.disabled,false);
    assert.match(ui.modal.error.textContent,/回执.*不一致|保存结果尚未确认/);assert.match(ui.modal.error.textContent,/原记录可能已经保存/);
    assert.equal(form.values.assignee,'  Field person  ');assert.equal(form.values.note,'  Check again  ');assert.equal(ui.run('fieldTab'),'records');assert.equal(ui.run('visitFilters.timing'),'overdue');assert.equal(ui.run('visits.length'),1);
  }
});

test('uncertain network results support A/B/A retry keys and known duplicate rejections stay readable',async()=>{
  const ui=setup(),form=await openForm(ui);ui.context.post=async(path,body,key)=>{ui.calls.push({path,body:structuredClone(body),key});throw new TypeError('Response lost');};
  await ui.submit(form);await ui.submit(form);form.values.note='Another prompt';await ui.submit(form);form.values.note='  Check again  ';await ui.submit(form);
  assert.equal(ui.calls[0].key,ui.calls[1].key);assert.notEqual(ui.calls[0].key,ui.calls[2].key);assert.equal(ui.calls[0].key,ui.calls[3].key);
  ui.context.post=async()=>{throw new ApiError(409,'已有待完成复查 <existing-task>，请刷新后核对。');};await ui.submit(form);
  assert.equal(ui.modal.form,form);assert.match(ui.modal.error.textContent,/已有待完成复查 <existing-task>/);assert.doesNotMatch(ui.modal.error.textContent,/原记录可能已经保存/);assert.equal(form.recordFields.disabled,false);
});

test('loaded pending follow-ups replace create with their read-only identity; completed ones allow an explicit new form',async()=>{
  const ui=setup();addFollowUp(ui);const html=ui.run('recordCard(verifications[0])');
  assert.match(html,/已有待完成复查/);assert.match(html,/follow-up-1/);assert.match(html,/source\/&lt;report&gt;/);assert.doesNotMatch(html,/data-action="new-follow-up-visit"/);
  await ui.click('new-follow-up-visit',{record:source().id});assert.equal(ui.modal.form,undefined);assert.match(ui.modal.innerHTML,/已有待完成复查/);assert.match(ui.modal.innerHTML,/follow-up-1/);assert.equal(ui.calls.length,0);
  await ui.click('close-dialog');ui.run("visits[1].status='completed'");await openForm(ui);assert.equal(ui.modal.form.id,'follow-up-visit-form');assert.equal(ui.calls.length,0);
});

test('duplicate clicks lock fields; current success resets only unchanged visit filters, not record filters',async()=>{
  for(const changeFilters of [false,true]){
    const ui=setup(),gate=deferred(),form=await openForm(ui);ui.run("visitFilters={timing:'overdue',assignee:'unassigned',parcelId:'p2'};recordFilters.query='Keep record filter';");
    ui.context.post=async(path,body,key)=>{ui.calls.push({path,body:structuredClone(body),key});return gate.promise;};
    const saving=ui.submit(form);assert.equal(form.submit.disabled,true);assert.equal(form.recordFields.disabled,true);await ui.submit(form);assert.equal(ui.calls.length,1);
    if(changeFilters)await ui.app.listeners.change({target:{id:'visit-timing-filter',value:'upcoming'}});gate.resolve(receipt(ui.calls[0].body));await saving;
    assert.equal(ui.modal.open,false);assert.equal(ui.run('fieldTab'),'visits');assert.equal(ui.run('recordFilters.query'),'Keep record filter');assert.equal(form.recordFields.disabled,false);
    assert.equal(ui.run('visitFilters.timing'),changeFilters?'upcoming':'all');assert.equal(ui.run('visitFilters.parcelId'),changeFilters?'p2':'');
  }
});

test('late success or failure cannot close, navigate, overwrite, or clear filters for a replacement form',async()=>{
  for(const succeeds of [false,true]){
    const ui=setup(),gate=deferred(),form=await openForm(ui);ui.context.post=async(path,body,key)=>{ui.calls.push({path,body:structuredClone(body),key});return gate.promise;};
    const saving=ui.submit(form);await ui.click('close-dialog');await ui.click('field-tab',{tab:'parcels'});await ui.click('new-event');const replacement=ui.modal.form;replacement.values.note='Keep this newer event';
    ui.run("visitFilters={timing:'upcoming',assignee:'name:Newer person',parcelId:'p2'};++visitFilterRevision;");
    if(succeeds)gate.resolve(receipt(ui.calls[0].body));else gate.reject(new Error('Old follow-up failed'));await saving;
    assert.equal(ui.modal.open,true);assert.equal(ui.modal.form,replacement);assert.equal(replacement.values.note,'Keep this newer event');assert.equal(ui.modal.error.hidden,true);assert.equal(ui.run('fieldTab'),'parcels');assert.equal(ui.run('visitFilters.assignee'),'name:Newer person');assert.equal(ui.run('visits.length'),1);
    assert.match(ui.toast.textContent,succeeds?/复查任务创建已确认/:/先前表单保存未确认.*Old follow-up failed/);
  }
});

test('replayed creation receipts never downgrade newer or completed loaded tasks when refresh fails',async()=>{
  for(const status of ['pending','completed']){
    const ui=setup(),gate=deferred(),form=await openForm(ui);ui.context.post=async()=>gate.promise;const saving=ui.submit(form);
    ui.context.latest={...followUp(),status,plan_revision:4,due_date:'2026-11-01',assignee:'Latest person'};ui.run("visits.push(latest);refresh=async()=>{loadError='Offline';}");
    gate.resolve(receipt({due_date:'2026-10-22',assignee:'Field person',note:'Check again'}));await saving;
    assert.equal(ui.run('visits[1].status'),status);assert.equal(ui.run('visits[1].plan_revision'),4);assert.equal(ui.run('visits[1].assignee'),'Latest person');assert.equal(ui.run('visits.length'),2);
  }
});

test('task and resulting report provenance stay distinct, and plan edits retain the full source link',async()=>{
  const ui=setup();addFollowUp(ui);ui.run("verifications.push({...sourceRecord,id:'result-record',visit_id:'follow-up-1',note:'New follow-up report'});");
  for(const field of [false,true]){
    const html=ui.run(`visitCard(visits[1],${field})`);assert.match(html,/待复查/);assert.match(html,/复查 · 继续跟进同一候选/);assert.match(html,/source\/&lt;report&gt;/);assert.match(html,/查看上次核查/);assert.doesNotMatch(html,/自主巡田|异常候选核查|view-candidate-evidence/);
  }
  const html=ui.run('recordCard(verifications[1])');assert.match(html,/复查 · 继续跟进同一候选/);assert.match(html,/查看上次核查/);assert.doesNotMatch(html,/自主巡田|异常候选核查|view-record-evidence/);
  await ui.click('edit-visit-plan',{id:'follow-up-1'});const form=ui.modal.form;assert.match(ui.modal.innerHTML,/复查 · 继续跟进同一候选.*source\/&lt;report&gt;/);assert.doesNotMatch(ui.modal.innerHTML,/自主巡田/);
  Object.assign(form.values,{due_date:'2026-11-03',assignee:'Corrected person'});ui.context.post=async(path,body,key)=>{ui.calls.push({path,body,key});return syntheticRecordReceipt(path,body,'follow-up-1',ui.run('visits[1]'));};
  await ui.submit(form);assert.equal(ui.run('visits[1].source_verification_id'),source().id);assert.equal(ui.run('visits[1].risk_id'),'original-risk');assert.equal(ui.run('visits[1].plan_revision'),1);
});

test('read-only source views use only exact loaded sources and distinguish missing or mismatched records without requests',async()=>{
  for(const mode of ['loaded','missing','mismatched']){
    const ui=setup();addFollowUp(ui);if(mode==='missing')ui.run('verifications=[]');if(mode==='mismatched')ui.run("verifications[0].parcel_id='p2';verifications[0].note='Wrong parcel secret'");
    const before=ui.run('JSON.stringify({visits,verifications,drafts})');await ui.click('view-follow-up-source',{id:'follow-up-1'});
    assert.equal(ui.modal.form,undefined);assert.match(ui.modal.innerHTML,/源核查 source\/&lt;report&gt;/);assert.match(ui.modal.innerHTML,/不会生成新的算法候选/);assert.equal(ui.calls.length,0);assert.equal(ui.reads.length,0);
    if(mode==='loaded'){assert.match(ui.modal.innerHTML,/Original &lt;field&gt; observation/);assert.match(ui.modal.innerHTML,/查看上次核查关联候选依据/);}
    else {assert.match(ui.modal.innerHTML,/请关闭后刷新记录/);assert.match(ui.modal.innerHTML,mode==='missing'?/尚未读取或已缺失/:/地块不一致/);assert.doesNotMatch(ui.modal.innerHTML,/Wrong parcel secret|view-record-evidence/);}
    await ui.click('close-dialog');assert.equal(ui.modal.open,false);assert.equal(ui.run('JSON.stringify({visits,verifications,drafts})'),before);
  }
});

test('source-view photo and candidate actions reuse explicit existing handlers and close cleanly',async()=>{
  const ui=setup();addFollowUp(ui);ui.run("verifications[0].photo_ids=['photo/one'];risks=[{id:'original-risk',parcel_id:'p1',observation_id:'original-observation',created_at:'2026-10-16T00:00:00Z',summary:'Original candidate only',method:'statistical',model_version:'old',evidence:{metric:'ndvi',baseline_count:0,limitations:[]}}]");
  await ui.click('view-follow-up-source',{id:'follow-up-1'});assert.match(ui.modal.innerHTML,/data-action="view-record-photo"/);assert.equal(ui.reads.length,0);
  await ui.click('view-record-photo',{record:source().id,photo:'photo/one'});assert.match(ui.modal.innerHTML,/record-photo-viewer/);assert.match(ui.modal.innerHTML,/photo%2Fone/);await ui.click('close-dialog');assert.equal(ui.modal.open,false);
  await ui.click('view-follow-up-source',{id:'follow-up-1'});await ui.click('view-record-evidence',{record:source().id});await turn();
  assert.match(ui.modal.innerHTML,/Original candidate only/);assert.match(ui.modal.innerHTML,/当时保存的算法候选/);assert.deepEqual(ui.reads,['/parcels/p1/observations']);await ui.click('close-dialog');assert.equal(ui.modal.open,false);
});

test('source snapshots escape API text and use own labels instead of prototype keys',async()=>{
  const ui=setup();ui.run("verifications[0].label='constructor';dashboard.parcels[0].name='<script>parcel</script>';dashboard.parcels[0].season='<season>';verifications[0].note='<img src=x onerror=bad>';");
  await openForm(ui);assert.match(ui.modal.innerHTML,/&lt;script&gt;parcel&lt;\/script&gt;/);assert.match(ui.modal.innerHTML,/&lt;season&gt;/);assert.match(ui.modal.innerHTML,/&lt;img src=x onerror=bad&gt;/);assert.match(ui.modal.innerHTML,/>constructor · 用户报告/);assert.doesNotMatch(ui.modal.innerHTML,/<script>|<img src=x|function Object|native code/);
});

test('known source timestamps block pre-source submissions before photos without changing stored drafts',async()=>{
  const ui=setup();addFollowUp(ui);let uploads=0,writes=0;const saved={revision:5,visit_id:'follow-up-1',parcel_id:'p1',parcel_name:'Original parcel',parcel_season:'2026-2027',data_origin:'user',client_submission_id:'original-draft-key',observed_at:'2026-10-16T08:00:00Z',label:'uncertain',note:'Retained draft note',photos:[{key:'photo',name:'local.png',blob:new Blob(['keep me'])}],state:'draft',updated_at:'2026-10-16T10:00:00Z'};
  ui.context.listDrafts=async()=>[saved];ui.context.saveDraft=async()=>{writes++;};ui.context.uploadVerificationDraft=async draft=>{uploads++;return verificationResult(draft);};ui.run('renderDraftPhotos=()=>{}');
  await ui.click('resume-draft',{id:'follow-up-1'});const before=JSON.stringify(saved);assert.equal(writes,0);assert.match(ui.modal.innerHTML,/实际观察时间不能早于/);assert.match(ui.modal.innerHTML,/source\/&lt;report&gt;/);
  await ui.submit();assert.equal(uploads,0);assert.equal(writes,0);assert.equal(JSON.stringify(saved),before);assert.equal(await saved.photos[0].blob.text(),'keep me');assert.match(ui.modal.error.textContent,/不能早于上次核查/);assert.equal(ui.run('currentDraft.client_submission_id'),'original-draft-key');
  ui.run("currentDraft.observed_at='2026-10-17T08:00:00Z'");assert.equal(ui.run('verificationTimeError(currentDraft)'),'', 'an equal instant is permitted');
});

test('missing or mismatched source metadata does not guess dates or block offline draft viewing and editing',async()=>{
  for(const mode of ['missing','mismatched']){
    const ui=setup();addFollowUp(ui);if(mode==='missing')ui.run('verifications=[]');else ui.run("verifications[0].parcel_id='p2'");
    const draft={visit_id:'follow-up-1',parcel_id:'p1',parcel_name:'Saved parcel',parcel_season:'2026-2027',data_origin:'user',client_submission_id:'unchanged-key',observed_at:'2026-10-16T08:00:00Z',label:'uncertain',note:'Existing report',photos:[],state:'draft',updated_at:'2026-10-16T08:00:00Z',revision:1};
    let writes=0;ui.context.listDrafts=async()=>[draft];ui.context.saveDraft=async()=>{writes++;};await ui.click('resume-draft',{id:'follow-up-1'});
    assert.match(ui.modal.innerHTML,/上次观察时间尚未读取/);assert.equal(ui.run('verificationTimeError(currentDraft)'),'');assert.equal(writes,0);assert.equal(ui.reads.length,0);assert.equal(ui.calls.length,0);assert.equal(ui.run('currentDraft.observed_at'),'2026-10-16T08:00:00Z');
    await ui.modal.listeners.input({target:{name:'note',value:'Edited offline report',closest:()=>({})}});await ui.run('saving');assert.equal(ui.run('currentDraft.note'),'Edited offline report');assert.equal(ui.run('currentDraft.client_submission_id'),'unchanged-key');
  }
});


test('source chains advance one hop per explicit click and retain missing earlier identities without requests',async()=>{
  const ui=setup();addFollowUp(ui);
  ui.run("visits[1].risk_id=null;sourceRecord.risk_id=null;visits[0].risk_id=null;visits[0].source_verification_id='earliest/<record>';sourceRecord.source_verification_id='earliest/<record>';verifications.push({...sourceRecord,id:'earliest/<record>',visit_id:'earliest-visit',source_verification_id:null,note:'Earliest field report'});visits.push({id:'earliest-visit',parcel_id:'p1',status:'completed'});");
  await ui.click('view-follow-up-source',{id:'follow-up-1'});
  assert.match(ui.modal.innerHTML,/源核查 source\/&lt;report&gt;/);assert.match(ui.modal.innerHTML,/更早源核查 earliest\/&lt;record&gt;/);assert.match(ui.modal.innerHTML,/查看更早来源核查/);assert.doesNotMatch(ui.modal.innerHTML,/Earliest field report|view-record-evidence/);assert.equal(ui.reads.length,0);
  await ui.click('view-follow-up-source',{id:'original-visit'});assert.match(ui.modal.innerHTML,/源核查 earliest\/&lt;record&gt;/);assert.match(ui.modal.innerHTML,/Earliest field report/);assert.equal(ui.reads.length,0);assert.equal(ui.calls.length,0);
  await ui.click('close-dialog');ui.run('verifications.pop()');await ui.click('view-follow-up-source',{id:'follow-up-1'});await ui.click('view-follow-up-source',{id:'original-visit'});
  assert.match(ui.modal.innerHTML,/earliest\/&lt;record&gt;/);assert.match(ui.modal.innerHTML,/尚未读取或已缺失/);assert.equal(ui.reads.length,0);await ui.click('close-dialog');assert.equal(ui.modal.open,false);
});

test('conflicting source and risk links do not inherit candidate priority, evidence, or source-time certainty',async()=>{
  const ui=setup();addFollowUp(ui);ui.run("visits[1].risk_id='foreign-risk';risks=[{id:'foreign-risk',parcel_id:'p1',priority:'high',summary:'Do not inherit this candidate'}]");
  const card=ui.run('visitCard(visits[1])');assert.match(card,/来源关系待核对/);assert.doesNotMatch(card,/Do not inherit this candidate|优先核查|view-candidate-evidence/);
  await ui.click('view-follow-up-source',{id:'follow-up-1'});assert.match(ui.modal.innerHTML,/来源关系不一致/);assert.doesNotMatch(ui.modal.innerHTML,/Original &lt;field&gt; observation|view-record-evidence/);assert.equal(ui.reads.length,0);
});

test('source receipt binds inherited event from exact original task when the legacy report omits its risk field', async () => {
  const ui=setup();ui.run('delete verifications[0].risk_id');const form=await openForm(ui);
  const snapshot=ui.run('followUpSnapshots.get(modal.form).record.risk_id');assert.equal(snapshot,'original-risk');
  ui.run("visits[0].risk_id='changed-cache-risk'");await ui.submit(form);
  assert.equal(ui.modal.open,false);assert.equal(ui.calls.length,1);assert.match(ui.toast.textContent,/复查任务创建已确认/);
});

test('contradictory source report and task refuse opening a follow-up form; an old null-risk replay remains unconfirmed', async () => {
  for(const mutate of ["verifications[0].risk_id='foreign-risk'", "visits[0].parcel_id='p2'", "visits.push({...visits[0]})"]){
    const ui=setup();ui.run(mutate);await ui.click('new-follow-up-visit',{record:source().id});
    assert.equal(ui.modal.open,false);assert.equal(ui.calls.length,0);assert.match(ui.toast.textContent,/不一致|无法确认/);
  }
  const ui=setup(),form=await openForm(ui);ui.context.post=async(path,body,key)=>{ui.calls.push({path,body,key});return receipt(body,{risk_id:null});};
  await ui.submit(form);await ui.submit(form);assert.equal(ui.modal.form,form);assert.equal(ui.modal.open,true);
  assert.match(ui.modal.error.textContent,/尚未确认/);assert.equal(ui.calls[0].key,ui.calls[1].key);
});

test('same-event follow-up retains source-time validation and exposes source and original candidate without writes', async () => {
  const ui=setup();addFollowUp(ui);ui.run("risks=[{id:'original-risk',parcel_id:'p1',priority:'high',summary:'Same original event'}]");
  const card=ui.run('visitCard(visits[1])');assert.match(card,/继续跟进同一候选/);assert.match(card,/view-candidate-evidence/);
  await ui.click('view-follow-up-source',{id:'follow-up-1'});
  assert.match(ui.modal.innerHTML,/Original &lt;field&gt; observation/);assert.match(ui.modal.innerHTML,/view-record-evidence/);assert.doesNotMatch(ui.modal.innerHTML,/来源关系不一致/);
  assert.match(ui.run("verificationTimeError({visit_id:'follow-up-1',parcel_id:'p1',observed_at:'2026-10-16T00:00:00Z'})"),/不能早于上次核查/);
  assert.equal(ui.calls.length,0);assert.equal(ui.reads.length,0);
});

test('pending follow-up matching requires the same parcel and consistent source/event instead of risk text alone', async () => {
  for(const mode of ['foreign-parcel','foreign-event','missing-source','missing-risk','foreign-risk-parcel']){
    const ui=setup();ui.run("risks=[{id:'original-risk',parcel_id:'p1'}];visits.push({...followUp,id:'other-pending',source_verification_id:'another-source'});verifications.push({...sourceRecord,id:'another-source',visit_id:'another-completed'});visits.push({id:'another-completed',parcel_id:'p1',risk_id:'original-risk',status:'completed'});");
    if(mode==='foreign-parcel')ui.run("visits[1].parcel_id='p2'");
    if(mode==='foreign-event')ui.run("visits[2].risk_id='foreign-risk'");
    if(mode==='missing-source')ui.run('verifications.pop()');
    if(mode==='missing-risk')ui.run('risks=[]');
    if(mode==='foreign-risk-parcel')ui.run("risks[0].parcel_id='p2'");
    const html=ui.run('followUpAction(verifications[0])');assert.match(html,/new-follow-up-visit/,mode);assert.doesNotMatch(html,/other-pending/,mode);
  }
  const ui=setup();ui.run("risks=[{id:'original-risk',parcel_id:'p1'}];visits.push({...followUp,id:'other-pending',source_verification_id:'another-source'});verifications.push({...sourceRecord,id:'another-source',visit_id:'another-completed'});visits.push({id:'another-completed',parcel_id:'p1',risk_id:'original-risk',status:'completed'});");
  const html=ui.run('followUpAction(verifications[0])');assert.match(html,/other-pending/);assert.match(html,/源核查 another-source/);assert.doesNotMatch(html,/源核查 source\/&lt;report&gt;/);
  await ui.click('new-follow-up-visit',{record:source().id});assert.equal(ui.modal.form,undefined);assert.match(ui.modal.innerHTML,/已有待完成复查/);assert.equal(ui.calls.length,0);
});

function setupUnlinkedChain(pathname='/field') {
  const ui=setup(pathname);
  ui.run("sourceRecord.risk_id=null;visits[0].risk_id=null;risks=[];visits.push({...followUp,id:'completed-follow-up',risk_id:null,status:'completed'});verifications.push({...sourceRecord,id:'descendant-report',visit_id:'completed-follow-up',source_verification_id:sourceRecord.id});visits.push({...followUp,id:'pending-descendant',risk_id:null,source_verification_id:'descendant-report'});");
  return ui;
}

test('all loaded reports in a no-candidate chain point to the pending descendant without requests', async () => {
  for(const pathname of ['/admin','/field']){
    const ui=setupUnlinkedChain(pathname),before=ui.run('JSON.stringify({visits,verifications,risks})');
    for(const index of [0,1]){
      assert.equal(ui.run(`pendingFollowUp(verifications[${index}])?.id`),'pending-descendant');
      const html=ui.run(`followUpAction(verifications[${index}])`);
      assert.match(html,/已有待完成复查/);assert.match(html,/pending-descendant/);assert.doesNotMatch(html,/new-follow-up-visit/);
    }
    await ui.click('new-follow-up-visit',{record:source().id});
    assert.equal(ui.modal.form,undefined);assert.match(ui.modal.innerHTML,/已有待完成复查/);assert.match(ui.modal.innerHTML,/pending-descendant/);
    assert.equal(ui.calls.length,0);assert.equal(ui.reads.length,0);assert.equal(ui.run('JSON.stringify({visits,verifications,risks})'),before);
    await ui.click('close-dialog');ui.run("visits[2].status='completed'");
    assert.match(ui.run('followUpAction(verifications[0])'),/new-follow-up-visit/);
  }
});

test('no-candidate matching follows a shared root for earlier sources and historical branches, not just direct descendants', () => {
  const ui=setupUnlinkedChain();
  ui.run("visits[2].source_verification_id=sourceRecord.id;visits.push({...followUp,id:'completed-sibling',risk_id:null,status:'completed'});verifications.push({...sourceRecord,id:'sibling-report',visit_id:'completed-sibling',source_verification_id:sourceRecord.id});");
  for(const index of [0,1,2])assert.equal(ui.run(`pendingFollowUp(verifications[${index}])?.id`),'pending-descendant');
  ui.run("visits.push({id:'independent-visit',parcel_id:'p1',risk_id:null,status:'completed'});verifications.push({...sourceRecord,id:'independent-report',visit_id:'independent-visit',source_verification_id:null});");
  assert.equal(ui.run('pendingFollowUp(verifications[3])'),undefined,'shared parcel, label and note are not lineage');
  assert.equal(ui.calls.length,0);assert.equal(ui.reads.length,0);
});

test('no-candidate chain matching stops at missing, duplicate, cyclic, cross-parcel or candidate-bearing edges', () => {
  for(const mutate of [
    'verifications.splice(1,1)', 'visits.splice(1,1)',
    'verifications.push({...verifications[1]})', 'visits.push({...visits[1]})', 'visits.push({...visits[2]})',
    "visits[1].parcel_id='p2'", "verifications[1].parcel_id='p2'", "visits[2].parcel_id='p2'",
    "visits[1].status='pending'", "visits[1].risk_id='unrelated-risk';verifications[1].risk_id='unrelated-risk'",
    "visits[0].source_verification_id='missing-ancestor';verifications[0].source_verification_id='missing-ancestor'",
    "visits[0].source_verification_id='descendant-report';verifications[0].source_verification_id='descendant-report'",
    "visits[1].source_verification_id='descendant-report';verifications[1].source_verification_id='descendant-report'",
  ]){
    const ui=setupUnlinkedChain();ui.run(mutate);
    const matched=ui.run('pendingFollowUp(verifications[0])?.id');
    assert.notEqual(matched,'pending-descendant',mutate);
    assert.equal(ui.calls.length,0);assert.equal(ui.reads.length,0);
  }
});

test('follow-up confirmation describes assigned candidate and unresolved reports with the shared pending-work limit', async () => {
  const ui=setup();await openForm(ui);
  assert.match(ui.modal.innerHTML,/若关联原候选[\s\S]*已安排巡田/);
  assert.match(ui.modal.innerHTML,/事件仍未解决[\s\S]*既有报告仍待复核/);
  assert.match(ui.modal.innerHTML,/同一候选事件或报告链只允许一个待完成任务/);
  assert.doesNotMatch(ui.modal.innerHTML,/不更改原记录或原候选状态|每条源核查只能有一个待完成复查/);
});
