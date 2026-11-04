/** QQ official-bot passive reply helpers + attachment downloads.
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
 *
 * Attachment downloads (M2 wiring, field names pending real-traffic spike):
 * message events carry d.attachments[{content_type, filename, url}]. Whether
 * the url needs auth headers is UNKNOWN — we fetch it directly with no headers
 * and fail loudly (error text points at the spike); do not guess headers until
 * verified on a real bot. Segmented/resumable download mirrors the dingtalk
 * sibling plugin's downloadDingtalkMediaToFile (Range + retry backoff + cap).
 */
import { mkdir, open, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
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

// ===== Attachments =====

export const IMAGE_MEDIA_TYPES: Record<string, string> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/webp': 'image/webp',
  'image/gif': 'image/gif',
}

export function isImageContentType(contentType: unknown): boolean {
  return typeof contentType === 'string' && contentType.toLowerCase().startsWith('image/')
}

export function mediaKindOf(contentType: unknown): 'video' | 'audio' | 'file' {
  const ct = typeof contentType === 'string' ? contentType.toLowerCase() : ''
  if (ct.startsWith('video/')) return 'video'
  if (ct.startsWith('audio/')) return 'audio'
  return 'file'
}

/** Deterministic marker KEY derived from the attachment url (FNV-1a, forward
 *  + reverse rounds -> 16 hex chars). It is only a locator: user-typed markers
 *  in message text are ignored unless the recomputed hash matches an
 *  attachment the message actually carries (see threadContext.image). */
export function attachmentKey(url: string): string {
  let forward = 0x811c9dc5
  for (let i = 0; i < url.length; i++) {
    forward ^= url.charCodeAt(i)
    forward = Math.imul(forward, 0x01000193)
  }
  let reverse = 0x811c9dc5 ^ url.length
  for (let i = url.length - 1; i >= 0; i--) {
    reverse ^= url.charCodeAt(i) * 31
    reverse = Math.imul(reverse, 0x01000193)
  }
  return (forward >>> 0).toString(16).padStart(8, '0') + (reverse >>> 0).toString(16).padStart(8, '0')
}

/** Non-2xx error carrying the explicit auth-spike note (headers are NOT guessed). */
async function attachmentHttpError(res: { status: number; text(): Promise<string> }): Promise<Error> {
  const detail = await res.text().catch(() => '')
  return new Error('attachment download failed: HTTP ' + res.status + ' ' + detail.slice(0, 200)
    + ' — attachments url 可能需要鉴权头（契约未实测，M2 真机 spike 核对）')
}

export interface MediaDownloadOpts { maxBytes?: number; budgetMs?: number; segmentBytes?: number; attempts?: number }

/** Segmented streaming download to a .part file: Range resume + retry backoff
 *  + hard size cap; a server without Range support (200 full) restarts from
 *  zero. The caller renames the .part once the mime is known. */
export async function downloadQqMediaToFile(url: string, partPath: string, opts?: MediaDownloadOpts): Promise<{ bytes: number; mime: string }> {
  const maxBytes = opts?.maxBytes ?? 200 * 1024 * 1024
  const deadline = Date.now() + (opts?.budgetMs ?? 15 * 60_000)
  const segment = opts?.segmentBytes ?? 8 * 1024 * 1024
  const maxAttempts = opts?.attempts ?? 4
  let offset = 0
  try { offset = (await stat(partPath)).size } catch { /* first run */ }
  if (offset > maxBytes) {
    await unlink(partPath).catch(() => {})
    throw new Error('media exceeds ' + maxBytes + ' byte limit')
  }
  await mkdir(dirname(partPath), { recursive: true })
  let mime = ''
  let attempt = 0
  let lastError = 'unknown'
  while (Date.now() <= deadline) {
    try {
      for (;;) {
        if (offset > maxBytes) {
          await unlink(partPath).catch(() => {})
          throw new Error('media exceeds ' + maxBytes + ' byte limit')
        }
        const res = await fetch(url, {
          headers: offset > 0 ? { Range: 'bytes=' + offset + '-' + (offset + segment - 1) } : {},
          signal: AbortSignal.timeout(30_000),
        })
        if (!mime) mime = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
        if (res.status === 206) {
          const buf = Buffer.from(await res.arrayBuffer())
          if (buf.length === 0) throw new Error('empty range response')
          const handle = await open(partPath, 'a')
          try { await handle.write(buf) } finally { await handle.close() }
          offset += buf.length
          const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1] ?? -1)
          if (total >= 0 && offset >= total) return { bytes: offset, mime }
          if (total < 0 && buf.length < segment) return { bytes: offset, mime }
          continue
        }
        if (res.status === 200) {
          // Server ignores Range: stream the full body (offset restarts at 0).
          if (offset > 0) { offset = 0; await unlink(partPath).catch(() => {}) }
          const handle = await open(partPath, 'w')
          try {
            for await (const chunk of res.body ?? []) {
              const buf = Buffer.from(chunk as Uint8Array)
              await handle.write(buf)
              offset += buf.length
              if (offset > maxBytes) throw new Error('media exceeds ' + maxBytes + ' byte limit')
            }
          } finally { await handle.close() }
          return { bytes: offset, mime }
        }
        throw await attachmentHttpError(res)
      }
    } catch (error) {
      lastError = String(error).slice(0, 200)
      if (lastError.includes('byte limit')) throw error
      attempt += 1
      if (attempt >= maxAttempts || Date.now() > deadline) break
      await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** (attempt - 1), 8_000)))
    }
  }
  throw new Error('media download failed after ' + attempt + ' attempts at ' + offset + ' bytes: ' + lastError)
}

/** Whole-file image download (memory path); mime must be in the image whitelist. */
export async function downloadQqImage(url: string): Promise<{ data: Buffer; mediaType: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw await attachmentHttpError(res)
  const mime = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  const mediaType = IMAGE_MEDIA_TYPES[mime]
  if (!mediaType) throw new Error('unsupported image type: ' + (mime || 'unknown'))
  const data = Buffer.from(await res.arrayBuffer())
  return { data, mediaType }
}
