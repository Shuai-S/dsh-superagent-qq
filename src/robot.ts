/** QQ official-bot passive reply helpers.
 *
 * Contract sources: official docs bot.q.qq.com/wiki/develop/api-v2 —
 * server-inter/message/send-receive/send (read 2026-11-04): a passive reply is
 * POST {API_BASE}/v2/groups/{group_openid}/messages or
 * {API_BASE}/v2/users/{user_openid}/messages with body
 * { msg_type: 0, msg_id, msg_seq, content }; msg_id quotes the inbound message
 * and opens the passive-reply window, msg_seq orders several replies under one
 * msg_id (starts at 1, must increase per msg_id). REST auth headers come from
 * gateway.ts authHeaders (QQBot token + x-union-appid).
 * 被动回复窗口时长与单条 msg_id 的回复条数上限：M2 真机实测后再固化行为
 * （窗口过期/超条的降级策略，例如改发主动消息或静默丢弃，待实测数据）。
 */
import { API_BASE, authHeaders } from './gateway.ts'

/** Per-inbound-msg_id reply sequence numbers; the map is capped to bound
 *  memory on long-running processes (evict the oldest msg_id when full). */
const MSG_SEQ_LIMIT = 2000
const msgSeqs = new Map<string, number>()

export function nextMsgSeq(msgId: string): number {
  const previous = msgSeqs.get(msgId) ?? 0
  if (!msgSeqs.has(msgId) && msgSeqs.size >= MSG_SEQ_LIMIT) {
    const oldest = msgSeqs.keys().next().value
    if (oldest !== undefined) msgSeqs.delete(oldest)
  }
  msgSeqs.set(msgId, previous + 1)
  return previous + 1
}

export interface PassiveReplyTarget { scope: 'group' | 'c2c'; openid: string; msgId: string }

/** Send one passive reply quoting the inbound message (msg_id); throws on
 *  missing address fields and on non-2xx responses so the Outbox retries. */
export async function sendPassiveReply(
  appId: string,
  appSecret: string,
  target: PassiveReplyTarget,
  text: string,
): Promise<void> {
  if (!target.openid) throw new Error('sendPassiveReply: openid required')
  if (!target.msgId) throw new Error('sendPassiveReply: msgId required (passive replies must quote the inbound message)')
  const url = API_BASE + (target.scope === 'group'
    ? '/v2/groups/' + encodeURIComponent(target.openid) + '/messages'
    : '/v2/users/' + encodeURIComponent(target.openid) + '/messages')
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await authHeaders(appId, appSecret)) },
    body: JSON.stringify({ msg_type: 0, msg_id: target.msgId, msg_seq: nextMsgSeq(target.msgId), content: text }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error('passive reply failed: HTTP ' + res.status + ' ' + detail.slice(0, 200))
  }
}
