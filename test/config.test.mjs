import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QqConfigSchema } from '../lib/index.js'

test('QqConfigSchema: 空配置补全默认值', () => {
  const parsed = QqConfigSchema.parse({})
  assert.deepEqual(parsed, { accounts: [], groups: [], directMessages: true, sendAck: true })
})

test('QqConfigSchema: 完整配置通过并保留字段', () => {
  const parsed = QqConfigSchema.parse({
    accounts: [{ appId: 'a1', appSecret: 's1', name: '主号' }],
    groups: [{ appId: 'a1', groupOpenid: 'G1', name: '群一' }],
    directMessages: false,
    sendAck: false,
  })
  assert.equal(parsed.accounts[0].appId, 'a1')
  assert.equal(parsed.groups[0].groupOpenid, 'G1')
  assert.equal(parsed.directMessages, false)
  assert.equal(parsed.sendAck, false)
})

test('QqConfigSchema: strict 拒绝未知字段', () => {
  assert.throws(() => QqConfigSchema.parse({ unknown: 1 }))
})

test('QqConfigSchema: 拒绝错误类型', () => {
  assert.throws(() => QqConfigSchema.parse({ accounts: 'no' }))
  assert.throws(() => QqConfigSchema.parse({ directMessages: 'yes' }))
  assert.throws(() => QqConfigSchema.parse({ sendAck: 1 }))
})
