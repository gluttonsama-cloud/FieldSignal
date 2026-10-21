import type { Parcel, Verification } from './types';

// A spreadsheet-view export, not a lossless database backup. A visible text
// prefix avoids relying on spreadsheet-specific apostrophe escaping.
export function csvCell(value: unknown): string {
  const text=String(value??'');
  const literal=/^[=+\-@＝＋－＠\s\p{Cc}\p{Cf}'"]/u.test(text)?`文本：${text}`:text;
  return `"${literal.replace(/"/g,'""')}"`;
}

export function verificationCsv(records: readonly Verification[], parcels: readonly Parcel[], labels: Record<string,string>, scope: string, completeness: string): string {
  const header=['导出范围','加载范围说明','核查记录ID','巡田任务ID','地块ID','地块名称','种植季','地块数据来源','现场观察时间（API原值含时区）','服务端保存时间（API原值含时区）','现场判断代码','现场判断','记录性质','现场备注','照片数量'];
  const rows=records.map(record=>{
    const parcel=parcels.find(p=>p.id===record.parcel_id);
    const origin=parcel?.data_origin==='fixture'?'开发模拟数据':parcel?.data_origin==='user'?'用户录入':'来源未知';
    return [scope,completeness,record.id,record.visit_id,record.parcel_id,parcel?.name??'',parcel?.season??'',origin,record.observed_at,record.created_at,record.label,Object.hasOwn(labels,record.label)?labels[record.label]:record.label,'人工现场报告，未经裁定，非确诊',record.note,record.photo_ids.length];
  });
  return '\uFEFF'+[header,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}

export function downloadVerificationCsv(csv: string): void {
  downloadCsv(csv,'fieldsignal-loaded-verifications.csv');
}

export function downloadCsv(csv: string, filename: string): void {
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  let anchor: HTMLAnchorElement|undefined;
  try {
    anchor=document.createElement('a');anchor.href=url;
    anchor.download=filename;anchor.hidden=true;
    document.body.append(anchor);anchor.click();
  } finally {
    anchor?.remove();
    // Give the browser time to start the download before releasing its URL.
    setTimeout(()=>URL.revokeObjectURL(url),60_000);
  }
}
