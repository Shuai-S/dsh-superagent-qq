/** The 'qq' Source kind: QQ official bot messages arriving via the WebSocket
 *  gateway, replies through the OpenAPI as passive replies. Shape mirrors the
 *  bundled github/feishu kinds (docs/008-cookbook.md) and the dingtalk/mail
 *  sibling plugins; the engine duck-types it at runtime. Image attachments
 *  arrive as [qq-image:KEY] markers in the trigger text and are downloaded on
 *  demand through threadContext.image (dingtalk-kind precedent). */
import { z } from 'zod'
import type { Localized, OutboundMessageLike, SourceKindLike, TriggerLike } from './types.ts'
import type { AclPolicy } from './acl.ts'
import { chunkText, QQ_TEXT_LIMIT_BYTES } from './chunk.ts'
import { logSendFailure } from './failure-log.ts'
import { attachmentKey, downloadQqImage, isImageContentType, sendPassiveReply } from './robot.ts'

export interface QqAccount { name: string; appId: string; appSecret: string }
export interface QqGroup { appId: string; groupOpenid: string; name: string }

export const HEALTH_ENTRY = 'qqGateway'
const dmRowId = 'direct-messages'

/** ACL 访问模式（契约 docs/rpc-contract.md §3；判定实现在 vendored src/acl.ts）。
 *  不设 policy = 全放行（向后兼容）；形状非法按 schema 拒绝，不做静默降级。 */
export const AclPolicySchema = z.object({
  mode: z.enum(['allowlist', 'open']),
  allowUsers: z.array(z.string()),
  groupOnly: z.boolean().optional(),
  denyText: z.object({ zh: z.string().min(1), en: z.string().min(1) }).optional(),
}).strict()

export const QqConfigSchema = z.object({
  accounts: z.array(z.object({
    name: z.string().default(''),
    appId: z.string().default(''),
    appSecret: z.string().default(''),
  })).default([]),
  groups: z.array(z.object({
    appId: z.string().default(''),
    groupOpenid: z.string().default(''),
    name: z.string().default(''),
  })).default([]),
  directMessages: z.boolean().default(true),
  sendAck: z.boolean().default(true),
  policy: AclPolicySchema.optional(),
}).strict()
export type QqConfig = z.infer<typeof QqConfigSchema>

// channel.send reads config through this holder; watch() refreshes it every round.
export const channelConfig: { current?: QqConfig } = {}

/** 流量计数（watch 健康上报读取）：in=入站消息条数（含重放），out=成功回复块，
 *  fail=失败回复块，deny=ACL 拒绝数（契约 §3：派发前拒绝，不进 in/out/fail，
 *  failure-log 不记）；lastFailAt/lastFail 记最近一次失败。进程生命周期内累计。 */
export const flowStats = { in: 0, out: 0, fail: 0, deny: 0, lastFailAt: '', lastFail: '' }

/** 从消息文本提取图片 key（与 buildTrigger 内嵌的 [qq-image:KEY] 标记配对）。
 *  KEY 是附件 url 的派生哈希（robot.attachmentKey），提取只认原文出现过的 key；
 *  image() 还会按 url 重算哈希核对，用户手打的假标记无法对上真实附件。 */
const qqImageKeys = (text: string): string[] =>
  [...new Set([...text.matchAll(/\[qq-image:([^\]]+)\]/g)].map((m) => m[1] ?? ''))].filter(Boolean)

