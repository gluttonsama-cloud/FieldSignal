import { esc, shortParcelId } from './display.ts';
import type { Parcel, Visit } from './types';

export interface VisitFilters {
  timing: 'all' | 'overdue' | 'today' | 'upcoming';
  assignee: string; // '' = all, 'unassigned', or 'name:' + the exact local label.
  parcelId: string; // '' = all; never changes the selected parcel or form target.
}
export const defaultVisitFilters = (): VisitFilters => ({ timing: 'all', assignee: '', parcelId: '' });
export const visitFiltersActive = (filters: VisitFilters) => filters.timing!=='all'||Boolean(filters.assignee)||Boolean(filters.parcelId);
function calendarDay(value: string | undefined): value is string {
  if(!value||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const date=new Date(value);
  return Number.isFinite(date.valueOf())&&date.toISOString().slice(0,10)===value;
}
export function visitPlanTiming(visit: Pick<Visit,'due_date'>, today: string): 'overdue'|'today'|'upcoming'|'unknown' {
  if(!calendarDay(visit.due_date)||!calendarDay(today))return 'unknown';
  return visit.due_date<today?'overdue':visit.due_date===today?'today':'upcoming';
}
export function filterPendingVisits(visits: Visit[], filters: VisitFilters, today: string): Visit[] {
  return visits.filter(visit=>{
    if(visit.status!=='pending')return false;
    if(filters.parcelId&&visit.parcel_id!==filters.parcelId)return false;
    if(filters.assignee==='unassigned'&&visit.assignee)return false;
    if(filters.assignee.startsWith('name:')&&visit.assignee!==filters.assignee.slice(5))return false;
    if(filters.assignee&&filters.assignee!=='unassigned'&&!filters.assignee.startsWith('name:'))return false;
    if(filters.timing==='all')return true;
    return ['overdue','today','upcoming'].includes(filters.timing)&&visitPlanTiming(visit,today)===filters.timing;
  });
}
function option(value: string, label: string, selected: string) {
  return `<option value="${esc(value)}"${value===selected?' selected':''}>${esc(label)}</option>`;
}
function parcelLabel(id: string, parcels: Parcel[]) {
  const parcel=parcels.find(item=>item.id===id);
  return parcel?`${parcel.name} · ${parcel.season} · #${shortParcelId(id,parcels)}${parcel.data_origin==='fixture'?' · 开发模拟数据':''}`:`地块 ${id}（档案未读取）`;
}
export function visitFilterControls(pending: Visit[], parcels: Parcel[], filters: VisitFilters, visibleCount: number): string {
  const names=[...new Set(pending.map(visit=>visit.assignee).filter((name): name is string=>Boolean(name)))].sort((a,b)=>a.localeCompare(b));
  const parcelIds=[...new Set(pending.map(visit=>visit.parcel_id))];
  const name=filters.assignee.startsWith('name:')?filters.assignee.slice(5):undefined;
  const staleAssignee=name!==undefined&&!names.includes(name);
  const staleParcel=filters.parcelId&&!parcelIds.includes(filters.parcelId);
  const timingOptions=[['all','全部计划日期'],['overdue','已过计划日'],['today','计划今天'],['upcoming','未来计划']];
  const unknownTiming=!timingOptions.some(([value])=>value===filters.timing);
  const unknownAssignee=filters.assignee&&filters.assignee!=='unassigned'&&name===undefined;
  return `<section class="visit-filters" aria-label="筛选待巡田任务"><div class="visit-filter-controls">
    <label>计划日期<select id="visit-timing-filter">${timingOptions.map(([value,label])=>option(value,label,filters.timing)).join('')}${unknownTiming?option(filters.timing,`未知条件 ${filters.timing}，请清除`,filters.timing):''}</select></label>
    <label>执行人<select id="visit-assignee-filter">${option('','全部执行人',filters.assignee)}${option('unassigned','未分配执行人',filters.assignee)}${names.map(name=>option(`name:${name}`,name,filters.assignee)).join('')}${staleAssignee?option(filters.assignee,`${name}（当前无待任务）`,filters.assignee):''}${unknownAssignee?option(filters.assignee,`未知条件 ${filters.assignee}，请清除`,filters.assignee):''}</select></label>
    <label>地块<select id="visit-parcel-filter">${option('','全部地块',filters.parcelId)}${parcelIds.map(id=>option(id,parcelLabel(id,parcels),filters.parcelId)).join('')}${staleParcel?option(filters.parcelId,`${parcelLabel(filters.parcelId,parcels)}（当前无待任务）`,filters.parcelId):''}</select></label>
    </div><div class="visit-filter-summary"><p role="status">显示 ${visibleCount} / ${pending.length} 项已加载待巡田任务</p><button type="button" class="text-button" data-action="clear-visit-filters" ${visitFiltersActive(filters)?'':'disabled'}>清除筛选</button></div>
    <p class="caption">仅筛选待巡田列表，不隐藏本机草稿，不改变异常候选。执行人是任务上的本地标签，不代表登录身份；日期缺失或无效的任务仅在「全部计划日期」显示。</p></section>`;
}
