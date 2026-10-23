# 本地真实数据管线与导入契约

当前契约更新：2026-10-23。应用不会自动下载影像、发送位置或把公开样本关联到用户地块。随包网络证据仍为2026-10-15归档记录；本增量不新增真实接入或外部请求。

## 产品操作

1. 本地启动后，管理端选择「数据接入」。读取来源能力及样本清单不会写入数据库。
2. 点击「导入公开样本到本地」。服务验证manifest与输入文件SHA-256，实际解码三张TIFF，计算质量/NDVI，并解析POWER原始JSON。
3. 结果显示原观测、源获取、本次入库三个时间；空间支持、指标单位、许可、文件摘要与数据限制可展开。
4. 同一manifest摘要与处理版本重复、并发或断网重试复用同一导入批次。失败不写入部分批次。GET状态并非实时检测外部服务。

公开样本只进入source_imports，不进入parcels/observations/risks/visits。没有parcel_id，不参与地块统计、异常分析或巡田安排。现有模拟地块继续单独标记fixture。API拒绝将usage_scope=public_sample、spatial_support.kind=public_window、no_crop_truth标记或缺少显式parcel绑定的已知公开资产摘要导入用户地块。删除可选范围字段不会自动绕过这一隔离。API接收本地用户声明，并非防伪数据认证；刻意删除全部来源并伪造内容不在该本地原型可验证范围内。

随包验收输入：2025-04-28公开任意320m方窗，1期S2，2025-04-26至28共3个UTC天气日。未核实油菜类别或用户权属。NDVI中位0.37450793780333835；SCL保守4/5类并排除nodata、负反射率及无效分母后，有效1012/1024。SCL 8/9/10云比例为0，不能把剩余12个无效像元当成云。历史质量达标不等于当前可用：这些记录显示过期，单期光学仍不足以做趋势异常判断。

## 可复用的本地adapter

`backend/app/adapters/local_bundle.py`没有沙洋、固定日期或样本指标分支。使用通用`LocalObservationBundleAdapter`处理依法取得的本地文件；公开样本是第一条端到端验收输入。当前支持：

- Sentinel-2 STAC Feature/FeatureCollection + 已预裁切的单波段red/nir/scl GeoTIFF窗口。支持投影EPSG、米单位、PixelIsArea、北向规则网格，不执行联网COG访问、整景下载或任意投影重采样。
- STAC与TIFF的CRS、源网格内位置、像元对齐、resolution、nodata、scale/offset须一致。red/nir使用各自元数据缩放；SCL整数倍最近邻对齐，不增加空间信息。
- NASA POWER历史MERRA2气象JSON：明确UTC、源单位为C/mm/day；-999或源fill_value转缺失，部分缺测标记质量受限，全日缺失不造零记录。其他时标、源网格或单位会拒绝，等待显式适配。

manifest格式见`research/public-source-smoke/observation-bundle.json`：

| 字段 | 约束 |
| --- | --- |
| schema_version, bundle_id, title | 当前版本1；批次身份和说明 |
| scope | public_sample或parcel；不得省略 |
| files | 文件逻辑名 → 相对path、sha256；所有输入先校验；禁止绝对路径、目录穿越、越界符号链接和URL读取 |
| records | adapter、retrieved_at、provider、license、source_uri及输入引用；光学为stac/item_id/assets，气象为data |
| limitations | 保留限制，不能用成功读入替代权属、作物或诊断证据 |
| parcel_geometry_sha256 | parcel范围必须提供；对规范化WGS84 Polygon JSON（sort_keys、紧凑分隔符）计算SHA-256 |
| records[].mask | parcel光学必须提供，0/1二值GeoTIFF，与red像元、范围、CRS严格一致；统计分母只计mask=1像元 |

单文件最多32MiB、合计64MiB、单图400万像元、POWER最多366天。用户自行准备的地块mask和边界摘要是来源声明与归属约束，不代表本程序已独立确认mask真实覆盖该GeoJSON、土地权属或作物类别；源文件真伪也不能仅凭自报hash确认。界面明确保留“声明/未独立核验”。生产前仍需可信预处理、投影与polygon-raster覆盖校验、数据审核。

复现随包真实观测，不入库、不联网：

```bash
python scripts/normalize-observation-bundle.py \
  --manifest research/public-source-smoke/observation-bundle.json \
  --output /tmp/fieldsignal-normalized.json
```

输出包含可复用ObservationCreate数组、bundle摘要、版本与限制。拒绝覆盖已有输出，也拒绝把输出写回输入证据目录。不同本地STAC item/日期测试已通过；没有把3天气象当成3期光学观测。

