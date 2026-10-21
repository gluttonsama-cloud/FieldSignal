import { esc } from './display.ts';
import { observationImportSummary } from './observation-import.ts';
import type { ObservationBundle } from './observation-import';

export interface ObservationBatchReceipt {
  id: string;
  parcel_id: string;
  bundle_id: string;
  bundle_sha256: string;
  processing_version: string;
  created_at: string;
  created_count: number;
  existing_count: number;
  observations: { id: string; source: string; source_record_id: string; observed_at: string; status: 'created' | 'existing' }[];
}

// Normalized Python datetimes preserve microseconds, while Date.parse alone
// discards them. Compare the UTC second and the server's six-digit precision.
function observationInstant(value: unknown): string | undefined {
  if(typeof value!=='string')return;
  const parts=value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/i);
  if(!parts)return;
  const zone=parts[4].length===5?`${parts[4].slice(0,3)}:${parts[4].slice(3)}`:parts[4];
  const second=Date.parse(`${parts[1]}T${parts[2]}${zone}`);
  if(!Number.isFinite(second))return;
  return `${second}:${(parts[3]||'').padEnd(6,'0').slice(0,6)}`;
}

export function observationBatchError(bundle: ObservationBundle): string {
  if (bundle.observations.length > 500) return '整批导入每次最多 500 条；仍可在原表单选择单条，或在本地重新生成较小批次。';
  if (new TextEncoder().encode(JSON.stringify(bundle)).length > 1024 * 1024) return '整批 JSON 不能超过 1 MiB；请在本地重新生成较小批次。';
  const keys = new Set<string>();
  for (const [index, record] of bundle.observations.entries()) {
    if(!observationInstant(record.observed_at))return `第 ${index+1} 条的时间不是可核对的带时区 ISO 日期时间；请重新生成规范化文件后导入。`;
    const key = JSON.stringify([String(record.source).trim(), String(record.source_record_id).trim()]);
    if (keys.has(key)) return `第 ${index + 1} 条与本批另一条使用相同来源记录编号；请在本地核对，不能自动去重或覆盖。`;
    keys.add(key);
  }
  return '';
}

export function observationBatchReview(bundle: ObservationBundle, parcel: { id: string; name: string; season?: string }): string {
  const counts = new Map<string, number>();
  let declaredUsable = 0;
  for (const row of bundle.observations) {
    const source = String(row.source);
    counts.set(source, (counts.get(source) || 0) + 1);
    if ((row.quality as { usable?: boolean })?.usable) declaredUsable++;
  }
  const times = bundle.observations.map(row => String(row.observed_at)).sort((a,b) => Date.parse(a)-Date.parse(b));
  return `<h3 id="observation-batch-title" tabindex="-1">核对整批 ${bundle.observations.length} 条观测</h3>
    <p class="form-intro"><strong>${esc(parcel.name)}</strong><br>固定目标地块：${esc(parcel.id)}<br>种植季：${esc(parcel.season || '待服务校验')}</p>
    <dl><dt>批次</dt><dd>${esc(bundle.bundle_id)}</dd><dt>处理版本</dt><dd>${esc(bundle.processing_version)}</dd><dt>时间范围</dt><dd>${esc(times[0])}<br>至 ${esc(times.at(-1))}（保留原时区）</dd><dt>来源条数</dt><dd>${[...counts].map(([source,count])=>`${esc(source)}：${count}`).join('；')}</dd><dt>质量声明</dt><dd>${declaredUsable} 条声明可用，${bundle.observations.length-declaredUsable} 条声明受限；不是服务对质量或农情的认证。</dd><dt>原 manifest SHA-256</dt><dd>${esc(bundle.bundle_sha256)}（文件声明，不是输出 JSON 的重算摘要）</dd></dl>
    ${bundle.limitations.length?`<ul class="source-limitations">${bundle.limitations.map(item=>`<li>${esc(item)}</li>`).join('')}</ul>`:''}
    <p class="notice">确认后才发送至本地服务。完全一致的已存观测会复用；任何一条不合法或与已存同来源编号内容冲突，将整批拒绝，不覆盖原记录。不会自动运行分析，也不代表真实来源、地块权属或农情已经核验。</p>
    <ol class="observation-batch-rows">${bundle.observations.map((row,index)=>`<li><details><summary>${index+1}. ${esc(row.source)} · ${esc(row.observed_at)}<br>${esc(row.source_record_id)}</summary><pre>${esc(observationImportSummary(row))}</pre></details></li>`).join('')}</ol>
    <div class="dialog-actions"><button type="button" class="button secondary" data-action="edit-observation-batch">返回单条选择</button><button id="confirm-observation-batch" type="submit" class="button primary">确认导入整批 ${bundle.observations.length} 条</button></div>`;
}

