// Synthetic complete API responses. IDs alone are not submission receipts.
const normalized=value=>value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu,'');
export function photoReceipt(draft,id,overrides={}){
 return {id,visit_id:draft.visit_id,created_at:'2026-10-20T10:00:00.123456Z',content_type:'image/jpeg',size_bytes:128,metadata_stripped:true,state:'staged',data_origin:draft.data_origin,...overrides};
}
export function verificationReceipt(draft,overrides={}){
 return {id:`record-${draft.visit_id}`,visit_id:draft.visit_id,parcel_id:draft.parcel_id,client_submission_id:normalized(draft.client_submission_id),observed_at:draft.observed_at,label:draft.label,note:normalized(draft.note),photo_ids:draft.photos.map(photo=>normalized(photo.uploaded_id)),created_at:'2026-10-20T10:01:00.123456Z',data_origin:draft.data_origin,label_source:'field_report_unadjudicated',...overrides};
}
