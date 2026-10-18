import type { Parcel } from './types';
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function noCrs(value: JsonObject) {
  if ('crs' in value) throw new Error('当前不转换坐标系。请先导出不带 CRS 扩展的 WGS84 GeoJSON，使用经度、纬度顺序。');
}

/** Extract only one explicit boundary; never repair, select a first parcel, or reproject. */
export function parseParcelGeometry(raw: string): Parcel['geometry'] {
  let value: unknown = JSON.parse(raw);
  if (!object(value)) throw new Error('请提供 GeoJSON Polygon、单个 Feature 或只含一个 Feature 的 FeatureCollection。');
  noCrs(value);
  if (value.type === 'FeatureCollection') {
    if (!Array.isArray(value.features) || value.features.length !== 1) throw new Error('文件必须只含一块地。请在 GIS 中单独导出目标 Polygon；不会自动选择第一块。');
    value=value.features[0];
    if (!object(value) || value.type !== 'Feature') throw new Error('FeatureCollection 中需要一个 Polygon Feature。');
    noCrs(value);
  }
  if (object(value) && value.type === 'Feature') { value=value.geometry; }
  if (!object(value) || value.type !== 'Polygon') throw new Error('仅支持单个 Polygon；不支持空边界、MultiPolygon 或其他几何类型。');
  noCrs(value);
  if (Object.keys(value).some(key=>!['type','coordinates','bbox'].includes(key))) throw new Error('Polygon 含不支持的几何字段，请导出仅含 type、coordinates 和可选 bbox 的边界。');
  const coordinates=value.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length !== 1 || !Array.isArray(coordinates[0])) throw new Error('仅支持一个外环，不支持内环；不会自动删除孔洞。');
  const ring=coordinates[0];
  if (ring.length < 4 || ring.length > 1000) throw new Error('边界须有 4 至 1000 个坐标点（包括重复的闭合点）。');
  if (!ring.every(point => Array.isArray(point) && point.length === 2 && point.every(number => typeof number === 'number' && Number.isFinite(number)) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 85)) {
    throw new Error('每点须为两个有限数值 [经度, 纬度]，经度 ±180、纬度 ±85；不支持高度坐标，不会自动调换经纬度。');
  }
  const first=ring[0],last=ring[ring.length-1];
  if (first[0] !== last[0] || first[1] !== last[1]) throw new Error('边界首尾必须一致；不会自动补闭合点。');
  const xs=ring.map(point=>point[0]),ys=ring.map(point=>point[1]);
  if (Math.max(...xs)-Math.min(...xs)>1 || Math.max(...ys)-Math.min(...ys)>1) throw new Error('仅支持局部地块，经纬度跨度均须不超过 1°。请检查坐标系和目标地块。');
  // bbox, feature properties and IDs do not define the boundary and are not sent.
  // Self-intersection, repeated vertices and area still require the API validator.
  return {type:'Polygon',coordinates:[ring]};
}

export function parcelGeometrySummary(geometry: Parcel['geometry']): string {
  const ring=geometry.coordinates[0],xs=ring.map(point=>point[0]),ys=ring.map(point=>point[1]);
  return `${ring.length-1} 个坐标点（不含闭合点） · WGS84 经度/纬度声明\n经度 ${Math.min(...xs)} 至 ${Math.max(...xs)} · 纬度 ${Math.min(...ys)} 至 ${Math.max(...ys)}\n仅为边界形状预览，无外部底图；未核实位置、权属或面积。保存时继续校验闭合、自交与重复顶点。`;
}