export const qqKind = {
  kind: 'qq',
  title: { zh: 'QQ 机器人', en: 'QQ bot' },
  description: {
    zh: '直连 QQ 官方机器人平台：群内 @ 机器人或机器人单聊即可派活，回复以被动回复直接回 QQ。',
    en: 'Direct QQ official bot via the WebSocket gateway: @ the bot in a group or DM it to dispatch; replies go back as passive replies.',
  },
  schema: QqConfigSchema,
  fields: [
    { key: 'accounts', type: 'rows', dialog: true, label: { zh: '机器人账号', en: 'Bot accounts' }, columns: [
      { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, optional: true, hint: { zh: '仅用于面板显示', en: 'Display only' } },
      { key: 'appId', type: 'text', label: { zh: 'AppID', en: 'AppID' } },
      { key: 'appSecret', type: 'text', label: { zh: 'AppSecret', en: 'AppSecret' }, hint: { zh: '明文存于引擎配置（本地 sqlite，仅本机可读）', en: 'Stored in engine config (local sqlite, readable only on this machine)' } },
    ] },
    { key: 'groups', type: 'rows', label: { zh: '接收的群', en: 'Group chats' }, columns: [
      { key: 'appId', type: 'text', label: { zh: 'AppID', en: 'AppID' } },
      { key: 'groupOpenid', type: 'text', label: { zh: '群 openid', en: 'Group openid' }, hint: { zh: '群内 @ 机器人发一条消息，日志会打印', en: 'Mention the bot once in the group; the log prints it' } },
      { key: 'name', type: 'text', label: { zh: '群名', en: 'Name' }, optional: true },
    ] },
    { key: 'directMessages', type: 'switch', label: { zh: '接收机器人单聊', en: 'Receive bot direct messages' } },
    { key: 'sendAck', type: 'switch', label: { zh: '「已收到」回执', en: '“Received” acknowledgement' }, hint: { zh: '收到消息先被动回复「已收到」，终答随后', en: 'Passively reply “received” on receipt; the final answer follows' } },
  ],
  health: ['qqGateway'],
  scope(input: { meta: Record<string, unknown> }, config: QqConfig) {
    const accountId = String(input.meta.accountId ?? '')
    if (!config.accounts.some((a) => a.appId === accountId)) {
      return { listened: false, reason: 'qq: account not configured: ' + accountId }
    }
    if (input.meta.scopeKind === 'c2c') {
      if (!config.directMessages) return { listened: false, reason: 'qq: direct messages disabled' }
      return { listened: true, observed: false, row: dmRowId }
    }
    const groupOpenid = String(input.meta.groupOpenid ?? '')
    const row = config.groups.find((g) => g.groupOpenid === groupOpenid && g.appId === accountId)
    if (!row) return { listened: false, reason: 'qq: group not configured: ' + groupOpenid }
    return { listened: true, observed: false, row: row.groupOpenid }
  },
  channel: {
    async send(_host: unknown, message: OutboundMessageLike): Promise<'sent' | 'gone'> {
      const config = channelConfig.current
      if (!config) throw new Error('qq: channel not ready (no config yet)')
      const address = message.channel.address as Record<string, string>
      // 「已收到」回执可在设置关闭：ack 在开关关闭时直接按已发送处理，不真正发消息。
      if (message.kind === 'acknowledgement' && config.sendAck === false) return 'sent'
      const account = config.accounts.find((a) => a.appId === address.account)
      if (!account) throw new Error('qq: account not configured: ' + String(address.account ?? ''))
      const target = {
        scope: address.scope === 'group' ? 'group' as const : 'c2c' as const,
        openid: address.openid ?? '',
        msgId: address.msgId ?? '',
      }
      const channelKey = account.appId + '|' + target.scope + '|' + target.openid
      // UTF-8 安全边界分块（上限 2000 字节 unverified，见 chunk.ts 头注）：
      // 块 1 失败照常抛出交引擎退避重试；k>1 块失败记日志（含 failure-log）并按已送达收尾。
      const pieces = chunkText(message.text, QQ_TEXT_LIMIT_BYTES)
      for (let k = 0; k < pieces.length; k++) {
        try {
          await sendPassiveReply(account.appId, account.appSecret, target, pieces[k])
          flowStats.out += 1
        } catch (error) {
          flowStats.fail += 1
          flowStats.lastFailAt = new Date().toISOString()
          flowStats.lastFail = String(error).slice(0, 200)
          await logSendFailure({ channelKey, kind: message.kind, error: String(error) })
          if (k === 0) throw error
          console.error('[qq] reply chunk ' + (k + 1) + '/' + pieces.length + ' failed after earlier chunk(s) landed; keeping sent: ' + String(error).slice(0, 200))
          return 'sent'
        }
      }
      console.error('[qq] reply sent: kind=' + message.kind + ' msgId=' + String(address.msgId ?? '(none)')
        + (pieces.length > 1 ? ' chunks=' + pieces.length : ''))
      return 'sent'
    },
    link(address: Record<string, string>) {
      const label = 'QQ ' + String(address.openid ?? '').slice(0, 12)
      return { url: '', label: { zh: label, en: label } }
    },
  },
  threadContext: {
    messageId(trigger: TriggerLike): string {
      return String(trigger.meta.messageId ?? '')
    },
    // 图片支持（先例：引擎 feishu-image.ts / dingtalk-kind.ts）——images 从文本提取
    // 标记 key，image 下载后经 attachments.saveImage 注入会话。
    images(text: string): string[] {
      return qqImageKeys(text)
    },
    async image(agent: unknown, _commands: unknown, trigger: TriggerLike, message: { id: string; text: string }, key: string, _stateDir: string, signal: AbortSignal) {
      if (!qqImageKeys(message.text).includes(key)) throw new Error('Choose an image key from this source message')
      // 附件定位：trigger.meta.attachments 由 buildTrigger 落盘（url/contentType/filename/key），
      // 这里按 key 重算 url 哈希核对，防伪造 meta 拉取任意地址。
      const stored = (trigger.meta as { attachments?: { url?: string; contentType?: string; filename?: string; key?: string }[] }).attachments
      const list = Array.isArray(stored) ? stored : []
      const att = list.find((a) => a.key === key)
      if (!att || typeof att.url !== 'string' || !att.url || attachmentKey(att.url) !== key) {
        throw new Error('qq: image attachment not found in this message: ' + key)
      }
      if (!isImageContentType(att.contentType)) throw new Error('qq: attachment is not an image: ' + key)
      const host = agent as {
        ctx?: { get?: (name: string) => unknown }
        session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } }
        options?: { provider?: string; model?: string }
      }
      const attachments = host.ctx?.get?.('attachments') as {
        saveImage: (input: { data: Buffer; mediaType: string; name: string }) => Promise<unknown>
        imageLimits?: { maxImageBytes?: number; maxMessageImageBytes?: number }
      } | undefined
      if (!attachments?.saveImage) throw new Error('Image reading is unavailable: no attachment service is mounted')
      const route = host.session?.requestHeader?.()?.config
      const provider = route?.provider ?? host.options?.provider
      const model = route?.model ?? host.options?.model
      const llm = host.ctx?.get?.('llm') as { resolveModelInfo?: (p: string, m: string, s: AbortSignal) => Promise<{ inputModalities?: string[] }> } | undefined
      if (!llm?.resolveModelInfo || !provider || !model) throw new Error('Image reading is unavailable: the current model route is unresolved')
      const info = await llm.resolveModelInfo(provider, model, signal)
      if (!info.inputModalities?.includes('image')) throw new Error('Model ' + model + ' does not support image input; the image has not been inspected')
      signal.throwIfAborted()
      // url 直取（不带任何鉴权头）：失败报错显式指向 spike，待真机核对后再补。
      const media = await downloadQqImage(att.url)
      const maxBytes = Math.min(attachments.imageLimits?.maxImageBytes ?? 20 * 1024 * 1024, attachments.imageLimits?.maxMessageImageBytes ?? 20 * 1024 * 1024)
      if (media.data.length > maxBytes) throw new Error('The image exceeds the ' + maxBytes + ' byte limit')
      const name = 'qq-' + (key.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'image') + '.' + media.mediaType.split('/')[1]
      const image = await attachments.saveImage({ data: media.data, mediaType: media.mediaType, name })
      signal.throwIfAborted()
      return { source_message_id: message.id, image_key: key, image }
    },
    async read(_commands: unknown, trigger: TriggerLike, part: 'thread' | 'root' | 'parent', _cursor: string | undefined, _config: QqConfig) {
      // v1: the assessment reads the trigger's own message; conversation
      // history needs more API permissions (M2+, aligned with dingtalk/mail v1).
      const own = { id: String(trigger.meta.messageId ?? trigger.id), from: trigger.actor.id, at: trigger.at, text: trigger.text }
      return { messages: part === 'parent' ? [] : [own], body: {}, status: undefined }
    },
  },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string(), name: z.string().optional() })).default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '允许派活的成员', en: 'Allowed members' }, columns: [
        { key: 'id', type: 'text', label: { zh: '成员 openid', en: 'Member openid' } },
        { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, optional: true },
      ] },
    ],
    explicit: { zh: '群里 @ 机器人，或在机器人单聊里发言', en: 'Mentioned the bot in a chat, or messaged the bot directly' },
    rows(config: Record<string, unknown>) {
      // Defensive read: raw stored config, never parse the whole object here.
      const groups = (Array.isArray(config.groups) ? config.groups : []) as QqGroup[]
      const rows: { id: string; label: Localized | string; note: Localized; cells: { listedUnaddressed: boolean; unlistedAddressed: boolean; unlistedUnaddressed: boolean } }[] = groups.map((g) => ({
        id: g.groupOpenid,
        label: g.name || g.groupOpenid,
        note: { zh: '群聊（仅 @ 可指派）', en: 'Group chat (mention to assign)' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false },
      }))
      if (config.directMessages !== false) {
        rows.push({ id: dmRowId, label: { zh: '机器人单聊', en: 'Bot direct messages' }, note: { zh: '单聊消息均为明确指派', en: 'DMs are explicit assignments' }, cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true } })
      }
      return rows
    },
  },
} as unknown as SourceKindLike