/** Do not present a lost, malformed, or mismatched response as an acknowledged import. */
export function validateObservationBatchReceipt(value: unknown, parcelId: string, bundle: ObservationBundle): ObservationBatchReceipt {
  const receipt=value as ObservationBatchReceipt | null;
  const invalid=()=>new Error('服务响应与本次批次不一致，导入结果尚未确认。请保留原批次并原样重试核对。');
  if (!receipt || typeof receipt.id!=='string' || !receipt.id || receipt.parcel_id!==parcelId || receipt.bundle_id!==bundle.bundle_id.trim() ||
      receipt.bundle_sha256!==bundle.bundle_sha256 || receipt.processing_version!==bundle.processing_version.trim() ||
      typeof receipt.created_at!=='string' || !Number.isFinite(Date.parse(receipt.created_at)) ||
      !Array.isArray(receipt.observations) || receipt.observations.length!==bundle.observations.length ||
      !Number.isInteger(receipt.created_count) || receipt.created_count<0 || !Number.isInteger(receipt.existing_count) || receipt.existing_count<0 ||
      receipt.created_count+receipt.existing_count!==bundle.observations.length) throw invalid();
  const ids=new Set<string>();let created=0,existing=0;
  for (const [index,row] of receipt.observations.entries()) {
    const expected=bundle.observations[index];
    if (!row || typeof row.id!=='string' || !row.id || ids.has(row.id) || row.source!==String(expected.source).trim() ||
        row.source_record_id!==String(expected.source_record_id).trim() || !observationInstant(row.observed_at) ||
        observationInstant(row.observed_at)!==observationInstant(expected.observed_at) || !['created','existing'].includes(row.status)) throw invalid();
    ids.add(row.id);
    if (row.status==='created') created++; else existing++;
  }
  if (created!==receipt.created_count || existing!==receipt.existing_count) throw invalid();
  return receipt;
}

export function observationBatchReceiptBody(receipt: ObservationBatchReceipt): string {
  return `<h3 id="observation-batch-title" tabindex="-1">整批导入已确认</h3>
    <p class="notice" role="status">新增 ${receipt.created_count} 条 · 已存在且完全一致 ${receipt.existing_count} 条。未覆盖任何原观测。</p>
    <p class="caption">回执 ${esc(receipt.id)}<br>地块 ${esc(receipt.parcel_id)}<br>批次 ${esc(receipt.bundle_id)} · ${esc(receipt.created_at)}（保留时区）</p>
    <p id="observation-batch-refresh" class="caption" role="status">正在刷新已加载列表；此回执已经确认，不需要再次导入。</p>
    <ol class="observation-batch-rows">${receipt.observations.map(row=>`<li><strong>${row.status==='created'?'新增':'已有，已复用'}</strong> · ${esc(row.source)} · ${esc(row.observed_at)}<br>来源记录 ${esc(row.source_record_id)}<br>观测 ID ${esc(row.id)}</li>`).join('')}</ol>
    <p class="caption">请保留原始规范化文件作为来源材料。回执仅确认本地保存；不会自动分析，来源与质量声明仍未独立核验。</p>
    <div class="dialog-actions"><button type="button" class="button primary" data-action="close-dialog">完成，返回地块列表</button></div>`;
}
