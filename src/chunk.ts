/** Outbound text chunking for the QQ passive-reply path: splits text so every
 *  chunk fits a UTF-8 byte limit without cutting a multibyte character (or a
 *  surrogate pair) in half. A single code point larger than the limit still
 *  forms its own chunk — data integrity wins over the cap (documented edge,
 *  forward progress is always guaranteed).
 *
 *  Limit provenance: the official api-v2 wiki (bot.q.qq.com, send page) ships
 *  as a VuePress SPA and no explicit per-message content byte cap for the
 *  group/C2C passive-reply endpoints was found in the fetched bundles or
 *  mirrors on 2026-11-09, so the conservative 2000-byte default below is
 *  UNVERIFIED — tighten or lift after a real-traffic probe (M2). */

/** 保守文本字节上限（unverified）：官方文档未检索到明示 content 上限（2026-11-09 检索），
 *  采用批次约定保守值 2000；M2 真机 spike 核实后可收紧或放宽。 */
export const QQ_TEXT_LIMIT_BYTES = 2000

/** 按 UTF-8 字节上限切块：按 Unicode 码点迭代（代理对不拆），块内字节和 ≤ limit；
 *  单个码点自身超限时独立成块；空文本返回 ['']（保持"仍发一条"的原行为）。 */
export function chunkText(text: string, limitBytes: number): string[] {
  const limit = Math.max(1, limitBytes)
  if (!text) return ['']
  const chunks: string[] = []
  let current = ''
  let currentBytes = 0
  for (const ch of text) {
    const bytes = Buffer.byteLength(ch, 'utf8')
    if (currentBytes > 0 && currentBytes + bytes > limit) {
      chunks.push(current)
      current = ch
      currentBytes = bytes
    } else {
      current += ch
      currentBytes += bytes
    }
  }
  chunks.push(current)
  return chunks
}
