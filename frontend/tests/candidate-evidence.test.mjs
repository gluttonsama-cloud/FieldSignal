import test from 'node:test';
import assert from 'node:assert/strict';
import * as display from '../src/display.ts';
import * as sourceView from '../src/sources.ts';
import { candidateObservations, recordCandidate } from '../src/candidate-evidence.ts';
import { harness, deferred, turn } from './helpers/ui-harness.mjs';

const risk=()=>({id:'risk-<old>',parcel_id:'p1',observation_id:'trigger',status:'verified',priority:'high',summary:'NDVI下降原因待核实',method:'statistical',model_version:'saved-version-1',created_at:'2026-10-10T08:00:00Z',evidence:{metric:'ndvi',latest_value:0.3,baseline_median:0.7,baseline_mad:0.01,absolute_drop:0.4,score:13.333333,baseline_count:2,baseline_observation_ids:['base-1','base-2'],latest_observation_id:'trigger',window_days:90,limitations:['合成测试候选，不代表真实农情']}});
const observation=(id,ndvi=0.7)=>({id,parcel_id:'p1',observed_at:id==='trigger'?'2026-10-10T06:00:00Z':'2026-09-10T06:00:00Z',source:'sentinel2',source_record_id:`source-${id}`,features:{ndvi},quality:{usable:true,valid_fraction:0.95,cloud_fraction:0.05,flags:[]},provenance:{provider:'Synthetic test provider',collection:'TEST-ONLY',item_id:id,processing_version:'original-processor',retrieved_at:'2026-10-10T07:00:00Z',usage_scope:'parcel'},data_origin:'fixture',created_at:'2026-10-10T07:30:00Z'});
const rows=()=>[observation('newer-unrelated',0.9),observation('base-2'),observation('trigger',0.3),observation('base-1')];
function setup(pathname='/admin'){
  const ui=harness({pathname});Object.assign(ui.context,display,sourceView,{savedRisk:risk()});
  ui.run(`risks=[savedRisk]; visits=[{id:'v1',parcel_id:'p1',risk_id:savedRisk.id,status:'completed'}];verifications=[{id:'record-1',visit_id:'v1',parcel_id:'p1',observed_at:'2026-10-11T06:00:00Z',created_at:'2026-10-11T08:00:00Z',label:'normal',note:'现场未见明显异常',photo_ids:[]}];selectedId='p2';`);
  return ui;
}

test('completed candidate evidence stays reachable in both record views and uses only its saved observations and original parcel',async()=>{
  for(const pathname of ['/admin','/field']){
    const ui=setup(pathname),requests=[];let draftReads=0,draftWrites=0,renders=0;
    Object.assign(ui.context,{api:async path=>{requests.push(path);return rows();},listDrafts:async()=>{draftReads++;return [];},saveDraft:async()=>{draftWrites++;},trackRender:()=>{renders++;}});ui.run('render=trackRender');
    const before=ui.run('JSON.stringify({risks,visits,verifications})');
    assert.match(ui.run('recordCard(verifications[0])'),/查看关联候选依据/);
    assert.match(ui.run('riskCard(risks[0])'),/查看原始观测依据/);
    await ui.click('view-record-evidence',{record:'record-1'});await turn();
    assert.deepEqual(requests,['/parcels/p1/observations']);assert.equal(ui.run('selectedId'),'p2');
    assert.match(ui.modal.innerHTML,/现场核查记录[\s\S]*未见明显异常[\s\S]*用户报告 · 非确诊[\s\S]*当时保存的算法候选/);
    assert.match(ui.modal.innerHTML,/risk-&lt;old&gt;/);assert.match(ui.modal.innerHTML,/saved-version-1/);assert.match(ui.modal.innerHTML,/当时分数（非概率）/);assert.match(ui.modal.innerHTML,/13\.333333/);assert.match(ui.modal.innerHTML,/不根据后续反馈修改当时结论/);
    const html=ui.modal.candidateObservations.innerHTML;
    assert.match(html,/触发观测[\s\S]*source-trigger[\s\S]*当时使用的基线观测[\s\S]*source-base-1[\s\S]*source-base-2/);
    assert.match(html,/原始观测时间/);assert.match(html,/本地入库时间/);assert.match(html,/original-processor/);assert.match(html,/质量声明/);assert.match(html,/开发模拟记录/);assert.doesNotMatch(html,/newer-unrelated/);
    await ui.click('close-dialog');assert.equal(ui.modal.open,false);assert.equal(draftReads,0);assert.equal(draftWrites,0);assert.equal(renders,0);
    assert.equal(ui.run('JSON.stringify({risks,visits,verifications})'),before);
  }
});

test('routine, missing and mismatched record relationships are explicit without reading another candidate',async()=>{
  const ui=setup();let reads=0;ui.context.api=async()=>{reads++;return rows();};
  ui.run('delete visits[0].risk_id');await ui.click('view-record-evidence',{record:'record-1'});
  assert.match(ui.modal.innerHTML,/自主巡田，未关联异常候选/);assert.doesNotMatch(ui.modal.innerHTML,/当时保存的算法候选/);await ui.click('close-dialog');
  ui.run("visits[0].risk_id='missing'");await ui.click('view-record-evidence',{record:'record-1'});assert.match(ui.modal.innerHTML,/关联候选 missing 尚未读取或已缺失/);assert.equal(reads,0);
  const record={visit_id:'v1',parcel_id:'p1'};
  assert.match(recordCandidate(record,[],[risk()]).message,/巡田任务尚未读取/);
  assert.match(recordCandidate(record,[{id:'v1',parcel_id:'p2',risk_id:risk().id}],[risk()]).message,/巡田任务与核查记录的地块不一致/);
  assert.match(recordCandidate(record,[{id:'v1',parcel_id:'p1',risk_id:risk().id}],[{...risk(),parcel_id:'p2'}]).message,/候选与核查记录的地块不一致/);
});

