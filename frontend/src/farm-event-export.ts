import type { FarmEvent, Parcel } from './types';
import { csvCell, downloadCsv } from './record-export.ts';

const identity = (value: unknown): value is string => typeof value==='string' && value.trim().length>0;
function invalidScope(): never {
  throw new Error('农事导出已取消：记录身份无效或不属于当前地块。请重新读取后核对。');
}

/** Export only this already-loaded parcel snapshot; never fetch, sort or repair it. */
export function farmEventCsv(events: readonly FarmEvent[], parcel: Parcel, kinds: Record<string,string>, completeness: string): string {
  if(!Array.isArray(events)||!parcel||typeof parcel!=='object'||Array.isArray(parcel)||!Object.hasOwn(parcel,'id')||!identity(parcel.id))invalidScope();
  // Fail the entire export rather than silently dropping a wrong-parcel row.
  for(const event of events) {
    if(!event||typeof event!=='object'||Array.isArray(event)||!Object.hasOwn(event,'id')||!identity(event.id)||
      !Object.hasOwn(event,'parcel_id')||!identity(event.parcel_id)||event.parcel_id!==parcel.id)invalidScope();
  }
  const header=['导出范围','加载范围说明','农事记录ID','地块ID','地块名称','种植季','地块数据来源','农事日期（API原值）','服务端保存时间（API原值含时区）','农事类型代码','农事类型','记录性质','原始备注'];
  const origin=parcel.data_origin==='fixture'?'开发模拟数据':parcel.data_origin==='user'?'用户录入':'来源未知';
  const rows=events.map(event=>{
    const kind=event.kind??'';
    return ['当前地块',completeness,event.id,parcel.id,parcel.name??'',parcel.season??'',origin,event.occurred_on,event.created_at??'',kind,Object.hasOwn(kinds,kind)?kinds[kind]:kind,'用户录入的农事活动，仅供对照，非诊断或异常成因结论',event.note];
  });
  return '\uFEFF'+[header,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}

export function downloadFarmEventCsv(csv: string): void {
  downloadCsv(csv,'fieldsignal-loaded-farm-events.csv');
}
