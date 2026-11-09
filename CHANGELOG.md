# 更新日志

本包遵循 Keep a Changelog 风格；发布以 npm 为准（registry 回读为准绳，本地版本号不算已发布）。

## [Unreleased]

### Added
- ACL 访问模式（契约 docs/rpc-contract.md §3）：配置增可选 `policy`（`{mode:'allowlist'|'open', allowUsers, groupOnly?, denyText?:{zh,en}}`；不设 = 全放行向后兼容，形状非法按 schema 拒绝不做静默降级）；vendored `tools/acl/acl.ts` → `src/acl.ts`（纯函数判定，零 npm 依赖）；判定在派发（source.receive）之前、去重之后（重放不重复计数）：拒绝尝试被动回复回执 denyText（引用入站 msg_id），超回复窗口/发送失败仅记 stderr——回执失败不是发送失败，不入 failure-log；deny 计数并入健康 detail（in=/out=/fail=/deny=/last=）。会话类型信号用 M1 真机核对的字段集（probe.mjs）：群消息带 group_openid、单聊带 user_openid（payload 无 group_type 字段）。
- 主动投递（契约 §2，P-B）：inject 增 `webServer`（qq 首次引入；seam 不在时 log 一次并跳过路由注册，不崩启动）；路由前缀 `/dsh-qq/api`——`POST /deliver`（`{targetId,text,kind?}` 构造非人类 Trigger（`human:false`、`meta.deliver:true`、`addressed:'direct'`、actor=`deliver`）交 `source.receive()`；400/404/409/受理语义按契约；c2c 目标走 directMessages 闸门、群目标须已登记 groups，与入站同规则）、`POST /deliver/test`（不经引擎直调 sendPassiveReply 发双语测试文案，返回 `{ok,sent,detail}`；被动回复必须引用入站 msg_id——目标 address 缺 msgId 时明确返回不可测，超回复窗口折进 detail）、`GET /health`（状态 + in/out/fail/deny 计数 + 最近 20 条 failure-log + dedup 水位）；目标表 `~/.local/state/dsh-superagent-qq/targets.json`（targetId 1–128 字符 `[A-Za-z0-9._@:-]`，tmp+rename 原子写；目标管理 UI 属 P-C'）。
- 主动投递引擎侧配置前提（实读引擎 src/policy.ts machineGate / src/sources/registry.ts，2026-11-09，引擎升级后需复核）：非人类 Trigger 过引擎 machineGate——settings 里 `policy.sources.qq.bots` 需列出投递 actor（本包恒为 `{ "id": "deliver" }`）且 `eval.mode ≠ "off"`，否则以 `not_human` 被静默忽略（auto 模式下 inferred 候选才转工单）；本包 deliver trigger 恒带 `addressed:'direct'`（machineGate 的 addressed 门）且 meta 带齐 qq kind `scope()` 判 listened 所需字段（accountId / scopeKind / groupOpenid）。
- 测试：`test/acl.test.mjs`（判定纯函数：缺省放行 / 命中 / 未命中 / 大小写敏感 / groupOnly 兜底 / 拒绝回执文案）与 `test/deliver.test.mjs`（targets 读写 / 原子写 / targetId 校验 / 400 / 404 / 409 / 受理 trigger 形状断言（c2c 与 group 双形状）/ deliver:test 被动回复桩（缺 msgId / 成功 / 窗口失败三路）/ health 水位 / sameOrigin 403，零网络）。
- verify-package.mjs 增路由契约探针：lib/index.js 含 `/dsh-qq/api` 前缀串与 `/deliver` 字面量（防路由名漂移）；client bundle 探针 N/A（本包无 client bundle，「源设置」页壳属 P-C'）。
- P-C\'（契约 §1/§4）：「源设置」共享页壳接入——vendored shell + src/shell/tab.ts（健康/目标 CRUD/deliver 测试，address=msgId（被动回复窗口内）+openId）+ src/client.ts 新 client bundle 入口（esbuild --bundle devDep 豁免；react 宿主 require）；targets CRUD 路由 + targets.ts 增 upsert/remove；投递 actor id 统一为 dsh-superagent-qq
- 工程化闸门：新增 .github/workflows/ci.yml（push main + pull_request：pnpm install --frozen-lockfile → pnpm check → pnpm test → node scripts/verify-package.mjs）与 scripts/verify-package.mjs（零依赖：files[] 存在性、lib/index.js 探针、cordis.patch.yml 入口、locale 双语 key 对齐、icon.svg、dsh.compatibility）。
- 测试体系：test/*.test.mjs（node:test + node:assert，从构建产物 ../lib/index.js 导入，零网络零引擎）：QqConfigSchema 默认/拒绝、buildTrigger 群 @/C2C/附件/落盘分支、gateway op 分型与 identify/resume/heartbeat payload 构造、chunkText UTF-8 边界、dedup 串行与 FIFO、failure-log 滚动与静默。
- 渠道健壮性：src/dedup.ts——稳定消息 id 插件侧去重（每 bot 一个 seen store：~/.local/state/dsh-superagent-qq/seen-<bot>.json，上限 1000，串行 + tmp+rename 原子写，存储不可写降级放行），接入 watch.ts 事件路径，重放消息不再重复下载媒体与触发；src/chunk.ts——UTF-8 安全边界分块（单码点超限独立成块）；src/failure-log.ts——send 失败 JSONL（send-failures.jsonl，上限 200 行，{at,channelKey,kind,error≤300}，无凭据，写失败不影响主流程）。
- 健康上报：qqGateway detail 追加 in=/out=/fail=/last= 紧凑流量计数（paused 态除外）。
- 兼容性声明：package.json 增 dsh.compatibility（0.2.2-rc.1；本机 dsh CLI 实测，2026-11-09）。

### Changed
- channel.send：回复文本按 2000 字节（unverified 保守值，官方文档未检索到明示上限，2026-11-09 检索）UTF-8 安全边界分块；块 1 失败照常抛出交引擎退避重试，k>1 块失败记日志（含 failure-log）并按已送达收尾。

## [0.1.1] - 未发布（本地版本号，registry 尚无 0.1.1）

### Added
- 插件页双语标题/描述、icon.svg 与官方形式详情页（hero 插画 zh/en、meta.detail、files 白名单）。
- tag 触发的 release 工作流（npm 发布 + GitHub Release）与 prepare 构建。

### Changed
- README 重写：移除内部里程碑清单，probe 重定位为连接自检。

## [0.1.0] - 2026-11-04

### Added
- 首个 npm 版本：QQ 官方机器人 Source——WebSocket 网关直连（群 @ 与 C2C 实时进引擎链路）、被动回复送达、图片标记按需下载、文件/视频/语音落盘、WS resume 断线续会话、scripts/probe.mjs 连接自检。
