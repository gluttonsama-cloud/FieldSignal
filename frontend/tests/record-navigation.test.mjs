import test from 'node:test';
import assert from 'node:assert/strict';
import * as display from '../src/display.ts';
import { harness, deferred, turn, verificationResult } from './helpers/ui-harness.mjs';

function fieldUi(pathname='/field') {
  const ui=harness({pathname}),calls=[];
  Object.assign(ui.context,display);
  ui.context.api=async path=>{calls.push(path);return path==='/dashboard'?structuredClone(ui.run('dashboard')):path==='/health'?{}:path==='/verifications'?structuredClone(ui.run('verifications')):path==='/visits'?structuredClone(ui.run('visits')):[];};
  ui.context.uploadVerificationDraft=async draft=>verificationResult(draft);
  ui.run("render=()=>{document.querySelector('#app').innerHTML=renderField();}; refresh=realRefresh; loading=false; connected=true; dashboard.parcels.forEach(p=>Object.assign(p,{region:'other',season:'2026-2027'}));visits.forEach(v=>Object.assign(v,{status:'pending',due_date:'2026-10-18'}));");
  return {...ui,calls};
}

async function openSecond(ui,resumed=false) {
  if(resumed)ui.context.listDrafts=async()=>[{visit_id:'v2',parcel_id:'p2',parcel_name:'Parcel two',data_origin:'user',client_submission_id:'resumed',observed_at:'2026-10-18T12:00:00Z',label:'uncertain',note:'Resumed field report',photos:[],state:'draft',updated_at:'2026-10-18T12:00:00Z',revision:1}];
  await ui.click(resumed?'resume-draft':'verify',{id:'v2'});
  ui.run("currentDraft.note='Acknowledged report for parcel two'");
}

test('confirmed new and resumed visits open their own parcel records, even if the following list refresh fails',async()=>{
  for(const resumed of [false,true]){
    const ui=fieldUi();await openSecond(ui,resumed);
    ui.run("recordFilters={query:'Old report',label:'normal',from:'2020-01-01',to:'2020-01-02',parcelId:''};recordFilterInputs={...recordFilters,query:'Earlier unapplied search'};");
    if(resumed)ui.context.api=async()=>{throw new Error('List refresh unavailable');};
    await ui.submit();
    assert.equal(ui.run('selectedId'),'p2');assert.equal(ui.run('fieldTab'),'records');assert.equal(ui.modal.open,false);
    assert.match(ui.app.innerHTML,/Acknowledged report for parcel two/);assert.doesNotMatch(ui.app.innerHTML,/暂无核查记录/);
    assert.equal(ui.run("visits.find(v=>v.id==='v2').status"),'completed');
    assert.equal(ui.run("verifications.filter(v=>v.id==='record-v2').length"),1);
    assert.equal(ui.run('JSON.stringify(recordFilters)'),ui.run('JSON.stringify(defaultRecordFilters())'));
    assert.equal(ui.run('JSON.stringify(recordFilterInputs)'),ui.run('JSON.stringify(defaultRecordFilters())'));
    if(resumed)assert.match(ui.app.innerHTML,/List refresh unavailable/);
  }
});

test('successful navigation clears cached and pending details from the previous parcel before a failed or stalled refresh',async()=>{
  for(const fails of [false,true]){
    const ui=fieldUi(),oldDetail=deferred(),refreshGate=deferred();
    const observation={id:'old-optical',parcel_id:'p1',source:'s2',observed_at:'2026-10-18T12:00:00Z',features:{ndvi:0.87},quality:{usable:true,valid_fraction:1,flags:[]}};
    ui.context.oldObservation=observation;
    ui.context.api=async path=>path.endsWith('/observations')?oldDetail.promise:[];
    const oldRead=ui.run('loadDetail()');
    ui.run("observations=[oldObservation];analyses=[{id:'old-analysis',parcel_id:'p1',message:'Old parcel analysis'}]");
    await openSecond(ui);
    ui.context.api=async()=>{if(fails)throw new Error('Refresh failed');return refreshGate.promise;};
    const done=ui.submit();await turn();
    oldDetail.resolve([observation]);await oldRead;
    assert.equal(ui.run('selectedId'),'p2');assert.equal(ui.run('observations.length'),0);assert.equal(ui.run('analyses.length'),0);
    await ui.click('field-tab',{tab:'parcels'});
    assert.match(ui.app.innerHTML,/Parcel two/);assert.match(ui.app.innerHTML,/此地块详情尚未读取/);assert.doesNotMatch(ui.app.innerHTML,/0\.87|Old parcel analysis/);
    if(!fails)refreshGate.reject(new Error('Stalled refresh stopped'));await done;
  }
});

