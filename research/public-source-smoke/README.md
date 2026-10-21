# FieldSignal 数据接入核验

核验日期：2026-10-15 UTC。范围：企划书中的湖北沙洋公开区域、历史 Sentinel-2 / Sentinel-1 / 气象数据。附件已完整读取；没有使用用户私有地块、登录、注册、付费或上传数据。

## 可直接用于开发的结论

1. 第一条真实、免注册管线：**Earth Search v1 Sentinel-2 C1 L2A → 三个 COG 小窗 → 像元质量过滤 → NDVI**；NASA POWER 小 JSON 可同时保存为历史气象背景。
2. 已读到的是公开区域任意方窗，**没有已核实油菜地块、农情标签、时序异常、诊断或模型精度**。农业算法只能先对有真实地块和足够合格时序的记录运行。
3. Sentinel-1 三个目录能检索。CDSE 资产无凭据返回 401，Planetary Computer RTC 资产返回 409 且明确要求账户，Earth Search GRD 标为 Requester Pays。**SAR 未接通**，没有绕过或替它伪造观测。
4. GSCloud 有 S1/S2/GF-1 分类，但目录不是下载成功；官方版权声明限制未经许可的数据转让/传播。CMA CLDAS 有明确注册门槛，尚未下载、核实产品用途许可。
5. 本次网络来自助手云端，**不能据此宣称中国大陆部署网络可用或稳定**。

## 已验证样本

- 目录查询：WGS84 bbox [112.35, 30.65, 112.45, 30.75]，2025-03-01 至 2025-04-30；1 个低云候选。
- S2 item：S2A_T49RFP_20250428T031659_L2A；实际观测 2025-04-28T03:19:50.740Z；PB 05.11；EPSG:32649。
- 地物窗口：以公开坐标 [112.4,30.7] 附近取 320×320 米方窗，不是已知农户地块。B04/B08 各 32×32 像元，SCL 16×16 像元。
- 三个资产 HTTP Range 均 206、已由 GDAL 实际解码。B04/B08 为 UInt16、10 米、nodata=0、reflectance=DN×0.0001−0.1；STAC 与文件内缩放一致。SCL 为 Byte、20 米。
- SCL 原生计数：4=56、5=197、7=3。按本 smoke 的保守 4/5 类、nodata、非负反射率、有效分母规则，1012/1024 个 10 米像元通过，覆盖率 0.98828125。NDVI 中位 0.37450794。这个数值只证明计算路径可工作，不代表油菜长势或健康。
- 全景云量 3.250686%，与窗口有效覆盖率分别记录。最初检索还拿到全景云量 99.994% 的场景，证明“有场景”不等于“有合格观测”。
- 原始单波段对象约 240/258 MB，但只读取三个 COG 的 range 块和头，共 3,522,560 字节正文，约 3.36 MiB；未下载整景。元数据 JSON 和 HTTP headers 不计在此数中。
- NASA POWER：2025-04-26~28，T2M_MIN/T2M_MAX/PRECTOTCORR，HTTP200，798 字节；MERRA2/POWER，UTC日，℃/mm/day，缺测标志 −999。本次最后一天为 17.15℃ / 30.6℃ / 0.02 mm/day，**不是地块测站实测**。

## 文件与复现

- `public_sample_manifest.json`：可分享的规范化样本、许可链接、源状态及限制，供主项目接入文档使用。
- `SOURCES_AND_CONTRACT.md`：一手证据与生产数据契约建议。
- `optical_window_evidence.json`：逐资产 CRS、缩放、像元窗、范围请求、SHA256 与质量结果。
- `red_sample_320m.tif` / `nir_sample_320m.tif` / `scl_sample_320m.tif`：实际读取的小窗。
- `*_request.json`：查询URL、实际状态和响应摘要；相邻 JSON 保存公开元数据。
- `optical_http_trace.log`：只含公开无凭据 URL 的实际 GDAL Range 日志。
- `smoke_public_sources.py`：只读、固定小范围复现入口。默认两个小 JSON；加 `--pixels` 读取上述三个小窗，不要求账户或安装软件。

元数据复现：`python smoke_public_sources.py`

像元复现：`/usr/bin/python3 smoke_public_sources.py --pixels`

像元模式需要已有的 GDAL Python bindings 与 NumPy。本机 `/usr/bin/python3` 已有；普通 `python` 不一定有。脚本不安装依赖、不访问私有位置，不做全景下载；每次结果写入新的 `runs/时间戳`，避免覆盖最初核验证据。单次读取成功不构成服务 SLA。

分享这些修改后的 Sentinel 小窗时带上：**Contains modified Copernicus Sentinel data 2025**，并标注 Element 84 Earth Search / AWS、获取日期；气象标注 NASA POWER、MERRA-2 与获取日期。详见 manifest 中的许可原文链接。

补充：`CARM30_CANDIDATE_ONLY.md` 核实了历史油菜候选分布的原始来源、数据许可、分类码和时效限制；没有下载或引入当季标签。

复放确认：一键脚本完整执行退出码0；第二次同一item、有效覆盖/NDVI结果和三个小窗SHA256均与首轮一致，详见 `replay_verification.json`。
