// Full synthetic API receipts for production-handler tests. Validation tests
// separately exercise incomplete/mismatched receipts rather than accepting IDs.
export function syntheticRecordReceipt(path,body,id='synthetic-record',original={}) {
  const created_at='2026-10-18T12:00:00.123456+00:00';
  if(path==='/parcels')return {id,created_at,crop:'oilseed_rape',sowing_date:null,cultivar:null,boundary_source:'user_provided',boundary_reference:null,boundary_crs:'EPSG:4326',area_ha:1,area_method:'local_equirectangular_estimate_not_survey',data_origin:'user',...structuredClone(body)};
  if(path==='/visits')return {id,created_at,status:'pending',plan_revision:0,data_origin:'user',risk_id:null,assignee:null,note:null,...structuredClone(body)};
  if(/^\/visits\/[^/]+\/plan$/.test(path)){
    const {expected_revision,...fields}=body;
    return {created_at,...structuredClone(original),...structuredClone(fields),id:original.id??id,status:'pending',plan_revision:expected_revision+1,plan_updated_at:'2026-10-18T13:00:00.123456+00:00'};
  }
  const target=path.match(/\/parcels\/([^/]+)\/events$/);
  if(target)return {id,created_at,parcel_id:decodeURIComponent(target[1]),data_origin:'user',...structuredClone(body)};
  throw new Error(`No synthetic mutation receipt fixture for ${path}`);
}