test('unconfirmed submission keeps the original editor, selection and navigation without a new saved record',async()=>{
  const ui=fieldUi();await openSecond(ui);const original=ui.run('currentDraft.client_submission_id');
  ui.run("recordFilters.query='Existing search';recordFilterInputs.query='Unapplied search'");
  ui.context.uploadVerificationDraft=async()=>{throw new Error('Response not confirmed');};await ui.submit();
  assert.equal(ui.run('selectedId'),'p1');assert.equal(ui.run('fieldTab'),'visits');assert.equal(ui.modal.open,true);
  assert.equal(ui.run('currentDraft.client_submission_id'),original);assert.equal(ui.run('verifications.length'),0);
  assert.equal(ui.run("visits.find(v=>v.id==='v2').status"),'pending');assert.match(ui.modal.error.textContent,/Response not confirmed/);
  assert.equal(ui.run('recordFilters.query'),'Existing search');assert.equal(ui.run('recordFilterInputs.query'),'Unapplied search');
});

test('confirmed verification does not clear newer record-filter edits or applied choices while upload is pending',async()=>{
  for(const action of ['input','apply','clear']){
    const ui=fieldUi(),pending=deferred();await openSecond(ui);
    ui.run("recordFilters.query='Existing search';recordFilterInputs.query='Existing search'");
    ui.context.uploadVerificationDraft=async draft=>{await pending.promise;return verificationResult(draft);};
    const done=ui.submit();await turn();
    if(action==='input')ui.app.listeners.input({target:{id:'record-query',value:'New unapplied search',closest:()=>({})}});
    else if(action==='apply')await ui.app.listeners.submit({target:{id:'record-filter-form',values:{query:'New applied search'},reportValidity:()=>true},preventDefault(){}});
    else await ui.click('clear-record-filters');
    const applied=ui.run('JSON.stringify(recordFilters)'),draft=ui.run('JSON.stringify(recordFilterInputs)');
    pending.resolve();await done;
    assert.equal(ui.run('JSON.stringify(recordFilters)'),applied);assert.equal(ui.run('JSON.stringify(recordFilterInputs)'),draft);
    assert.equal(ui.run("verifications.filter(v=>v.id==='record-v2').length"),1);
  }
});

test('late submission success or failure does not navigate, close or overwrite a newer interaction',async()=>{
  for(const succeeds of [false,true]){
    const ui=fieldUi(),pending=deferred();await openSecond(ui);
    ui.context.uploadVerificationDraft=async draft=>{await pending.promise;return verificationResult(draft);};
    const done=ui.submit();await turn();
    await ui.click('field-tab',{tab:'parcels'});await ui.click('new-event');const newer=ui.modal.form,submitText=newer.submit.textContent;
    ui.run("recordFilters.query='Newer interaction filter';recordFilterInputs.query='Newer interaction input'");
    newer.values.note='New event note';
    if(succeeds)pending.resolve();else pending.reject(new Error('Old upload failed'));await done;
    assert.equal(ui.run('selectedId'),'p1');assert.equal(ui.run('fieldTab'),'parcels');
    assert.equal(ui.modal.open,true);assert.equal(ui.modal.form,newer);assert.match(ui.modal.innerHTML,/记一笔农事/);
    assert.equal(newer.values.note,'New event note');assert.equal(newer.submit.textContent,submitText);assert.equal(ui.modal.error.hidden,true);
    assert.equal(ui.run('recordFilters.query'),'Newer interaction filter');assert.equal(ui.run('recordFilterInputs.query'),'Newer interaction input');
    if(succeeds){
      assert.equal(ui.run("verifications[0].parcel_id"),'p2');
      assert.equal(ui.run('currentDraft'),undefined,'a confirmed, cleared draft must not be re-saved when the newer form closes');
    }else{
      assert.equal(ui.run('verifications.length'),0);assert.match(ui.toast.textContent,/先前核查提交未确认.*Old upload failed/);
      assert.equal(ui.run('currentDraft.note'),'Acknowledged report for parcel two');
    }
    await ui.click('close-dialog');assert.equal(ui.modal.open,false);
  }
});

