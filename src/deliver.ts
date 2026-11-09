/** 主动投递路由（契约 docs/rpc-contract.md §2，P-B）：把外部系统的一条文本构造为
 *  非人类 Trigger（human:false、meta.deliver=true、actor=本包源标识）交
 *  source.receive()，回复由引擎 channel.send 回到目标 thread。路由挂引擎
 *  webServer seam（同源闸门与引擎管理 API 同款，先例 wechat/dws 面板路由）：
 *
 *  - POST /dsh-qq/api/deliver       {targetId,text,kind?} → {ok,accepted,triggerId}
 *  - POST /dsh-qq/api/deliver/test  {targetId} → 直调 sendPassiveReply 发双语测试
 *                                   文案（不经引擎）→ {ok,sent,detail}
 *  - GET  /dsh-qq/api/health        状态 + in/out/fail/deny 计数 + 最近 20 条
 *                                   failure-log + dedup 水位
 *
 *  错误码（契约 §1）：400 {error:'bad-request',detail} / 404 {error:'unknown-target'}
 *  / 409 {error:'not-ready'}；受理即响应（收件即受理，完成与否见既有 failure-log）。
 *  平台约束（被动回复窗口）：QQ 官方机器人回复恒为被动回复（msg_id 引用入站消息，
 *  见 robot.ts 头注）——deliver trigger / test 均需要目标 address 带最近入站
 *  msg_id 才能真正发出；窗口过期/缺失时 channel.send 失败走既有 failure-log，
 *  test 明确返回 ok:false。目标 admission 与入站同规则（c2c 走 directMessages
 *  闸门、群须已登记 groups，kind scope() 判 listened）。 */
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SourceContextLike, TriggerLike } from './types.ts'
import { sendPassiveReply } from './robot.ts'
import { channelConfig, flowStats, type QqConfig } from './qq-kind.ts'
import { SEEN_LIMIT } from './dedup.ts'
import { sendFailuresFile } from './failure-log.ts'
import { findTarget, touchTarget, validTargetId, type TargetRecord } from './targets.ts'

/** @deepseek-ai/dsh-host-webserver 的结构化最小面（不引入包依赖；先例 wechat/dws）。 */
export interface WebServerLike {
  readonly port: number
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

export const ROUTE_PREFIX = '/dsh-qq/api'

const MAX_BODY_BYTES = 64 * 1024

export interface DeliverDeps {
  /** 引擎 source 上下文持有者（receive 入口）；未就绪返回 undefined。 */
  source: () => SourceContextLike | undefined
  /** 状态目录覆盖（测试注入）；缺省 ~/.local/state/dsh-superagent-qq。 */
  baseDir?: string
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) { res.end(); return }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** 引擎同款同源闸门（wechat bind-panel.ts sameOrigin 的镜像实现）：Host 必须
 *  loopback:<port> + x-orchestrator-request: 1 + Origin 缺省或同源。 */
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) return false
  return req.headers['x-orchestrator-request'] === '1' &&
    (req.headers.origin === undefined || req.headers.origin === 'http://' + host)
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { resolve(undefined); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) }
      catch { resolve(undefined) }
    })
    req.on('error', () => resolve(undefined))
  })
}

function ready(config: QqConfig | undefined): boolean {
  return !!config && config.accounts.some((a) => a.appId && a.appSecret)
}

const stateDetail = (config: QqConfig | undefined): string =>
  ready(config)
    ? 'bot accounts configured; connection state rides the qqGateway health entry'
    : 'waiting for appId / AppSecret in settings'

/** 双语测试文案（/deliver/test 专用）。 */
const testText = (): string => '【dsh-superagent-qq】主动投递测试消息 / Delivery test message — ' + new Date().toISOString()

const accountOf = (config: QqConfig, address: Record<string, string>) =>
  config.accounts.find((a) => a.appId === String(address.account ?? '')) ?? config.accounts.find((a) => a.appId && a.appSecret)

/** 把一条投递文本构造为非人类 Trigger（契约 §2）：human:false、meta.deliver=true、
 *  addressed:'direct'（显式推送按「明确指派」走 admission）、actor=本包源标识。
 *  address 形状：{openid, scope?}（scope 'group' 为群，缺省 c2c 单聊）；可选
 *  account 指定 appId、msgId 引用最近入站消息（被动回复窗口必需）。 */
