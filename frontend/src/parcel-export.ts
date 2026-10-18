import { parseParcelGeometry } from './parcel-geometry.ts';
import type { Parcel } from './types';

export function parcelBoundaryFile(parcel: Parcel): { name: string; content: string } {
  if(parcel.data_origin!=='user')throw new Error('仅支持导出用户录入的地块边界；开发模拟边界不能作为真实地块输入。');
  // Validate without repairing or using the parsed copy: JSON.stringify loses
  // signed zero, which the existing Python canonical geometry hash preserves.
  parseParcelGeometry(JSON.stringify(parcel.geometry));
  const rings=parcel.geometry.coordinates.map(ring=>`[${ring.map(point=>`[${point.map(n=>Object.is(n,-0)?'-0.0':JSON.stringify(n)).join(',')}]`).join(',')}]`);
  const id=parcel.id.replace(/[^A-Za-z0-9_-]/g,'_').slice(0,100)||'boundary';
  return {name:`fieldsignal-${id}.geojson`,content:`{"type":"Polygon","coordinates":[${rings.join(',')}]}\n`};
}

export function downloadParcelBoundary(file: { name: string; content: string }): void {
  const url=URL.createObjectURL(new Blob([file.content],{type:'application/geo+json;charset=utf-8'}));
  let anchor: HTMLAnchorElement|undefined;
  try {
    anchor=document.createElement('a');anchor.href=url;anchor.download=file.name;anchor.hidden=true;
    document.body.append(anchor);anchor.click();
  } finally {
    anchor?.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60_000);
  }
}
