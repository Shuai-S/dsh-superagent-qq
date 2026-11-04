/** QQ api-v2 WebSocket gateway client + access-token cache.
 *
 * Contract sources: official docs bot.q.qq.com/wiki/develop/api-v2 (read 2026-11-04) —
 * AppID+AppSecret -> accessToken (~7200s) via bots.qq.com/app/getAppAccessToken;
 * WS URL via GET api.sgroup.qq.com/gateway; opcodes DISPATCH=0 HEARTBEAT=1 IDENTIFY=2
 * RESUME=6 RECONNECT=7 INVALID_SESSION=9 HELLO=10 HEARTBEAT_ACK=11;
 * intents GROUP_AND_C2C_EVENT = 1 << 25 (group @-events + C2C events).
 * Identify payload and event shapes are verified against real traffic by
 * scripts/probe.mjs before the engine wiring is trusted (M1 gate).
 */
import type { QqAccount } from './qq-kind.ts'

export const API_BASE = 'https://api.sgroup.qq.com'
export const GROUP_AND_C2C_EVENT = 1 << 25

const OP_DISPATCH = 0
const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_RECONNECT = 7
const OP_INVALID_SESSION = 9
const OP_HELLO = 10
const WS_OPEN = 1 // WHATWG WebSocket readyState OPEN

export interface TokenCache { token: string; expiresAt: number }
const tokenCaches = new Map<string, TokenCache>()

/** Per-app token with a 60s renewal margin (dingtalk tokenCache pattern). */
export async function getAppAccessToken(appId: string, appSecret: string): Promise<string> {
  const now = Date.now()
  const cached = tokenCaches.get(appId)
  if (cached && cached.expiresAt > now + 60_000) return cached.token
  const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: appSecret }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await res.json().catch(() => ({}))) as { accessToken?: string; expiresIn?: string | number }
  if (!res.ok || !body.accessToken) throw new Error('getAppAccessToken failed: HTTP ' + res.status + ' ' + JSON.stringify(body).slice(0, 200))
  const expiresIn = Number(body.expiresIn ?? 7200)
  tokenCaches.set(appId, { token: body.accessToken, expiresAt: now + (Number.isFinite(expiresIn) ? expiresIn : 7200) * 1000 })
  return body.accessToken
}

/** REST auth headers; x-union-appid follows the official bot-node-sdk precedent. */
export async function authHeaders(appId: string, appSecret: string): Promise<Record<string, string>> {
  const token = await getAppAccessToken(appId, appSecret)
  return { authorization: 'QQBot ' + token, 'x-union-appid': appId }
}

export interface GatewayEvent { op: number; s?: number; t?: string; d?: unknown }

interface Handlers {
  onEvent: (event: GatewayEvent) => void
  onConn: (connected: boolean) => void
}

/** Wraps the platform WebSocket so the transport stays swappable; the watch
 *  loop owns reconnection (5s rounds), mirroring the dingtalk StreamClient. */
export class GatewayClient {
  connected = false
  private ws?: WebSocket
  private heartbeat?: NodeJS.Timeout
  private lastSeq = 0

  constructor(private readonly account: QqAccount, private readonly handlers: Handlers) {}

  async connect(): Promise<void> {
    const headers = await authHeaders(this.account.appId, this.account.appSecret)
    const res = await fetch(API_BASE + '/gateway', { headers, signal: AbortSignal.timeout(15_000) })
    const body = (await res.json().catch(() => ({}))) as { url?: string }
    if (!res.ok || !body.url) throw new Error('gateway resolve failed: HTTP ' + res.status + ' ' + JSON.stringify(body).slice(0, 200))
    const ws = new WebSocket(body.url)
    this.ws = ws
    ws.onmessage = (e: { data: unknown }) => {
      let payload: GatewayEvent | undefined
      try { payload = JSON.parse(String(e.data)) as GatewayEvent } catch { return }
      if (!payload) return
      void this.handlePayload(payload)
    }
    ws.onclose = () => { this.teardown(); this.handlers.onConn(false) }
    ws.onerror = () => { /* the close event follows; nothing to do here */ }
  }

  private async handlePayload(payload: GatewayEvent): Promise<void> {
    switch (payload.op) {
      case OP_HELLO: {
        const d = payload.d as { heartbeat_interval?: number } | undefined
        const interval = Math.max(5000, Number(d?.heartbeat_interval ?? 30_000))
        await this.identify()
        this.heartbeat = setInterval(() => {
          try { this.ws?.send(JSON.stringify({ op: OP_HEARTBEAT, d: this.lastSeq })) } catch { /* close handles */ }
        }, interval)
        break
      }
      case OP_DISPATCH: {
        if (typeof payload.s === 'number') this.lastSeq = payload.s
        if (payload.t === 'READY' || payload.t === 'RESUMED') {
          this.connected = true
          this.handlers.onConn(true)
          break
        }
        this.handlers.onEvent(payload)
        break
      }
      case OP_RECONNECT:
      case OP_INVALID_SESSION:
        // The server asks for a fresh session: close; the watch loop reconnects on its next round.
        this.disconnect()
        break
      default:
        break // HEARTBEAT_ACK and unknown opcodes carry nothing for us
    }
  }

  private async identify(): Promise<void> {
    try {
      const token = await getAppAccessToken(this.account.appId, this.account.appSecret)
      this.ws?.send(JSON.stringify({ op: OP_IDENTIFY, d: { token: 'QQBot ' + token, intents: GROUP_AND_C2C_EVENT, shard: [0, 1] } }))
    } catch (error) {
      console.error('[qq] identify failed: ' + String(error).slice(0, 200) + ' — the watch loop retries')
    }
  }

  disconnect(): void {
    try { this.ws?.close() } catch { /* already down */ }
    this.teardown()
  }

  private teardown(): void {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined }
    this.connected = false
  }

  isConnected(): boolean { return this.connected && this.ws?.readyState === WS_OPEN }
}