在管理端或田间助手的地块详情，可点击「下载边界 GeoJSON」取回当前已加载用户地块的 Polygon，用于下述 `--parcel-geometry`。文件只含 type/coordinates，保留坐标顺序、数值与闭合点，不含地块名称或其他记录；含地理坐标，请保存在私有位置。仅用户点击后在本机下载，不外发，不生成mask或认证位置/权属；开发模拟地块不提供此入口。

合法取得的真实地块文件使用scope=parcel、对应mask与边界摘要后，加`--parcel-geometry /path/to/polygon.json`验证摘要。在管理端「导入真实地块观测」选择规范化输出 JSON（1 MiB 内），可保留原来的单条选择方式，也可点击「核对整批」进入只读核对。选择文件、选择记录或查看整批都不会上传。

整批核对固定当前表单打开时的目标地块，展示完整地块 ID、种植季、条数、原始时间范围、来源计数、质量声明、处理版本、原 manifest 摘要与限制。每条来源、指标、时间支持、边界/掩膜声明均可展开；最多 500 条，不截断超量文件。最后点击「确认导入整批」才提交。返回单条选择保留原选择与 JSON，不自动改写。

新接口 POST `/parcels/{id}/observation-batches` 在一个事务中处理整批。完全一致的已存来源记录复用原观测；同来源/编号而内容不同、批内重复来源编号、错误季节、地块/掩膜绑定不符或公共样本等会整批拒绝，不留下半批新增，不覆盖已有记录。成功回执逐条列出观测 ID 和「新增 / 已有，已复用」，不会自动运行分析。原始 JSON、来源与质量仍是提交者声明，不因整批保存而获得真实性认证。

请求结果不明时保留核对页和请求编号；原样手动重试返回同一持久化回执。关闭后重新打开同文件也通过完整内容核对复用原观测，但新请求会有新回执，不能把「已有」误读为本次新采集。列表刷新失败不抹去已经确认的回执，也不要求重新导入。服务端限制实际请求体为 1 MiB，最多 500 条；客户端读取文件同样限制 1 MiB。

仍兼容单条 JSON 与已有 POST `/parcels/{id}/observations`，该旧接口的重复来源编号继续返回冲突。界面仅检查结构与显式范围，不独立认证文件声明；批次摘要指原 manifest，不是输出 JSON 的摘要。服务校验生长季；对于明确声明 usage_scope=parcel 的记录校验当前地块边界摘要，光学还要求 parcel 空间支持及 parcel_mask_sha256 的资产摘要绑定。单条旧记录仍可缺省为 unverified，用于保存和探索，不能借此进入正式监测。没有通用任意文件上传、自动遥感裁切或跨地块批量导入。

## 保存、探索预览与正式监测资格

保存成功、质量声明达标、可以计算基线和具备正式监测资格是不同问题。当前 JSON API 只接收特征与声明摘要，并不读取提交者的原始像元，也不独立确认来源真实性、田块覆盖、权属或作物。离线 adapter 确实校验它读取到的本地文件摘要、网格、掩膜对齐和统计质量，但其规范化 JSON 再被导入时，不能把这些自报摘要当成服务已复核的证据。

因此，本增量的所有非模拟地块分析均为 `mode=preview`，`monitoring_eligible=false`，`risk_id=null`。无论单条或整批导入，甚至所有声明都完整一致，均不生成正式候选或巡田任务。仍可从地块明确安排自主巡田，不能把人工任务的存在当作已具备监测依据。

资格说明：

- `qualification_status=unverified`：光学记录未声明 parcel 用途，或缺少/不一致的边界、掩膜、空间及质量计数绑定；没有光学数据也属此类。
- `qualification_status=declared_only`：每条光学记录声明 parcel 用途，边界摘要匹配当前地块；parcel 空间支持及掩膜摘要绑定到资产摘要；含 CRS、四值 bounds、正像元尺寸、总/有效像元数及云量字段，有效比例与计数一致。它只表示声明层面的完整和内部一致，不表示真实质量合格、历史充足、源文件真实或独立核实。混有不完整光学记录时仍是 unverified。
- 两种真实导入的 `qualification_reasons` 都保留 `source_not_verified`。其他原因可包括 `unverified_scope`、`geometry_binding_missing`、`mask_binding_missing`、`quality_binding_missing`、`no_optical_observations`。
- `mode=fixture_demo`、`qualification_status=fixture_demo` 仅适用于服务显式创建的开发模拟地块。它可以演示模拟候选和巡田链路，但同样 `monitoring_eligible=false`，不能混为真实监测。客户端不能通过提交字段授予 fixture 或 verified 资格。

新分析回执：