test('pending field tasks expose their own candidate evidence before starting verification, without inventing a routine or mismatched association',async()=>{
  const ui=setup('/field'),requests=[];
  ui.run("visits[0].status='pending';visits[0].due_date='2026-10-18';risks[0].status='assigned'");
  ui.context.api=async path=>{requests.push(path);return rows();};
  const before=ui.run('JSON.stringify({visits,risks,drafts})');
  for(const field of [true,false]){
    const html=ui.run(`visitCard(visits[0],${field})`);
    assert.match(html,/data-action="view-candidate-evidence" data-id="risk-&lt;old&gt;"/);assert.match(html,/查看候选依据/);
  }
  assert.equal(requests.length,0,'rendering a task must not fetch evidence');
  await ui.click('view-candidate-evidence',{id:risk().id});await turn();
  assert.deepEqual(requests,['/parcels/p1/observations']);assert.match(ui.modal.candidateObservations.innerHTML,/source-trigger/);assert.equal(ui.modal.form,undefined);
  await ui.click('close-dialog');assert.equal(ui.run('JSON.stringify({visits,risks,drafts})'),before);
  assert.doesNotMatch(ui.run('visitCard({...visits[0],risk_id:undefined})'),/view-candidate-evidence/);
  assert.doesNotMatch(ui.run("visitCard({...visits[0],risk_id:'not-loaded'})"),/view-candidate-evidence/);
  assert.doesNotMatch(ui.run("visitCard({...visits[0],parcel_id:'p2'})"),/view-candidate-evidence/);
});

test('missing or inconsistent original references remain missing, with no baseline reconstruction or cross-parcel substitution',()=>{
  const r=risk(),original=JSON.stringify(r),render=item=>`<p>EXACT ${item.id}</p>`;
  const html=candidateObservations(r,[observation('base-1'),{...observation('base-2'),parcel_id:'p2'},observation('newer-unrelated')],render);
  assert.match(html,/trigger 缺失或本次未读取到/);assert.match(html,/EXACT base-1/);assert.match(html,/base-2 的地块或用途不匹配/);assert.doesNotMatch(html,/EXACT base-2|newer-unrelated/);
  const legacy={...r,evidence:{...r.evidence,baseline_observation_ids:undefined}};
  assert.match(candidateObservations(legacy,rows(),render),/没有可读取的已存基线编号/);
  r.evidence.latest_observation_id='different-trigger';r.evidence.baseline_observation_ids=['base-1','base-1','trigger'];
  const inconsistent=candidateObservations(r,rows(),render);
  assert.match(inconsistent,/触发观测编号不一致/);assert.match(inconsistent,/基线编号缺失、不完整或不一致/);assert.doesNotMatch(inconsistent,/EXACT trigger/);assert.equal((inconsistent.match(/EXACT base-1/g)||[]).length,1);
  assert.equal(JSON.stringify(risk()),original);
});

test('read failures allow explicit retry; close, Escape and reopened sessions cannot receive a previous read',async()=>{
  const ui=setup(),pending=[];let calls=0;
  ui.context.api=()=>{calls++;const d=deferred();pending.push(d);return d.promise;};
  await ui.click('view-record-evidence',{record:'record-1'});const first=ui.modal.candidateObservations;
  const duplicate=ui.click('retry-candidate-evidence');await duplicate;assert.equal(calls,1);
  pending[0].reject(new Error('Synthetic 503'));await turn();assert.match(first.innerHTML,/原观测读取失败/);assert.match(first.innerHTML,/不能将读取失败视为没有观测/);
  const retry=ui.click('retry-candidate-evidence');assert.equal(calls,2);
  await ui.click('close-dialog');await ui.click('view-candidate-evidence',{id:risk().id});const second=ui.modal.candidateObservations;
  pending[1].resolve(rows());await retry;assert.match(second.innerHTML,/正在读取/);assert.equal(ui.modal.open,true);
  let prevented=false;ui.modal.listeners.cancel({preventDefault(){prevented=true;}});assert.equal(prevented,false);ui.modal.close();
  await ui.click('view-candidate-evidence',{id:risk().id});const third=ui.modal.candidateObservations;
  pending[2].reject(new Error('Old read failure'));await turn();assert.match(third.innerHTML,/正在读取/);
  // The displayed risk snapshot stays frozen while a background refresh updates the cache.
  ui.run("risks[0].evidence.baseline_observation_ids=['newer-unrelated'];risks[0].evidence.score=999");
  pending[3].resolve(rows());await turn();assert.match(third.innerHTML,/source-base-1/);assert.doesNotMatch(third.innerHTML,/newer-unrelated/);assert.doesNotMatch(ui.modal.innerHTML,/999/);
});
