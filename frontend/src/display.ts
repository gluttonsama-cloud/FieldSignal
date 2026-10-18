import type { Observation, Parcel } from './types';
export const regions: Record<string, string> = { shayang: '沙洋县', luotian: '罗田县', other: '其他区域' };
export const labels: Record<string, string> = { normal: '未见明显异常', waterlogging: '田间积水', frost: '疑似冻害', disease_suspected: '疑似病害', other: '其他情况', uncertain: '暂不能判断' };
export const kinds: Record<string, string> = { sowing: '播种', fertilizing: '施肥', spraying: '植保作业', drainage: '排水', other: '其他农事' };
export const sources: Record<string, string> = { sentinel2: 'Sentinel-2 光学', sentinel1: 'Sentinel-1 雷达', weather: '气象记录', manual: '人工录入' };
export const statuses: Record<string, string> = { missing: '待接入数据', stale: '数据已过期', available: '有可用观测', quality_limited: '质量受限', insufficient_data: '数据不足', not_flagged: '本次未触发候选', candidate: '发现待核查候选' };
export function esc(value: unknown): string { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }
export function fmtDate(value?: string) {
  if(!value)return '暂无';
  const date=new Date(value),calendarDate=/^\d{4}-\d{2}-\d{2}$/.test(value);
  if(Number.isNaN(date.valueOf())||(calendarDate&&date.toISOString().slice(0,10)!==value))return '日期无效';
  // A plan/farm/sowing date is a calendar day, not midnight UTC in the device zone.
  return new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',year:'numeric',...(calendarDate?{timeZone:'UTC'}:{})}).format(date);
}
export function fmtTime(value?: string) { if (!value) return '暂无'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? '时间无效' : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date); }
export function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
export function localInput(iso: string) { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
export function fixture(parcel?: Pick<Parcel, 'data_origin'>) { return parcel?.data_origin === 'fixture' ? '<span class="badge fixture">开发模拟数据</span>' : ''; }
export function badge(status?: string) { return `<span class="badge ${esc(status || 'missing')}">${esc(statuses[status || 'missing'] || status)}</span>`; }
export function empty(title: string, detail: string, action = '') { return `<div class="empty"><div class="empty-icon" aria-hidden="true">⌁</div><strong>${esc(title)}</strong><p>${esc(detail)}</p>${action}</div>`; }
export function boundaryMap(parcels: Pick<Parcel, 'id' | 'name' | 'geometry'>[], selected?: string) {
  const usable = parcels.filter(p => p.geometry?.coordinates?.[0]?.length > 3);
  if (!usable.length) return `<div class="map-empty">${empty('还没有地块边界', '录入地块后，边界将在这里显示。')}</div>`;
  const points = usable.flatMap(p => p.geometry.coordinates[0]);
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const midLat = (minY + maxY) / 2;
  const cosLat = Math.cos(midLat * Math.PI / 180);
  const spanX = Math.max((maxX-minX)*cosLat, 0.00001), spanY = Math.max(maxY-minY, 0.00001);
  const scale = Math.min(680/spanX, 290/spanY);
  const padX = (800-spanX*scale)/2, padY = (380-spanY*scale)/2;
  const project = (p: number[]) => [padX+(p[0]-minX)*cosLat*scale, 380-padY-(p[1]-minY)*scale];
  return `<svg class="boundary-svg" viewBox="0 0 800 380" role="img" aria-label="地块边界示意，无外部底图">${usable.map(p=>{const xy=p.geometry.coordinates[0].map(project);const center=xy.slice(0,-1).reduce((a,b)=>[a[0]+b[0]/(xy.length-1),a[1]+b[1]/(xy.length-1)],[0,0]);return `<g><polygon points="${xy.map(x=>x.join(',')).join(' ')}" class="${p.id===selected?'selected':''}"/><text x="${center[0]}" y="${center[1]}" text-anchor="middle">${esc(p.name)}</text></g>`;}).join('')}<text x="770" y="34" text-anchor="middle" class="north">N ↑</text></svg>`;
}
export function usable(o: Observation) { return o.quality.usable && o.quality.valid_fraction >= 0.6 && (o.source !== 'sentinel2' || (o.quality.cloud_fraction != null && o.quality.cloud_fraction <= 0.4)); }
export function trend(observations: Observation[]) {
  const points = observations.filter(o => Number.isFinite(o.features.ndvi)).sort((a,b)=>new Date(a.observed_at).valueOf()-new Date(b.observed_at).valueOf());
  if (!points.length) return empty('待接入 NDVI 时序', observations.length ? '已有记录不含 NDVI，完整特征可在观测详情中查看。' : '导入具有来源与质量信息的观测后展示真实变化。');
  const first=+new Date(points[0].observed_at), last=+new Date(points.at(-1)!.observed_at), span=Math.max(last-first,86400000);
  const x=(o:Observation)=> 50+(+new Date(o.observed_at)-first)/span*680, y=(o:Observation)=> 150-(o.features.ndvi!)*110;
  const lines=points.slice(1).map((o,i)=>{const prev=points[i]; const gap=(+new Date(o.observed_at)-+new Date(prev.observed_at))/86400000; return gap>14 || !usable(o) || !usable(prev) || o.source!==prev.source || o.provenance.collection!==prev.provenance.collection || o.provenance.processing_version!==prev.provenance.processing_version ? '' : `<line x1="${x(prev)}" y1="${y(prev)}" x2="${x(o)}" y2="${y(o)}" stroke="#478361" stroke-width="2.5"/>`;}).join('');
  const stale=(Date.now()-last)/86400000>14;
  return `<div class="chart-key"><span><i class="dot green"></i>可用观测</span><span><i class="dot hollow"></i>质量受限</span><span>缺口 / 来源变化不连线</span>${stale?'<span class="badge stale">数据已过期</span>':''}</div><svg class="trend-svg" viewBox="0 0 780 280" role="img" aria-label="NDVI 时序，空心点表示质量受限，观测缺口不插值">${[-1,0,0.5,1].map(v=>`<line x1="50" y1="${150-v*110}" x2="744" y2="${150-v*110}" stroke="#e4e9df"/><text x="32" y="${154-v*110}" text-anchor="end">${v}</text>`).join('')}${lines}${points.map(o=>`<circle cx="${x(o)}" cy="${y(o)}" r="5" fill="${usable(o)?'#397653':'#fff'}" stroke="${usable(o)?'#397653':'#bc8033'}" stroke-width="2"><title>${esc(fmtDate(o.observed_at))} · NDVI ${o.features.ndvi} · ${usable(o)?'可用':'质量受限'}</title></circle>`).join('')}<text x="50" y="278">${esc(fmtDate(points[0].observed_at))}</text><text x="744" y="278" text-anchor="end">${esc(fmtDate(points.at(-1)!.observed_at))}</text></svg><p class="caption">仅显示已有观测；未插值、未填补缺失。NDVI 变化不等同于灾害诊断。</p>`;
}
