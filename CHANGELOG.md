# 更新日志

本包遵循 Keep a Changelog 风格；发布以 npm 为准（registry 回读为准绳，本地版本号不算已发布）。

## [Unreleased]

### Added
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
