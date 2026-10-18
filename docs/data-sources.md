# 数据源现状与可插拔契约

核验日期：2026-10-15。目录可搜索、资产可读取、可形成田块观测、能部署生产是不同状态。本轮没有把任何公开方窗声明为已知油菜田，没有真实标签或模型效果。

| 来源 | 本轮实际证据 | 当前接入状态与限制 |
| --- | --- | --- |
| Element 84 Earth Search / Sentinel-2 C1 L2A | 公开AOI返回目录200；2025-04-28 B04/B08/SCL实际Range 206并解码32×32/16×16小窗 | 公开样本验证完成，尚未接真实田块；中国大陆网络可达性未测 |
| NASA POWER daily | 公开坐标3日T2M_MIN/T2M_MAX/PRECTOTCORR实际200小JSON | 可用作回溯气象上下文，0.5°×0.625°粗网格，非地块测站或未来预报 |
| Sentinel-1 CDSE | 目录200；无凭据资产401 | auth_required，未接通 |
| Planetary Computer S1 RTC | 目录200；无签名资产409；集合要求账户 | auth_required，未接通；10m采样不等于10m原始分辨率 |
| Earth Search S1 GRD | 目录200；资产标注Requester Pays | cost_approval_required，未读资产；GRD幅度不是RTC gamma0 |
| GSCloud / GF-1 | 官方目录与说明可读，资产与具体权利未验证 | 待授权备选，禁止假设可自由转让/再分发 |
| CMA CLDAS | 官方产品元数据已读，资产未读 | 注册/产品授权独立确认；未接通 |

## 公开样本的正确解释

独立证据位于 `research/public-source-smoke/`。样本为沙洋附近公开任意320m方窗，2025-04-28单日，非真实农户边界；没有油菜类别真值。公开样本NDVI只验证读取、缩放、掩膜与计算管线，不能作为时序异常、病害或作物诊断。

S2 C1 L2A此次资产scale=0.0001、offset=-0.1、nodata=0，必须逐资产读取元数据，不能把旧集合偏移处理方式硬编码到新集合。B04/B08为10m，SCL为20m；最近邻对齐不增加空间信息。整景云量不等于地块有效像元比例。来源署名保留“Contains modified Copernicus Sentinel data 2025”及Earth Search/AWS访问记录，不擅自改成CC许可。

POWER为UTC日，不能直接改名成北京时间日；保留摄氏度、mm/day、空间网格与源模型。-999为缺失，不能变成零降水。官方档案通常滞后2–3天，非实时官方灾害预警。

## 导入边界

2026-10-16：`LocalObservationBundleAdapter.normalize`已实现合法本地S2窗口与POWER JSON处理，返回类型化ObservationCreate；公开样本通过独立source_imports入库，真实地块继续使用已有归一化指标接口。实现、复现与限制详见[本地导入契约](local-observation-import.md)。无后台自动出网。用户私有地块坐标、边界、照片不会被发送给这些来源。

每个adapter必须保存：provider、collection、item_id/source_record_id、processing_version、源许可、acquired/observed_at、ingested_at、空间分辨率、时段支持、quality/missing mask。S1后续额外保存升降轨/相对轨道/极化、单位与RTC/GRD定义；不能混轨直接比较。新数据源不得绕过账户、费用、下载条款或位置共享授权。

## 主要官方来源

- [Earth Search官方项目与使用说明](https://github.com/Element84/earth-search)
- [此次S2 STAC记录](https://earth-search.aws.element84.com/v1/collections/sentinel-2-c1-l2a/items/S2A_T49RFP_20250428T031659_L2A)
- [Copernicus Sentinel数据法律说明](https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice)
- [S2处理与SCL](https://sentiwiki.copernicus.eu/web/s2-processing)
- [POWER日API](https://power.larc.nasa.gov/docs/services/api/temporal/daily/)
- [POWER源分辨率](https://power.larc.nasa.gov/docs/methodology/data/sources/)
- [POWER数据时效](https://power.larc.nasa.gov/docs/faqs/data/)
- [CDSE STAC文档](https://documentation.dataspace.copernicus.eu/APIs/STAC.html)
- [S1 Requester Pays说明](https://roda.sentinel-hub.com/sentinel-s1-l1c/GRD/readme.html)
- [GSCloud使用版权说明](https://www.gscloud.cn/help/detail/uses/160)

技术实现参考：[FastAPI](https://fastapi.tiangolo.com/tutorial/)、[Pydantic严格类型](https://docs.pydantic.dev/latest/concepts/strict_mode/)、[SQLite外键](https://www.sqlite.org/foreignkeys.html)、[Isolation Forest](https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.IsolationForest.html)。代码固定本机实际测试版本，不意味着使用各项目最新版。