test('farm history renders independently while unrelated observation reads stall or fail',async()=>{
  const ui=fieldUi(),observation=deferred();ui.run("fieldTab='records'");
  ui.context.api=async path=>path.endsWith('/observations')?observation.promise:path.endsWith('/events')?[{id:'event-one',parcel_id:'p1',kind:'drainage',occurred_on:'2026-10-17',note:'Confirmed drainage record'}]:[];
  const done=ui.run('loadDetail()');await turn();
  assert.match(ui.app.innerHTML,/Confirmed drainage record/);assert.doesNotMatch(ui.app.innerHTML,/暂无农事记录/);
  observation.reject(new Error('Observations unavailable'));await done;
  assert.match(ui.app.innerHTML,/Confirmed drainage record/);assert.equal(ui.run('detailError'),'Observations unavailable');
});

test('farm history distinguishes pending, failed, retry-success and confirmed empty responses',async()=>{
  const ui=fieldUi(),events=deferred();ui.run("fieldTab='records'");
  ui.context.api=async path=>path.endsWith('/events')?events.promise:[];
  const done=ui.run('loadDetail()');assert.match(ui.app.innerHTML,/正在读取农事记录/);assert.doesNotMatch(ui.app.innerHTML,/暂无农事记录/);
  events.reject(new Error('<failed history>'));await done;
  assert.match(ui.app.innerHTML,/农事记录未能读取/);assert.match(ui.app.innerHTML,/&lt;failed history&gt;/);assert.doesNotMatch(ui.app.innerHTML,/暂无农事记录/);
  ui.context.api=async()=>[];await ui.click('refresh-detail');
  assert.match(ui.app.innerHTML,/暂无农事记录/);assert.doesNotMatch(ui.app.innerHTML,/农事记录未能读取/);
});

test('another parcel never renders old farm events or accepts an older response',async()=>{
  const ui=fieldUi(),old=deferred();ui.run("fieldTab='records'");
  ui.context.api=async path=>path==='/parcels/p1/events'?old.promise:path==='/parcels/p2/events'?[{id:'new',parcel_id:'p2',kind:'other',occurred_on:'2026-10-18',note:'Parcel two history'}]:[];
  const done=ui.run('loadDetail()');ui.run("selectedId='p2'");
  assert.match(ui.run('fieldRecords()'),/此地块农事记录尚未读取/);
  await ui.run('loadDetail()');old.resolve([{id:'old',parcel_id:'p1',note:'Wrong parcel history'}]);await done;
  assert.match(ui.app.innerHTML,/Parcel two history/);assert.doesNotMatch(ui.app.innerHTML,/Wrong parcel history/);
});

test('admin parcel details show the same read-only farm history without hiding pending or failed reads',async()=>{
  const ui=fieldUi('/admin'),observation=deferred(),events=deferred(),calls=[];
  ui.run("render=()=>{document.querySelector('#app').innerHTML=parcelDetail(selected());}");
  ui.context.api=async path=>{calls.push(path);return path.endsWith('/observations')?observation.promise:path.endsWith('/events')?events.promise:[];};
  const read=ui.run('loadDetail()');
  assert.match(ui.app.innerHTML,/农事记录 · 当前地块/);assert.match(ui.app.innerHTML,/正在读取农事记录/);assert.doesNotMatch(ui.app.innerHTML,/暂无农事记录/);
  events.resolve([{id:'event-p1',parcel_id:'p1',kind:'drainage',occurred_on:'2026-10-17',note:'Original drainage <record>'}]);await turn();
  assert.match(ui.app.innerHTML,/Original drainage &lt;record&gt;/);assert.match(ui.app.innerHTML,/不作为异常成因结论/);assert.doesNotMatch(ui.app.innerHTML,/data-action="new-event"/);
  assert.deepEqual(calls,['/parcels/p1/observations','/parcels/p1/analyses','/parcels/p1/events'],'the view adds no new network requests');
  observation.reject(new Error('Optical read unavailable'));await read;assert.match(ui.app.innerHTML,/Original drainage &lt;record&gt;/);
  ui.run("selectedId='p2';render()");assert.doesNotMatch(ui.app.innerHTML,/Original drainage/);assert.match(ui.app.innerHTML,/此地块农事记录尚未读取/);
  ui.context.api=async path=>{if(path.endsWith('/events'))throw new Error('Synthetic event read failure');return [];};await ui.run('loadDetail()');
  assert.match(ui.app.innerHTML,/农事记录未能读取.*Synthetic event read failure/);assert.doesNotMatch(ui.app.innerHTML,/暂无农事记录|Original drainage/);
  ui.context.api=async()=>[];await ui.click('refresh-detail');assert.match(ui.app.innerHTML,/暂无农事记录/);assert.doesNotMatch(ui.app.innerHTML,/农事记录未能读取/);
});
