# V0产品与五层架构

## 范围与技术取舍

目标用户：农户、合作社、农技人员。主研究区为沙洋；罗田仅为拟外部验证区。V0首先验证发现异常与核验记录能否形成可追溯链路，没有真实样本时不展示“健康率”“准确率”“增产收益”。

当前由单个FastAPI服务提供类型化接口和静态界面，SQLite做本地持久化，TypeScript/Vite提供双入口。SQLite负责普通关系和事务；迁移PostGIS时补空间测试与迁移脚本。界面面积为局部近似，非测绘结果。

| 层 | 当前职责与位置 | 下一阶段边界 |
| --- | --- | --- |
| infra 基础运行 | `scripts/`本机启动；SQLite WAL/外键；本地照片BLOB；锁定依赖 | 私有部署、备份、鉴权、权限与观测告警需单独设计 |
| data 数据 | `adapters/storage.py`持久化；`source_contract.py`数据源状态；`local_bundle.py`本地窗口归一化；source_imports隔离公开样本；不可静默覆盖原观测 | 可信地块预处理/掩膜覆盖核验；PostGIS；SAR账户/费用授权 |
| business 业务 | `domain/`质量门槛与异常基线；`application/`巡田状态流转与提交幂等 | 作物物候对齐、标注审核、真实验证后校准阈值 |
| API 接口 | `api/routes.py`版本路径；Pydantic字段、标准错误；OpenAPI | 分页、租户权限、批量导入、服务端同步版本 |
| UI 交互 | 管理端 `/admin` 与手机巡田 `/field`；本地边界图与趋势 | 原生手机壳或独立App需按拍照/离线/推送实测决定 |

## 功能、页面、字段、API

| 功能 | 页面 | 关键字段 | 接口 |
| --- | --- | --- | --- |
| 地块档案 | 管理/地块；手机/地块 | name、region、crop、season、geometry、boundary_source、sowing_date | GET/POST parcels |
| 状态总览 | 管理总览 | observation_count、data_status、latest_observed_at、data_origin | GET dashboard |
| 历史趋势与来源 | 管理详情；手机摘要 | observed_at、ingested_at、features、quality、provenance | GET/POST parcels/:id/observations |
| 异常候选 | 管理分析 | method、status、score、baseline_ids、model_version、limitations | POST parcels/:id/analyses；GET risks |
| 巡田优先级 | 管理分配；手机巡田 | parcel_id、risk_id、due_date、assignee、status | POST/GET visits |
| 照片与人工核验 | 手机核验；管理记录 | label、note、photo_ids、observed_at、client_submission_id | POST visits/:id/photos；POST visits/:id/verifications |
| 农事台账 | 手机记录；管理详情 | occurred_on、kind、note | GET/POST parcels/:id/events |
| 来源接入状态 | 文档/适配契约 | sample_verified、catalog_only、auth_required、parcel_ingestion_ready | GET sources；POST source-imports/public-sample；GET source-imports/:id，非在线探测 |

## 手机端与断网契约

手机端使用独立触屏任务流程。V0方向为响应式Web/PWA，当前实现为移动Web草稿流程：巡田草稿与照片存在当前浏览器IndexedDB，生成一次client_submission_id，重试继续同一提交；服务端按相同内容/编号幂等返回，照片按巡田+内容摘要去重。显示草稿与上传状态；失败不清草稿，不假装已同步。后台自动同步、推送、后台定位、跨设备草稿同步和原生Android/iOS包均不在本轮范围。当前未提供离线应用壳缓存；已打开页面可保存断网草稿，完全断网重新打开还需后续实现与验收。

浏览器本地存储不是加密档案或长期备份：清站点数据/卸载可能丢失未同步草稿；共享设备需谨慎。应用不会把位置、边界或照片送往第三方地图、分析或AI服务。

## 风险评分约束

当前仅分析Sentinel-2 NDVI；S1/天气可存储，不宣称多源融合已完成。有效条件为可用标志、有效比例≥0.6、地块云量≤0.4；只用当前生长季，历史90天同集合/处理版本的不同日期，跨度至少28天。统计法需5个历史样本，IF需20个。最新有效观测超过14天返回stale。下降门槛与窗口是工程初始值，尚未实地校准；收获、播期、物候与管理事件仍可能造成假阳性。

statistical用中位数与MAD，最新值不参与拟合，下降≥0.1且稳健分数≥3生成候选。IF使用固定随机种子及单源历史NDVI、负decision_function并叠加下降≥0.1；不输出伪概率。未触发返回not_flagged，并明确不等于健康。一次相同观测/方法/版本只产生一个候选，已核验候选不会因重跑重新打开。

2026-10-16新增来源管线、字段与产品导入流程详见[本地导入契约](local-observation-import.md)。公共样本没有地块ID，不计入用户统计和候选；该流程不扩展手机草稿或网络权限。