| 情形 | status | preview_status | 风险/证据 |
| --- | --- | --- | --- |
| 用户数据预览发现下降 | preview_only | candidate | risk_id=null；preview_evidence 保留统计依据，不创建候选 |
| 用户数据预览未触发 | preview_only | not_flagged | risk_id=null；不等于已确认健康 |
| 用户光学过期 | blocked | stale | 不生成新候选 |
| 用户无合格光学或历史不足 | blocked | insufficient_data | 不生成新候选 |
| 显式模拟演示 | candidate / not_flagged / stale / insufficient_data | null | 仅 candidate 可关联模拟 risk_id；preview_evidence=null |

当前没有授予正式监测资格的生产通路或批准按钮。下一阶段必须实际建立可靠来源、地块几何/掩膜映射及质量证据链，不能通过增加一个客户端 `verified` 声明来绕过此门槛。分析算法仍只是未作物候校正的基线，分数不是概率。

## 光学时效、天气时效与现场反馈

Dashboard 分别返回 `latest_optical_observed_at` / `optical_data_status` 和 `latest_weather_observed_at` / `weather_data_status`。时间是该模态最近合格观测，可能为空；状态为 `missing|quality_limited|stale|available`。原 `latest_observed_at` / `data_status` 改为光学别名，新天气不会给旧 NDVI 续新。光学 available 不表示历史样本足够或来源已核实；`monitoring_status=preview_only|blocked|fixture_demo` 与声明资格独立展示。

现场报告也不是监测真值或专业裁定。所有 label（包括 normal、uncertain、disease_suspected）均为 `field_report_unadjudicated` / `review_required`。提交仅完成本次巡田；关联候选保持 unresolved 并进入 review_required，继续计入待核查。明确安排下一次任务时可变为 assigned，但不消除已有报告的待复核状态。

关联复查保留 source_verification_id，并沿源报告继承 risk_id（无候选则为空）。同一事件在普通巡田与关联复查入口之间最多一条待完成任务；无候选的报告链也不能从旧报告和后代分叉出重复待办。不同独立报告仍可分别安排复查。原报告和照片不改，复查报告也不会自动解决事件；没有新增专业裁定或处置提交入口。完整接口与错误码见[API 契约](api-contract.md)。

## 历史记录与回执兼容

不迁移或批量重写既有库，schema version 仍为3。旧观测保留缺省 unverified；旧候选的 verified 只在读取时映射为 review_required / unresolved，并保留 legacy_status=verified，避免把“曾收到报告”误当“问题已解决”。历史用户候选标为 preview，并继续保留既有待办，不宣称它们是正式监测结果。旧分析保留原始字段和运行事实，界面按地块来源标为历史探索/模拟结果，不从旧 candidate 状态推导可信资格。

旧复查可能曾保存 risk_id=null；当前读取沿 source_verification_id 链恢复关联，但不改旧记录和原始幂等回执。新关联复查保存继承的事件链接。旧回执与当前派生视图无法核对时保留表单、刷新检查，不补造回执、不自动新建重复任务。已有历史重复待办不会自动删除或合并；新操作仍受同事件/同报告链的待办约束。损坏或循环来源链会明确报错，不猜测链接。

## 存储和API

| 层 | 增量 |
| --- | --- |
| infra | 不新增外部服务或依赖；随包证据与锁文件可离线复核 |
| data | LocalObservationBundleAdapter；source_imports独立表（SQLite user_version=3；source_imports于v2引入，旧表保留） |
| business | 显式导入、SHA/版本幂等、原子保存、公共范围隔离、来源声明/地块摘要校验；用户分析仅预览，现场报告不自动解决事件 |
| API | GET /sources；POST /source-imports/public-sample；GET /source-imports/{id} |
| UI | 管理端数据接入；现有地块记录补获取时间/空间支持/时标/单位/未知说明 |

所有路径前缀/api/v1。POST仅接受`{"sample_id":"shayang-public-window-20250428-v1"}`，额外parcel_id会报422。返回`{created, import}`；import包含id/sample_id/scope/status/bundle_sha256/processing_version/imported_at/observations/limitations/analysis_status。公共样本观察记录data_origin=public_sample，质量和过期分别展示；每次读取重新评估过期，不重写原时间。

来源契约Provenance新增可选：retrieved_at、usage_scope（默认unverified）、asset_checksums、parcel_geometry_sha256、parcel_mask_sha256和spatial_support。spatial_support保留kind/crs/bounds/pixel_size_m/scl_pixel_size_m/grid_degrees/total_pixels/valid_pixels。原有观测JSON兼容，缺失来源信息不自动补成“已核实”。原始来源URI仅显示链接，服务不访问该链接。

## 未完成的范围

没有真实用户田块接入、可信地块mask生成、独立来源资格核实、作物标签、真实多期算法效果或SAR资产接入。没有专业报告裁定/事件解决流程、公网部署、权限系统或手机原生包。本导入契约及自动检查不构成浏览器视觉、手机真机、离线恢复或真实田间效果验收；这些结果应以对应版本的单独记录为准。
