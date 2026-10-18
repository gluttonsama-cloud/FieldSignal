import { esc } from './display.ts';
import { utcTime } from './sources.ts';
import type { Observation, Risk, Verification, Visit } from './types';

// Follow the saved relationship, never the currently selected parcel or newest risk.
export function recordCandidate(record: Verification, visits: Visit[], risks: Risk[]): { risk?: Risk; message?: string } {
  const visit=visits.find(item=>item.id===record.visit_id);
  if(!visit)return {message:'关联巡田任务尚未读取，无法确认候选关联。请关闭并刷新记录后重试。'};
  if(visit.parcel_id!==record.parcel_id)return {message:'巡田任务与核查记录的地块不一致，未展示候选依据。'};
  if(!visit.risk_id)return {message:'自主巡田，未关联异常候选；没有算法候选依据。现场反馈仍保存在原核查记录中。'};
  const risk=risks.find(item=>item.id===visit.risk_id);
  if(!risk)return {message:`关联候选 ${visit.risk_id} 尚未读取或已缺失，无法展示依据。请关闭并刷新记录后重试。`};
  if(risk.parcel_id!==record.parcel_id)return {message:'候选与核查记录的地块不一致，未展示候选依据。'};
  return {risk};
}

const value=(item: unknown)=>esc(item===undefined||item===null||item===''?'未保存':item);
export function candidateSnapshot(risk: Risk) {
  const e=risk.evidence,limitations=Array.isArray(e.limitations)?e.limitations:[];
  return `<section class="candidate-snapshot"><h3>当时保存的算法候选</h3><p>${esc(risk.summary)}</p><dl><dt>候选编号</dt><dd>${esc(risk.id)}</dd><dt>生成时间（UTC）</dt><dd>${esc(utcTime(risk.created_at))}</dd><dt>分析方法</dt><dd>${esc(risk.method==='statistical'?'统计基线':risk.method==='isolation_forest'?'Isolation Forest':risk.method)}</dd><dt>模型版本</dt><dd>${value(risk.model_version)}</dd><dt>指标 / 触发值</dt><dd>${value(e.metric)} / ${value(e.latest_value)}</dd><dt>基线中位数 / MAD</dt><dd>${value(e.baseline_median)} / ${value(e.baseline_mad)}</dd><dt>下降值</dt><dd>${value(e.absolute_drop)}</dd><dt>当时分数（非概率）</dt><dd>${value(e.score)}</dd><dt>基线样本数 / 窗口</dt><dd>${value(e.baseline_count)} 条 / ${value(e.window_days)} 天</dd></dl><p class="notice">候选不是确诊，分数不是概率；现场报告与算法候选分别保存。这里不重新分析，也不根据后续反馈修改当时结论。</p>${limitations.length?`<ul class="source-limitations">${limitations.map(item=>`<li>${esc(item)}</li>`).join('')}</ul>`:'<p class="caption">当时的限制说明未保存。</p>'}</section>`;
}

export function candidateObservations(risk: Risk, observations: Observation[], renderObservation: (item: Observation)=>string) {
  const e=risk.evidence;
  const ids=Array.isArray(e.baseline_observation_ids)?e.baseline_observation_ids.filter((id): id is string=>typeof id==='string'&&id.length>0):[];
  const uniqueIds=[...new Set(ids)];
  const render=(id: string)=>{
    const matches=observations.filter(item=>item.id===id);
    if(matches.length!==1)return `<p class="notice warning">观测 ${esc(id)} ${matches.length?'返回多条，无法确认原记录':'缺失或本次未读取到'}。未用其他观测替代。</p>`;
    const item=matches[0];
    if(item.parcel_id!==risk.parcel_id||item.data_origin==='public_sample')return `<p class="notice warning">观测 ${esc(id)} 的地块或用途不匹配，未作为此候选依据展示。</p>`;
    return `<div class="candidate-observation"><p class="caption">${esc(utcTime(item.observed_at))} · ${esc(e.metric)} ${value(item.features[e.metric])} · ${esc(id)}</p>${renderObservation(item)}</div>`;
  };
  const triggerConsistent=!e.latest_observation_id||e.latest_observation_id===risk.observation_id;
  const trigger=risk.observation_id&&triggerConsistent?render(risk.observation_id):`<p class="notice warning">触发观测编号${triggerConsistent?'未保存':'不一致'}，无法确认原触发观测。候选记录：${value(risk.observation_id)}；依据记录：${value(e.latest_observation_id)}。</p>`;
  const complete=Array.isArray(e.baseline_observation_ids)&&ids.length===e.baseline_observation_ids.length&&uniqueIds.length===ids.length&&uniqueIds.length===e.baseline_count&&!uniqueIds.includes(risk.observation_id);
  return `<p class="caption">仅按候选保存的观测编号读取；不使用后来新增的观测重建基线。展开每条可查看原始来源、时间和质量声明。</p><section><h3>触发观测</h3>${trigger}</section><section><h3>当时使用的基线观测</h3>${!complete?'<p class="notice warning">保存的基线编号缺失、不完整或不一致，不能确认完整基线。仅展示可确认的已存编号。</p>':''}${uniqueIds.filter(id=>id!==risk.observation_id).map(render).join('')||'<p class="caption">没有可读取的已存基线编号，未用当前历史数据补齐。</p>'}</section>`;
}
