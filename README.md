# FieldSignal

油菜地块监测 V0 本地工程。先完成“地块 → 观测 → 异常候选 → 巡田 → 人工核验”，再接真实田块和多源管线。FieldSignal为暂定工作名。2026-10-16增量已将历史公开样本接入独立、可复现的本地导入流程。

## 运行

Python 3.12、Node 24 LTS。建议独立虚拟环境，依赖来自官方 PyPI/npm，版本已固定。

```bash
python -m venv .venv
. .venv/bin/activate
python -m pip install -r backend/requirements-lock.txt
cd frontend && npm ci && npm run build && cd ..
bash scripts/run-local.sh
```

访问 http://127.0.0.1:8000/admin 管理端、http://127.0.0.1:8000/field 手机端。API约定：`GET /openapi.json`。仅监听本机，不适合直接公网部署；当前没有账号、租户隔离、推送或手机原生包。

默认空库，不自动下载卫星或发送地块位置。开发模拟数据需显式启用：`FIELDSIGNAL_ENABLE_FIXTURES=1 bash scripts/run-local.sh`，再在界面创建模拟数据或 `POST /api/v1/dev/fixtures`。模拟地块、观测、巡田和核验全链标识；不会当成实测。默认SQLite文件位于 `backend/var/`，不纳入代码仓库。

检查：`bash scripts/check.sh`。前端开发时在 `frontend` 运行 `npm run dev`，代理本机8000端口。

## 已实现与边界

- 地块边界校验、来源/质量/时效/入库时间、观测去重、农事记录与可追溯闭环
- 中位数/MAD统计基线及可选Isolation Forest；缺测、过期、样本不足不生成健康结论，分数不是概率
- 照片本地保存、去EXIF、大小与格式校验；幂等重传及核验提交，跨地块关联拒绝
- 管理与手机分开工作流；手机端为响应式Web/PWA方向原型，草稿与照片本地保存；尚未视觉验收或交付原生Android/iOS包
- 通用本地S2小窗/POWER归一化adapter与独立公开样本导入已实现：管理端「数据接入」显式触发，校验哈希、质量及时间；不接入农户地块，SAR尚未接通

## 导航

- [五层架构与产品范围](docs/product-architecture.md)
- [字段和API](docs/api-contract.md)
- [数据源可行性与真实性边界](docs/data-sources.md)
- [本地真实数据管线与导入契约](docs/local-observation-import.md)
- [下一阶段提案](docs/proposal-v0.md)
- [验证记录](docs/verification.md)

开发变更通过 Draft PR 审阅；当前工程仅用于本地验证。
