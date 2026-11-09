import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attachmentKey, buildTrigger } from '../lib/index.js'

const account = { name: '主号', appId: 'app1', appSecret: 'secret' }

test('buildTrigger: 群 @ 消息 → mention + 群线程 + 地址/meta 完整', () => {
  const t = buildTrigger(account, { id: 'M1', content: '你好', group_openid: 'G1', author: { member_openid: 'U1' } }, [], '2026-11-09T08:00:00.000Z')
  assert.ok(t)
  assert.equal(t.id, 'qq:M1')
  assert.equal(t.addressed, 'mention')
  assert.equal(t.human, true)
  assert.deepEqual(t.threads, [{ source: 'qq', id: 'g:G1' }])
  assert.equal(t.actor.id, 'U1')
  assert.equal(t.channel.thread, 'qq:g:G1')
  assert.equal(t.channel.address.account, 'app1')
  assert.equal(t.channel.address.scope, 'group')
  assert.equal(t.channel.address.openid, 'G1')
  assert.equal(t.channel.address.msgId, 'M1')
  assert.equal(t.meta.scopeKind, 'group')
  assert.equal(t.meta.groupOpenid, 'G1')
  assert.equal(t.meta.messageId, 'M1')
  assert.equal(t.at, '2026-11-09T08:00:00.000Z')
})

test('buildTrigger: C2C 单聊 → direct；author.user_openid 优先、顶层 user_openid 兜底', () => {
  const a = buildTrigger(account, { id: 'M2', content: 'hi', user_openid: 'U2', author: { user_openid: 'U9' } })
  assert.ok(a)
  assert.equal(a.addressed, 'direct')
  assert.equal(a.actor.id, 'U9')
  assert.equal(a.channel.thread, 'qq:c:U2')
  assert.equal(a.channel.address.scope, 'c2c')
  assert.equal(a.meta.scopeKind, 'c2c')
  const b = buildTrigger(account, { id: 'M3', content: 'hi', user_openid: 'U2' })
  assert.ok(b)
  assert.equal(b.actor.id, 'U2')
})

test('buildTrigger: 心跳/信令/缺字段事件映射不出 Trigger（undefined 分支）', () => {
  assert.equal(buildTrigger(account, {}), undefined)                                                    // 空帧
  assert.equal(buildTrigger(account, { content: '没有 id' }), undefined)                                // 缺 msgId
  assert.equal(buildTrigger(account, { id: 'M4' }), undefined)                                          // 无内容且无附件
  assert.equal(buildTrigger(account, { id: 'M5', content: 'x', group_openid: 'G1' }), undefined)        // 缺发件人
  assert.equal(buildTrigger(account, { id: 'M6', content: 'x', author: { member_openid: 'U1' } }), undefined) // 缺群/单聊 openid
  assert.equal(buildTrigger(account, { id: 'M7', content: '   ', group_openid: 'G1', author: { member_openid: 'U1' } }), undefined) // 纯空白
})

test('buildTrigger: timestamp 可解析则归一 ISO；非法则回退当前时间', () => {
  const t = buildTrigger(account, { id: 'M8', content: 'x', group_openid: 'G1', author: { member_openid: 'U1' }, timestamp: '2026-11-09T16:00:00.000Z' })
  assert.ok(t)
  assert.equal(t.at, '2026-11-09T16:00:00.000Z')
  const u = buildTrigger(account, { id: 'M9', content: 'x', group_openid: 'G1', author: { member_openid: 'U1' }, timestamp: 'not-a-date' })
  assert.ok(u)
  assert.doesNotThrow(() => new Date(u.at).toISOString())
})

test('buildTrigger: 图片附件 → [qq-image:KEY] 标记 + meta.attachments（key=attachmentKey(url)）', () => {
  const url = 'https://example.com/a.png'
  const key = attachmentKey(url)
  const t = buildTrigger(account, { id: 'M10', content: '', group_openid: 'G1', author: { member_openid: 'U1' },
    attachments: [{ content_type: 'image/png', filename: 'a.png', url }] })
  assert.ok(t)
  assert.ok(t.text.includes('[qq-image:' + key + ']'))
  const stored = t.meta.attachments
  assert.equal(stored.length, 1)
  assert.equal(stored[0].key, key)
  assert.equal(stored[0].contentType, 'image/png')
  assert.equal(stored[0].filename, 'a.png')
})

test('buildTrigger: 非图片附件 → [qq-file:KEY] 标记', () => {
  const url = 'https://example.com/report.pdf'
  const t = buildTrigger(account, { id: 'M11', content: '看下', group_openid: 'G1', author: { member_openid: 'U1' },
    attachments: [{ content_type: 'application/pdf', filename: 'report.pdf', url }] })
  assert.ok(t)
  assert.ok(t.text.includes('[qq-file:' + attachmentKey(url) + ']'))
  assert.ok(t.text.startsWith('看下'))
})

test('buildTrigger: 落盘 media → 提示注入；下载失败 → 失败占位', () => {
  const t = buildTrigger(account, { id: 'M12', content: 'x', group_openid: 'G1', author: { member_openid: 'U1' } },
    [{ kind: 'video', url: 'u', key: 'k', path: '/tmp/v.mp4', name: 'clip.mp4' }])
  assert.ok(t)
  assert.ok(t.text.includes('视频已保存: /tmp/v.mp4'))
  assert.ok(t.text.includes('clip.mp4'))
  const e = buildTrigger(account, { id: 'M13', content: 'x', group_openid: 'G1', author: { member_openid: 'U1' } },
    [{ kind: 'file', url: 'u', key: 'k', name: 'f.bin', error: 'boom' }])
  assert.ok(e)
  assert.ok(e.text.includes('QQ文件下载失败: boom'))
})

test('attachmentKey: 确定性 16 位十六进制', () => {
  assert.equal(attachmentKey('https://x/a').length, 16)
  assert.equal(attachmentKey('https://x/a'), attachmentKey('https://x/a'))
  assert.match(attachmentKey('https://x/a'), /^[0-9a-f]{16}$/)
})
