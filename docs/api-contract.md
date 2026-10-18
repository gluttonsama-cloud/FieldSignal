# FieldSignal V0 interface contract

All paths begin `/api/v1`; JSON uses snake_case. API errors return `{error: {code, message, details}}`. All datetimes are ISO 8601 with timezone, normalized to UTC. Growing-season date membership uses Asia/Shanghai civil dates (July 1 to the following June 30); farm-event dates use the same agronomic calendar. Local prototype only, bound to 127.0.0.1. No account system or remote deployment is included. Data is empty by default.

## Entities

- Parcel: `id, name, region, crop, season, sowing_date?, cultivar?, geometry, area_ha, area_method, boundary_source, boundary_reference?, boundary_crs, data_origin, created_at`. `region`: `shayang|luotian|other`; `crop`: `oilseed_rape`. `geometry`: GeoJSON Polygon WGS84 closed ring (no holes in V0). `data_origin`: `user|fixture`; fixture parcels cannot accept actual observations.
- Observation: `id, parcel_id, observed_at, source, source_record_id, features, quality, provenance, data_origin, observed_at, ingested_at, created_at`. `source`: `sentinel2|sentinel1|weather|manual`. Features support `ndvi, ndre, evi, ndwi, vv_db, vh_db, temperature_min_c, temperature_max_c, precipitation_mm`. Quality: `usable, valid_fraction, cloud_fraction?, flags: string[]`. Provenance: `provider, collection, item_id, processing_version, license?, source_uri?, spatial_resolution_m?, temporal_support, support_note?`. Local pre-cropped S2 TIFF/STAC and POWER JSON normalization is now supported by a separate reusable adapter; there is no automatic download or general raster-upload endpoint.
- AnalysisRun: `id, parcel_id, method, evaluated_at, status, risk_id?, observation_count, message`. Status: `insufficient_data|stale|not_flagged|candidate`. `not_flagged` is not a healthy diagnosis.
- RiskCandidate: `id, parcel_id, observation_id, method, status, priority, summary, evidence, model_version, created_at`. Status: `open|assigned|verified`; priority: `high|medium`; evidence includes actual source observation IDs, `metric, latest_value, baseline_median, baseline_mad, absolute_drop, score, baseline_count, limitations`.
- Visit: `id, parcel_id, risk_id?, status, due_date, assignee?, note?, created_at`. Status: `pending|completed`; only verification completes it.
- Verification: `id, visit_id, parcel_id, observed_at, label, note, photo_ids, created_at`. Label: `normal|waterlogging|frost|disease_suspected|other|uncertain`. Labels are user reports, never confirmed diagnosis. Photo IDs must reference photos stored locally for this same visit. A photo is optional but absence must be visible.
- FarmEvent: `id, parcel_id, occurred_on, kind, note, created_at`. Kind: `sowing|fertilizing|spraying|drainage|other`.

## API

- GET `/health` → `{status, version, storage, demo_enabled}`
- GET `/dashboard` → `{parcel_count, open_risk_count, pending_visit_count, verification_count, parcels: [{...Parcel, latest_observed_at, observation_count, data_status, open_risk_count}], recent_verifications}`. data_status: `missing|stale|available|quality_limited`. Does not equate available to healthy.
- GET `/parcels` → Parcel[]
- POST `/parcels` body `{name, region, season, geometry, sowing_date?, cultivar?}` → Parcel
- GET `/parcels/{id}` → Parcel
- GET `/parcels/{id}/observations` → Observation[] sorted oldest first
- POST `/parcels/{id}/observations` body Observation without id/parcel_id/created_at/data_origin → Observation
- POST `/parcels/{id}/analyses` body `{method?: "statistical"|"isolation_forest"}` → AnalysisRun. Evaluates latest eligible observation; stale or low-quality data never becomes a new alert.
- GET `/parcels/{id}/analyses` → AnalysisRun[]
- GET `/risks` → RiskCandidate[]
- POST `/visits` body `{parcel_id, risk_id?, due_date, assignee?, note?}` → Visit. Omitted/null `risk_id` creates a routine manual visit without a candidate; a linked risk must belong to the parcel, have no pending visit and not be verified (otherwise 422/409). `due_date` is a planning date and need not fall within the parcel season; actual verification time must. Supports optional `Idempotency-Key` as below.
- GET `/visits` → Visit[]
- POST `/visits/{id}/photos` raw `image/jpeg|image/png|image/webp`, max 10 MB → `{id, visit_id, content_type, size_bytes, created_at}`. No outbound transfer; strips metadata by decoding/re-encoding.
- DELETE `/visits/{visit_id}/photos/{photo_id}` → 204, idempotently removes a same-visit staged photo while the visit is pending. Completed evidence is immutable through this route. Offline clients persist a delete queue and drain it before replacement uploads.
- GET `/photos/{id}` → local image bytes
- POST `/visits/{id}/verifications` body `{observed_at, label, note, photo_ids?: [], client_submission_id?}` → Verification and atomically completes visit / resolves linked candidate. Same client_submission_id + identical content replays the original success; conflicting reuse or a different completion returns 409.
- GET `/verifications` → Verification[]
- POST `/parcels/{id}/events` body `{occurred_on, kind, note}` → FarmEvent
- GET `/parcels/{id}/events` → FarmEvent[]
- POST `/dev/fixtures` → `{created: bool, parcel_id}` only if `FIELDSIGNAL_ENABLE_FIXTURES=1`. Inserts one conspicuously named synthetic parcel + simulated optical history. No fake true labels. Does not overwrite real data.

