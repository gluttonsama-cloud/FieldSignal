# 数据源证据与接入契约

截至 2026-10-15。以下区分“官方说明”“本次实测”“工程建议”，不以说明页替代资产读取，也不把公开样本当成真实田块。

## 1. 光学：优先 Earth Search C1

官方：Element 84 的 [Earth Search 文档](https://github.com/Element84/earth-search) 明确公共 API 免费但无服务保证；资产 `https://` 与 requester-pays `s3://` 的访问条件不同。[S2 专页](https://github.com/Element84/earth-search/blob/main/docs/collections/sentinel-2-l2a.md) 说明 v1 `sentinel-2-c1-l2a` 使用 PB≥5 的 COG，每个 asset 的 `raster:bands.scale/offset` 必须独立应用。v2 仍标 beta 且集合名发生变化，首版固定 v1，升级需契约测试。

实测：详见 manifest 和 `optical_window_evidence.json`。无需账户，目录200、三个数据对象206、真实像元解码成功。原 `sentinel-2-l2a` 集合也能检索，但不能用 `earthsearch:boa_offset_applied` 或某张旧影像的规则替代逐 asset 的 scale/offset。

更新：当前 [ESA S2 mission](https://sentiwiki.copernicus.eu/web/s2-mission) 给出名义双星5天重访；额外轨道覆盖及扩展任务会改变局部采集间隔。这不是5天一张无云数据，也不是镜像入库时效承诺。轮询按取得的 acquisition/created/updated 分别记录，允许缺景、重处理和迟到数据。[AWS 清单](https://registry.opendata.aws/sentinel-2-l2a-cogs/) 描述定期新增，但仍有历史 OpenHub 措辞，不据此承诺生产更新 SLA。

许可：[Copernicus Sentinel Legal Notice](https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice) 允许合法使用、修改和再分发，需来源及修改说明，且不提供适用性保证。STAC 的 `license=proprietary` 是自定义许可标签，不能误写成“数据闭源付费”或随意改成 CC0。分享裁剪/派生物使用 Contains modified Copernicus Sentinel data 2025。

## 2. SAR：目录已证实，资产尚未接通

- [CDSE STAC](https://documentation.dataspace.copernicus.eu/APIs/STAC.html)：`https://stac.dataspace.copernicus.eu/v1`；沙洋/2025-03上半月查询200，得到 S1A 20250313 GRD COG。实际尝试资产16KiB Range得到401/Token not found。官方 [迁移文档](https://documentation.dataspace.copernicus.eu/notebook-samples/sentinelhub/getting_started/migration_from_scihub_guide.html) 也区分匿名目录与需token下载。没有生成token。
- [Planetary Computer RTC collection](https://planetarycomputer.microsoft.com/api/stac/v1/collections/sentinel-1-rtc)：同AOI查询200；集合本身 `msft:requires_account=true`，原文说明需PC账户才能取得读取SAS；无签名资产16KiB Range实际409/PublicAccessNotPermitted。许可为 CC-BY-4.0，不等于匿名技术访问。
- [Earth Search S1](https://github.com/Element84/earth-search/blob/main/docs/collections/sentinel-1-grd.md)：同AOI查询200，item明确 `storage:requester_pays=true`；[托管方说明](https://roda.sentinel-hub.com/sentinel-s1-l1c/GRD/readme.html) 明确Requester Pays。AWS清单虽有免账户列举示例，不能据此推断栅格下载免费。未做付费访问。

S1目录样本：2025-03-13T10:28:11.580415Z，VV/VH、IW、113升轨。PC RTC为10米采样、20×22米基础分辨率、EPSG32649、gamma0类校正值；Earth Search GRD为振幅，不可当作已辐射/地形校正的RTC。不能仅换后缀或把DN直接套 dB/比值。

后续有授权才接 CDSE 下载/本地处理或经核实许可的 RTC。需保留轨道方向、相对轨道、平台、入射角、处理版本、轨道文件、DEM、校正/滤波方式及阴影/叠掩有效掩膜；相同观测几何内建立基线，不直接混合升降轨。目录最新时间和“Fast-24h”标签均不等于资产现已入库。

## 3. 气象：NASA POWER 回溯背景；CMA待授权

官方 [Daily API](https://power.larc.nasa.gov/docs/services/api/temporal/daily/) 支持 JSON、小范围匿名日序列，默认LST，可显式UTC。实测本公开点两段3天请求均200；同光学日期段见 `power_weather_aligned.json`，单位和fill_value保留在响应中。

[来源方法](https://power.larc.nasa.gov/docs/methodology/data/sources/)：本次温度/降水来自0.5°纬×0.625°经格网MERRA-2；近期可用GEOS-IT补尾，之后会更新。其他参数如IMERG有不同分辨率，不能把其0.1°宣传套到本次PRECTOTCORR。这里的点坐标/高度不代表实测站点。

[更新FAQ](https://power.larc.nasa.gov/docs/faqs/data/)：气象总体通常滞后2–3天；是回溯/近实时背景，不能替代未来预报或官方预警。LST不是Asia/Shanghai民用时间，UTC日最低温也不能直接当北京时间日最低温。若需要北京时间日统计，应另取小时数据明确聚合区间；本次没有执行小时扩取。

[由NASA维护的开放数据清单](https://registry.opendata.aws/nasa-power/) 说明使用/访问/下载开放并链接CC BY4.0，使用时保留NASA POWER、底层来源、取数日期和方法署名。

国内：国家气象信息中心 [CLDAS-V2.0 NRT产品页](https://k.data.cma.cn/mekb/?dataCode=NAFP_CLDAS2.0_NRT&r=data/detail) 明示0.0625°格网、1小时数据、滞后2天发布、普通注册用户访问。它是融合分析格网，仍不是地块实测；本次只读公开元数据，未注册、未下载。其他CMA目录的普通/实名/教育科研权限各异，不泛化为“CMA都无需实名”或“都能商用”。商用与再分发需核实具体产品条款。

## 4. GSCloud：企划书陈述仅部分成立

[官方Sentinel分类](https://www.gscloud.cn/sources/index?pid=446&ptitle=Sentinel%E6%95%B0%E6%8D%AE&rootid=1) 确实列S1/S2；[GF1 WFV说明](https://gscloud.cn/sources/details/428?pid=471) 确实列16米产品。实体访问页在本次匿名文本读取没有返回可下载资产，不能判断沙洋指定季节是否完整/已缓存，也未发现可直接承诺的公开生产API或更新SLA。

[官方版权页](https://www.gscloud.cn/help/detail/uses/160) 要求来源署名，并明确未经许可不得转让或传播其站内取得数据。[服务帮助](https://www.gscloud.cn/help/uses) 说明有仅存元数据需要预订的情况、批量通过申请/FTP和大批量需联系管理员。因此首版不把其数据打包再分发，不使用爬虫绕登录；仅将其列作需核实许可和稳定接口的备选。

## 5. 生产数据契约建议

### 每条记录必备

- `provider / collection / item_id / asset_key / asset_href_without_credentials / license_url / attribution / retrieved_at_utc / source_response_sha256`。公有样本与私有用户上传隔离。签名URL只用于短期传输，日志与公开manifest不存token。
- 分开 `acquired_at_utc / period_start_utc / period_end_utc / published_at / retrieved_at / processing_baseline / processor_version`。重处理以版本留痕，不静默覆盖历史算法输入。
- `record_kind`: public_aoi_smoke / field_observation / imported_observation / demo；`field_id` 只有真实用户地块关联成立才写入；demo不产生真实巡田任务。
- `access_status`: metadata_only / asset_verified / auth_required / requester_pays / unavailable；`operational_status`: experimental / connected / disabled。目录200不能把整个source标为已接入。
- 原始/目标 `CRS / axis_order / resolution / transform / pixel_dimensions / resampling / units / scale / offset / nodata`，几何版本、面积单位、采样窗口/地块buffer与像元覆盖方法。
- 观测质量 `total_pixel_count / usable_pixel_count / usable_area_fraction / cloud_fraction / shadow_fraction / snow_fraction / water_fraction / unclassified_fraction / acquisition_age / valid_observation_count / gap_days`。没有质量证据时为unknown，不是默认100%。

### 光学处理守卫

1. 原始nodata/缺陷先屏蔽；逐asset应用缩放，避免NDVI里忘了加性offset。验证STAC、GeoTIFF metadata与处理版本，冲突时拒绝或隔离记录。
2. 读取真正像元SCL/cloudmask。示例仅SCL4/5做植被指标；同时保留其余类占比，尤其水体变化，不能因为过滤而悄悄丢失潜在农情线索。SCL不是农作物分类真值。[ESA processing](https://sentiwiki.copernicus.eu/web/s2-processing) 给出类别定义。
3. SCL用nearest；光谱重采样策略记账。20m红边/SWIR或SAR不能因上采样而宣称获得10m真实信息。[ESA产品说明](https://sentiwiki.copernicus.eu/web/s2-products) 记录PB变更和边缘像元伪影，跨版本时序需检查。
4. tile云量只筛候选；可用覆盖必须针对目标地块计算。地块过小、窄条、边缘混合、丘陵阴影、配准偏移可能导致无足够纯像元。记有效像元数和边缘策略，不承诺每块田可监测；罗田需单独评估适用范围。
5. 单期/少量/长期缺测时输出“证据不足”，不输出零风险。不跨云缺口用插值制造异常证据。异常只表述需要核验的变化；收获/播期/花期/施肥/灌排等正常变化需现场和农事记录解释。

### 气象与融合守卫

- `-999`等缺测标记转null，留raw；℃与K、mm/day与mm/hour明确换算；禁止缺测当0雨量。
- 不把粗格网强插值为地块精度。标注“区域历史天气背景”，不作为病害/积水/冻害的确定诊断。
- 保留源模式、版本及日界；气象时间窗口必须与光学/农事事件明确对齐。
- 首版可存可审气象/SAR provenance，但只有真正接通且有质量证据的模态才参与模型。未验证融合增益、F1、提前量或经济效果一概不宣称。

## 6. 国内部署验收边界

本次只有助手云环境成功。部署前在目标大陆主机实测各catalog与asset域名的DNS/TLS、Range、超时、带宽和跨日稳定性，保留测量地点/时段。失败时显示数据未更新与最后合格观测，不把镜像抓取、第三方代理或受限下载当成默认补救；不绕登录、反爬或地理权限。缓存与离线导入仅限已获合法访问/存储/使用权的数据。