export function buildDeliverTrigger(target: TargetRecord, text: string, kind: 'notice' | 'reply', config: QqConfig): TriggerLike | undefined {
  const address = target.address ?? {}
  const openid = String(address.openid ?? '')
  if (!openid) return undefined
  const account = accountOf(config, address)
  if (!account) return undefined
  const scope = address.scope === 'group' ? 'group' : 'c2c'
  const id = 'qq:deliver:' + randomUUID()
  if (scope === 'group') {
    return {
      id,
      source: 'qq',
      threads: [{ source: 'qq', id: 'g:' + openid }],
      actor: { source: 'qq', id: 'deliver' },
      human: false,
      addressed: 'direct',
      at: new Date().toISOString(),
      text,
      channel: { source: 'qq', thread: 'qq:g:' + openid,
        address: { account: account.appId, scope: 'group', openid, msgId: String(address.msgId ?? '') } },
      meta: { accountId: account.appId, scopeKind: 'group', groupOpenid: openid, messageId: id, deliver: true, kind },
    }
  }
  return {
    id,
    source: 'qq',
    threads: [{ source: 'qq', id: 'c:' + openid }],
    actor: { source: 'qq', id: 'deliver' },
    human: false,
    addressed: 'direct',
    at: new Date().toISOString(),
    text,
    channel: { source: 'qq', thread: 'qq:c:' + openid,
      address: { account: account.appId, scope: 'c2c', openid, msgId: String(address.msgId ?? '') } },
    meta: { accountId: account.appId, scopeKind: 'c2c', messageId: id, deliver: true, kind },
  }
}

/** /deliver/test：不经引擎，直调既有发送函数（sendPassiveReply）。被动回复必须
 *  引用入站 msg_id（官方 send-receive 契约）：目标缺 address.msgId 时明确返回
 *  ok:false；发送失败（含超回复窗口）折进 detail 不抛出。 */
export async function deliverTestSend(target: TargetRecord, config: QqConfig): Promise<{ ok: boolean; sent: boolean; detail: string }> {
  const address = target.address ?? {}
  const openid = String(address.openid ?? '')
  const scope = address.scope === 'group' ? 'group' as const : 'c2c' as const
  const account = accountOf(config, address)
  if (!openid || !account) return { ok: false, sent: false, detail: 'qq: target address needs openid (and a configured bot account)' }
  const msgId = String(address.msgId ?? '')
  if (!msgId) return { ok: false, sent: false, detail: 'qq: passive reply needs a recent inbound msgId (reply window); create the target with address.msgId captured from an inbound message' }
  try {
    await sendPassiveReply(account.appId, account.appSecret, { scope, openid, msgId }, testText())
    return { ok: true, sent: true, detail: 'passive reply sent (' + scope + ' ' + openid + ')' }
  } catch (error) {
    return { ok: false, sent: false, detail: String(error).slice(0, 300) }
  }
}

interface FailureTailEntry { at?: string; channelKey?: string; kind?: string; error?: string }

/** failure-log 尾巴（契约：最近 20 条）；单行损坏不拖垮整表。 */
async function failureTail(baseDir?: string): Promise<FailureTailEntry[]> {
  try {
    const lines = (await readFile(sendFailuresFile(baseDir), 'utf8')).split('\n').filter((l) => l.trim())
    return lines.slice(-20).map((line) => {
      try { return JSON.parse(line) as FailureTailEntry } catch { return { error: 'unparsable failure-log line' } }
    })
  } catch { return [] }
}

/** dedup 水位：扫状态目录 seen-*.json 汇总各 store 的 id 数（qq seen 文件为裸数组；
 *  单文件损坏跳过）。 */
async function dedupWatermark(baseDir?: string): Promise<{ stores: number; ids: number; limit: number }> {
  const dir = baseDir ?? join(homedir(), '.local', 'state', 'dsh-superagent-qq')
  let names: string[] = []
  try { names = await readdir(dir) } catch { return { stores: 0, ids: 0, limit: SEEN_LIMIT } }
  let stores = 0
  let ids = 0
  for (const name of names) {
    if (!name.startsWith('seen-') || !name.endsWith('.json')) continue
    stores += 1
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), 'utf8')) as unknown
      if (Array.isArray(parsed)) ids += parsed.length
    } catch { /* 单文件损坏跳过 */ }
  }
  return { stores, ids, limit: SEEN_LIMIT }
}