## 地块、农事与巡田请求重试

POST `/parcels`、POST `/parcels/{id}/events` 与 POST `/visits` 支持可选 `Idempotency-Key`：1–128 位 ASCII 字母、数字或 `._:-`，区分大小写；重复请求头返回422。同一数据库中编号全局唯一，并绑定请求类型、目标地块及校验/默认值归一后的内容。相同请求重试返回原来的 201 和记录；同编号换内容、类型或地块返回 409 `idempotency_conflict`。记录与回执在同一 SQLite 事务提交，并发及服务重启后仍可核对。巡田回执还绑定候选、计划日期、负责人和备注，与关联候选的 assigned 状态更新一起提交；即使任务随后已完成、候选已核验，重试仍返回创建时的原始回执，当前状态以 GET 列表为准。无此请求头的旧客户端保持原行为；无关联候选的重复请求会创建独立任务；不自动去重历史数据；回执无自动过期，会随使用占用本地数据库空间。

前端编号仅保留在当前打开的地块/农事/巡田表单。相同已提交内容复用编号，改为新内容使用新编号；改回先前提交的内容仍复用原编号。关闭、重开或刷新页面后不保证识别此前请求。响应中断时原记录可能已保存，应保持内容重试核对，改内容或重开前先检查列表。此机制不新增离线农事或建任务草稿、自动提交。

## UI

- `/` or `/admin`: management page, region/parcel selection, local boundary map (no external tiles), provenance + quality + history, analysis action, candidate → create visit, routine manual visit entry, verification list, parcel create (paste/local GeoJSON file, one-boundary preview), observation JSON input (developer/import workflow).
- `/field`: distinct phone-first workflow, pending visit priorities, parcel summary/trend, routine manual visit entry, camera/gallery attachment + observed label + note form, farm event form. Routine and candidate-linked visits show distinct source labels; forms retain the chosen parcel and show its season. Bottom navigation: 巡田 / 地块 / 记录. Browser-based mobile prototype, not yet a native app, offline sync or notifications.
- Always show no observations as `待接入数据`; expired as `数据已过期`; synthetic as `开发模拟数据`. User field locations/photos stay local. No external map or telemetry calls.

Parcel files accept Polygon, Feature or a FeatureCollection with exactly one Polygon Feature, up to 1 MiB. Coordinates are not repaired or transformed; holes, Z positions and CRS declarations are rejected. Feature properties do not prefill other fields; optional bbox is ignored and preview bounds come from coordinates. Only explicit Save sends the boundary to the local service, which still validates topology and area.

Boundary source defaults to user_provided; user_survey/public_dataset describe the submitted provenance rather than verified ownership. Synthetic fixtures override the source to synthetic_fixture. Area is a local estimate, not a surveying result. Observation ingestion time is separate from acquisition time. Temporal support defaults to instantaneous; daily UTC/local-solar/Beijing intervals must remain distinguishable.

Photo lifecycle: upload creates staged bytes; successful verification atomically confirms only selected photo IDs and removes other staged uploads for that visit. Client drafts remain until the acknowledged submission version is safely cleared. Verification date must fall in the parcel season and, for a linked candidate, be no earlier than the triggering observation. Historic seasons and later-entered genuine historic records remain supported.

## 2026-10-16 local-source extension

See [local observation import contract](local-observation-import.md) for provenance fields, the manifest schema, generic CLI, public-sample API and isolation. GET `/sources` is read-only; POST `/source-imports/public-sample` explicitly imports a bundled public sample without any parcel ID. Existing field observation imports reject public-sample scope and enforce declared parcel geometry hashes when usage_scope=parcel. Old provenance remains valid with usage_scope=unverified. Source_imports are separate from all farm tables and retain immutable input/processing/time evidence.
