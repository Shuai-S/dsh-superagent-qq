/** Persistent seen-ids dedup for gateway redeliveries: one JSON store per bot
 *  account (~/.local/state/dsh-superagent-qq/seen-<key>.json), FIFO-capped at
 *  SEEN_LIMIT ids, written atomically (tmp+rename, 0600) and serialized per
 *  store key so concurrent calls cannot interleave the read-modify-write
 *  cycle. Entries are message ids only — no message content, no credentials.
 *  State-file conventions mirror the wechat sibling (pending/history). */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 单 store 的 id 保留上限：超限按最旧先丢（FIFO）。 */
export const SEEN_LIMIT = 1000

let tmpSeq = 0

/** 文件名/目录段净化：只留安全字符，防 storeKey 注入路径（wechat util 同款）。 */
export function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown'
}

function stateBase(baseDir?: string): string {
  return baseDir ?? join(homedir(), '.local', 'state', 'dsh-superagent-qq')
}

export function seenFile(storeKey: string, baseDir?: string): string {
  return join(stateBase(baseDir), 'seen-' + sanitizeSegment(storeKey) + '.json')
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const idx = path.lastIndexOf('/')
  await mkdir(idx > 0 ? path.slice(0, idx) : '.', { recursive: true })
  const tmp = path + '.tmp-' + process.pid + '-' + (tmpSeq += 1)
  await writeFile(tmp, content, { mode: 0o600 })
  await rename(tmp, path)
}

async function readIds(path: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e): e is string => typeof e === 'string')
  } catch {
    return [] // 无文件或损坏：按空处理
  }
}

// 每 storeKey 一条串行链：并发 seenOrAdd 不会交叉读改写（同 id 重放判定保持单调）。
const chains = new Map<string, Promise<void>>()

function serialize<T>(storeKey: string, fn: () => Promise<T>): Promise<T> {
  const tail = chains.get(storeKey) ?? Promise.resolve()
  const run = tail.then(fn, fn)
  const settled = run.then(() => undefined, () => undefined)
  chains.set(storeKey, settled)
  void settled.then(() => { if (chains.get(storeKey) === settled) chains.delete(storeKey) })
  return run
}

/** 命中去重：true = 该 id 之前已见过（重放，应跳过）；false = 首次出现并已登记。
 *  id 为空直接返回 false（不登记不去重）；存储不可写时降级放行（宁重复勿丢失）。 */
export async function seenOrAdd(storeKey: string, id: string, baseDir?: string): Promise<boolean> {
  if (!id) return false
  return await serialize(storeKey, async () => {
    const path = seenFile(storeKey, baseDir)
    try {
      const ids = await readIds(path)
      if (ids.includes(id)) return true
      ids.push(id)
      while (ids.length > SEEN_LIMIT) ids.shift()
      await writeAtomic(path, JSON.stringify(ids))
    } catch (error) {
      console.error('[qq] seen store write failed; passing through: ' + String(error).slice(0, 160))
    }
    return false
  })
}
