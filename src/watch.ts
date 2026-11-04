/** QQ gateway lifecycle: one GatewayClient per configured bot account; message
 *  events become Triggers (stable ids dedupe server redeliveries); connection
 *  state reports to health each poll round, which also throttles reconnection
 *  (one attempt per 5s round). */
import type { SourceContextLike, TriggerLike } from './types.ts'
import { channelConfig, HEALTH_ENTRY } from './qq-kind.ts'
import type { QqAccount, QqConfig } from './qq-kind.ts'
import { GatewayClient, type GatewayEvent } from './gateway.ts'

/** Inbound message payload (`d`) of GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE;
 *  field names verified against real traffic by scripts/probe.mjs (M1 gate). */
export interface QqMessagePayload {
  id?: string
  content?: string
  group_openid?: string
  user_openid?: string
  timestamp?: string
  author?: { member_openid?: string; user_openid?: string; [key: string]: unknown }
  [key: string]: unknown
}

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    const stop = () => { clearTimeout(timer); resolve() }
    signal.addEventListener('abort', stop, { once: true })
  })
}

const isoAt = (d: QqMessagePayload): string => {
  const ts = typeof d.timestamp === 'string' ? d.timestamp : undefined
  if (ts) {
    const parsed = new Date(ts)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return new Date().toISOString()
}

/** Event -> Trigger; undefined for anything we cannot map (logged and skipped). */
export function buildTrigger(account: QqAccount, d: QqMessagePayload, at?: string): TriggerLike | undefined {
  const msgId = String(d.id ?? '')
  const content = String(d.content ?? '').trim()
  if (!msgId || !content) return undefined
  const groupOpenid = typeof d.group_openid === 'string' && d.group_openid ? d.group_openid : undefined
  const userOpenid = typeof d.user_openid === 'string' && d.user_openid ? d.user_openid : undefined
  // 群聊发件人在 author.member_openid；单聊在 author.user_openid / user_openid（字段名 M1 真机核对）。
  const actorId = String(d.author?.member_openid ?? d.author?.user_openid ?? d.user_openid ?? '')
  if (!actorId) return undefined
  const atIso = at || isoAt(d)
  if (groupOpenid) {
    return {
      id: 'qq:' + msgId,
      source: 'qq',
      threads: [{ source: 'qq', id: 'g:' + groupOpenid }],
      actor: { source: 'qq', id: actorId },
      human: true,
      addressed: 'mention',
      at: atIso,
      text: content,
      channel: { source: 'qq', thread: 'qq:g:' + groupOpenid,
        address: { account: account.appId, scope: 'group', openid: groupOpenid, msgId } },
      meta: { accountId: account.appId, scopeKind: 'group', groupOpenid, messageId: msgId },
    }
  }
  if (userOpenid) {
    return {
      id: 'qq:' + msgId,
      source: 'qq',
      threads: [{ source: 'qq', id: 'c:' + userOpenid }],
      actor: { source: 'qq', id: actorId },
      human: true,
      addressed: 'direct',
      at: atIso,
      text: content,
      channel: { source: 'qq', thread: 'qq:c:' + userOpenid,
        address: { account: account.appId, scope: 'c2c', openid: userOpenid, msgId } },
      meta: { accountId: account.appId, scopeKind: 'c2c', messageId: msgId },
    }
  }
  return undefined
}

const HANDLED_EVENTS = new Set(['GROUP_AT_MESSAGE_CREATE', 'C2C_MESSAGE_CREATE'])

async function handleEvent(source: SourceContextLike, account: QqAccount, event: GatewayEvent, dumped: Set<string>): Promise<void> {
  const t = String(event.t ?? '')
  if (!HANDLED_EVENTS.has(t)) {
    console.error('[qq] event ignored: t=' + (t || '(none)'))
    return
  }
  const d = (event.d ?? {}) as QqMessagePayload
  if (!dumped.has(account.appId)) {
    dumped.add(account.appId)
    // 每账号首条消息 dump 原始 payload（≤500 字符）：核对真实字段名（M1）。
    console.error('[qq] first payload dump (' + account.appId + ' ' + t + '): ' + JSON.stringify(d).slice(0, 500))
  }
  const trigger = buildTrigger(account, d)
  if (!trigger) {
    console.error('[qq] skip msg: t=' + t + ' id=' + String(d.id ?? '') + ' (missing fields after parse)')
    return
  }
  console.error('[qq] msg in: t=' + t + ' msgId=' + String(d.id ?? '') + ' scope=' + String(trigger.meta.scopeKind)
    + ' actor=' + trigger.actor.id + ' text="' + trigger.text.slice(0, 60) + '"')
  await source.receive(trigger)
}

interface WatchState {
  hash: string
  clients: Map<string, GatewayClient>
  /** first raw message payload per account, dumped once for field-name verification (M1) */
  dumped: Set<string>
}

function disconnectAll(state: WatchState): void {
  for (const client of state.clients.values()) client.disconnect()
  state.clients.clear()
}

export async function ensureClients(source: SourceContextLike, state: WatchState, config: QqConfig): Promise<void> {
  const hash = JSON.stringify([config.accounts, config.groups, config.directMessages])
  if (state.hash !== hash) {
    // 配置变化：全部断开重建（含被移除的账号）。
    disconnectAll(state)
    state.dumped.clear()
    state.hash = hash
  }
  for (const account of config.accounts) {
    let client = state.clients.get(account.appId)
    if (!client) {
      client = new GatewayClient(account, {
        onEvent: (event) => {
          void handleEvent(source, account, event, state.dumped).catch((error: unknown) => {
            console.error('[qq] event handling failed (' + account.appId + '): ' + String(error).slice(0, 200))
          })
        },
        onConn: (connected) => { console.error('[qq] ' + account.appId + (connected ? ' gateway ready' : ' gateway closed')) },
      })
      state.clients.set(account.appId, client)
      try {
        await client.connect()
      } catch (error) {
        state.clients.delete(account.appId)
        source.report(HEALTH_ENTRY, { state: 'error', detail: account.appId + ': ' + String(error).slice(0, 200) })
        continue
      }
    } else if (!client.isConnected()) {
      // 每轮 5s 重连即节流；偶发双连由引擎按 trigger id 去重兜底。
      try {
        await client.connect()
      } catch (error) {
        source.report(HEALTH_ENTRY, { state: 'error', detail: account.appId + ': ' + String(error).slice(0, 200) })
        continue
      }
    }
  }
  const total = config.accounts.length
  const connected = config.accounts.filter((a) => state.clients.get(a.appId)?.isConnected()).length
  if (connected === total) {
    source.report(HEALTH_ENTRY, { state: 'ready', detail: 'gateway connected (' + total + ' bots)' })
  } else {
    source.report(HEALTH_ENTRY, { state: 'error', detail: 'connected ' + connected + '/' + total + '; reconnecting on next round' })
  }
}

export async function watch(source: SourceContextLike, signal: AbortSignal): Promise<void> {
  const state: WatchState = { hash: '', clients: new Map(), dumped: new Set() }
  while (!signal.aborted) {
    try {
      const config = source.config<QqConfig>('qq')
      const accounts = config?.accounts ?? []
      const valid = accounts.length > 0 && accounts.every((a) => a.appId && a.appSecret)
      if (config && valid) {
        channelConfig.current = config
        await ensureClients(source, state, config)
      } else {
        disconnectAll(state)
        state.hash = ''
        channelConfig.current = undefined
        source.report(HEALTH_ENTRY, { state: 'paused', detail: 'waiting for appId / AppSecret in settings' })
      }
    } catch (error) {
      source.report(HEALTH_ENTRY, { state: 'error', detail: String(error).slice(0, 300) })
    }
    await pause(5000, signal)
  }
  disconnectAll(state)
}
