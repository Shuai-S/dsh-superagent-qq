/**
 * dsh-superagent-qq — QQ official bot Source for dsh-superagent.
 *
 * Registers the 'qq' Source kind through the same extension seam the
 * bundled watchers use (inject 'orchestrator'), then keeps a WebSocket
 * gateway connection per configured bot alive: group @-messages and C2C
 * messages arrive in real time, become Triggers, and replies go back through
 * the OpenAPI as passive replies.
 *
 * @module dsh-superagent-qq
 */
import type { Context } from '@deepseek-ai/cordis'
import type { OrchestratorLike } from './types.ts'
import { qqKind, HEALTH_ENTRY } from './qq-kind.ts'
import { watch } from './watch.ts'
import { registerDeliverRoutes, type WebServerLike } from './deliver.ts'

export const name: string = 'dsh-superagent-qq'
// webServer = 引擎面板 webserver（同源 /dsh-qq/api 路由 seam，先例 wechat/dws 面板路由）。
export const inject: string[] = ['orchestrator', 'webServer']

export function apply(ctx: Context): void {
  const orchestrator = (ctx as unknown as { orchestrator: OrchestratorLike }).orchestrator
  ctx.effect(() => orchestrator.sources.register(qqKind), 'qq: source kind')
  ctx.effect(() => {
    const source = orchestrator.context(qqKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal).catch((error: unknown) => {
      source.report(HEALTH_ENTRY, { state: 'error', detail: String(error) })
    })
    return async () => { controller.abort(); await running }
  })
  // 主动投递路由（契约 §2，P-B）：qq 首次引入 webServer seam——seam 不在时
  // log 一次并跳过路由注册（不影响 Source 本体），注册异常同样吞掉不崩启动。
  const webServer = (ctx as unknown as { webServer?: WebServerLike }).webServer
  if (webServer) {
    try {
      ctx.effect(() => registerDeliverRoutes(webServer, { source: () => orchestrator.context(qqKind) }), 'qq: deliver routes')
    } catch (error) {
      console.error('[qq] deliver routes unavailable (webServer seam failed): ' + String(error).slice(0, 200))
    }
  } else {
    console.error('[qq] webServer seam absent; /dsh-qq/api deliver routes skipped')
  }
}
export { qqKind, QqConfigSchema, channelConfig, flowStats } from './qq-kind.ts'
export { buildTrigger, withFlowDetail } from './watch.ts'
export { chunkText, QQ_TEXT_LIMIT_BYTES } from './chunk.ts'
export { SEEN_LIMIT, sanitizeSegment, seenFile, seenOrAdd } from './dedup.ts'
export { FAILURE_ERROR_MAX, FAILURE_LOG_LIMIT, logSendFailure, sendFailuresFile } from './failure-log.ts'
export { GROUP_AND_C2C_EVENT, classifyPayload, heartbeatPayload, identifyPayload, resumePayload } from './gateway.ts'
export { attachmentKey, isImageContentType, mediaKindOf } from './robot.ts'
// ACL 访问模式（契约 §3，vendored tools/acl/acl.ts）与主动投递目标表/路由（契约 §2）
export { evaluateAcl, aclDenyNoticeText } from './acl.ts'
export type { AclDenyText, AclInput, AclPolicy, AclVerdict } from './acl.ts'
export { targetsFile, readTargets, writeTargets, findTarget, touchTarget, validTargetId, TARGET_ID_MAX, TARGET_ID_RE, TARGETS_VERSION, type TargetRecord, type TargetsFile } from './targets.ts'
export { ROUTE_PREFIX, buildDeliverTrigger, createDeliverHandler, deliverTestSend, registerDeliverRoutes, sameOrigin, type DeliverDeps, type WebServerLike } from './deliver.ts'
