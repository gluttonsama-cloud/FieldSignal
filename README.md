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

服务端数据备份：先准备仓库外的私有目录，再显式运行 `python scripts/backup-local.py --database backend/var/fieldsignal.sqlite3 --output ../private-backups/fieldsignal-20261018.sqlite3`。若使用 `FIELDSIGNAL_DB`，请改为实际数据库路径。命令通过 SQLite backup API 获取包含已提交 WAL 内容的一致快照，校验后生成新的单文件，不覆盖已有目标、不迁移或恢复运行库。备份包含服务端记录与照片 BLOB，不含浏览器未提交草稿或原始导入文件；CSV 和源码包不能代替它。备份未加密，请保留在私有位置，不要上传仓库或外发。

## 已实现与边界

- 地块边界校验、来源/质量/时效/入库时间、观测去重、农事记录与可追溯闭环
- 中位数/MAD统计基线及可选Isolation Forest；缺测、过期、样本不足不生成健康结论，分数不是概率
- 照片本地保存、去EXIF、大小与格式校验；幂等重传及核验提交，跨地块关联拒绝
- 重复图片会在最终核查发送前明确提示保留一张；移除一个重复项不删除仍被保留照片使用的上传副本，旧版错误删除队列可安全修复后重试
- 管理与手机分开工作流；手机端为响应式Web/PWA方向原型，草稿与照片本地保存；尚未视觉验收或交付原生Android/iOS包
- 通用本地S2小窗/POWER归一化adapter与独立公开样本导入已实现：管理端「数据接入」显式触发，校验哈希、质量及时间；不接入农户地块，SAR尚未接通
- 现场核查提交前可核对完整内容、照片与任务身份；待巡田支持计划日期、执行人标签和地块组合筛选，本机草稿不被筛掉
- 同地块规范化观测支持明确核对后整批导入，冲突整批回滚，已有一致记录复用；不自动运行分析
- 地块、巡田、计划与农事保存须有与原提交匹配的回执；响应损坏或结果不确定时保留表单供手动原样重试，不误报成功
- 核查与照片上传须核对任务/地块/提交编号、内容和照片引用后才能确认；不一致保留本机草稿与照片，清理绑定实际发送版本，不误删请求期间的新草稿
- 已保存核查可按关键词、报告标签、观察日期和地块查找，按当前已应用结果下载 CSV；保留原始时间与完整身份，不把已加载部分当全部服务端数据
- 已读取农事可按当前地块单独下载 CSV，保留 API 日期、保存时间与原始备注，注明读取快照和非诊断性质；不与核查导出或本机草稿混合
- 已保存报告可明确安排关联复查，固定原地块并保留来源核查；同一来源只允许一个待完成复查，不自动重开候选、发送通知或修改原报告
- 服务读取结构异常时保留上次有效核心数据，不把错误改成空列表；本机草稿仍可打开，恢复后可手动刷新，农事与观测错误独立提示

## 导航

- [五层架构与产品范围](docs/product-architecture.md)
- [字段和API](docs/api-contract.md)
- [数据源可行性与真实性边界](docs/data-sources.md)
- [本地真实数据管线与导入契约](docs/local-observation-import.md)
- [下一阶段提案](docs/proposal-v0.md)
- [验证记录](docs/verification.md)

开发变更通过 Draft PR 审阅；当前工程仅用于本地验证。

## PR 检查

GitHub Actions 使用 Python 3.12、Node 24，在独立虚拟环境中安装锁定依赖，运行源码摘要、后端/前端测试、生产构建及隔离 HTTP 检查。每次结果以对应提交的 Checks 为准；不包含部署或浏览器视觉验收。