async function handleDeliver(req: IncomingMessage, res: ServerResponse, deps: DeliverDeps): Promise<void> {
  const body = await readJsonBody(req)
  if (!body) { respondJson(res, 400, { error: 'bad-request', detail: 'invalid JSON body' }); return }
  const { targetId, text, kind } = body as { targetId?: unknown; text?: unknown; kind?: unknown }
  if (!validTargetId(targetId)) { respondJson(res, 400, { error: 'bad-request', detail: 'targetId must be 1-128 chars of [A-Za-z0-9._@:-]' }); return }
  if (typeof text !== 'string' || !text.trim()) { respondJson(res, 400, { error: 'bad-request', detail: 'text must be a non-empty string' }); return }
  const kindValue = kind === undefined ? 'notice' : kind
  if (kindValue !== 'notice' && kindValue !== 'reply') { respondJson(res, 400, { error: 'bad-request', detail: "kind must be 'notice' or 'reply'" }); return }
  const target = await findTarget(targetId, deps.baseDir)
  if (!target) { respondJson(res, 404, { error: 'unknown-target' }); return }
  const config = channelConfig.current
  const source = deps.source()
  if (!config || !source || !ready(config)) { respondJson(res, 409, { error: 'not-ready' }); return }
  const trigger = buildDeliverTrigger(target, text, kindValue, config)
  if (!trigger) { respondJson(res, 400, { error: 'bad-request', detail: 'unroutable target address (needs openid and a configured bot account)' }); return }
  try {
    await source.receive(trigger)
  } catch (error) {
    respondJson(res, 500, { error: 'internal', detail: String(error).slice(0, 300) })
    return
  }
  // lastUsedAt 落盘后再应答（本地小文件原子写；确定性优先，测试也据此断言）。
  await touchTarget(targetId, deps.baseDir)
  respondJson(res, 200, { ok: true, accepted: true, triggerId: trigger.id })
}

async function handleDeliverTest(req: IncomingMessage, res: ServerResponse, deps: DeliverDeps): Promise<void> {
  const body = await readJsonBody(req)
  if (!body) { respondJson(res, 400, { error: 'bad-request', detail: 'invalid JSON body' }); return }
  const { targetId } = body as { targetId?: unknown }
  if (!validTargetId(targetId)) { respondJson(res, 400, { error: 'bad-request', detail: 'targetId must be 1-128 chars of [A-Za-z0-9._@:-]' }); return }
  const target = await findTarget(targetId, deps.baseDir)
  if (!target) { respondJson(res, 404, { error: 'unknown-target' }); return }
  const config = channelConfig.current
  if (!config || !ready(config)) { respondJson(res, 409, { error: 'not-ready' }); return }
  respondJson(res, 200, await deliverTestSend(target, config))
}

async function handleHealth(_req: IncomingMessage, res: ServerResponse, deps: DeliverDeps): Promise<void> {
  const config = channelConfig.current
  respondJson(res, 200, {
    ok: true,
    state: ready(config) ? 'ready' : 'paused',
    detail: stateDetail(config),
    counters: { in: flowStats.in, out: flowStats.out, fail: flowStats.fail, deny: flowStats.deny, last: flowStats.lastFailAt || '-' },
    failures: await failureTail(deps.baseDir),
    dedup: await dedupWatermark(deps.baseDir),
  })
}

/** 路由处理器（测试注入点：直接拿 handler 挂在任意 http server 上，url 需带前缀）。 */
export function createDeliverHandler(deps: DeliverDeps, port: number): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!sameOrigin(req, port)) { respondJson(res, 403, { error: 'Same-origin management request required' }); return }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(ROUTE_PREFIX.length) : ''
    if (path === '/deliver' && req.method === 'POST') { await handleDeliver(req, res, deps); return }
    if (path === '/deliver/test' && req.method === 'POST') { await handleDeliverTest(req, res, deps); return }
    if (path === '/health' && req.method === 'GET') { await handleHealth(req, res, deps); return }
    respondJson(res, 404, { error: 'not found' })
  }
}

/** 在引擎 webserver 上注册 /dsh-qq/api 前缀路由，返回卸载 disposer。 */
export function registerDeliverRoutes(webServer: WebServerLike, deps: DeliverDeps): () => void {
  const handler = createDeliverHandler(deps, webServer.port)
  return webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => {
      handler(req, res).catch((error: unknown) => {
        console.error('[qq-deliver] request error: ' + String(error).slice(0, 200))
        respondJson(res, 400, { error: 'bad request' })
      })
    },
  })
}
