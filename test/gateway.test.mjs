import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GROUP_AND_C2C_EVENT, classifyPayload, heartbeatPayload, identifyPayload, resumePayload } from '../lib/index.js'

test('intent 常量: GROUP_AND_C2C_EVENT = 1 << 25', () => {
  assert.equal(GROUP_AND_C2C_EVENT, 1 << 25)
  assert.equal(GROUP_AND_C2C_EVENT, 33554432)
})

test('identifyPayload: op 2 + QQBot token + intents + shard [0,1]', () => {
  assert.deepEqual(JSON.parse(identifyPayload('TOK')), { op: 2, d: { token: 'QQBot TOK', intents: 33554432, shard: [0, 1] } })
})

test('resumePayload: op 6 + session_id + seq', () => {
  assert.deepEqual(JSON.parse(resumePayload('TOK', 'SESS', 7)), { op: 6, d: { token: 'QQBot TOK', session_id: 'SESS', seq: 7 } })
})

test('heartbeatPayload: op 1 + lastSeq', () => {
  assert.deepEqual(JSON.parse(heartbeatPayload(42)), { op: 1, d: 42 })
})

test('classifyPayload: HELLO 心跳间隔（默认 30s，钳制下限 5s）', () => {
  const bare = classifyPayload({ op: 10 })
  assert.equal(bare.action, 'hello')
  assert.equal(bare.heartbeatInterval, 30000)
  assert.equal(classifyPayload({ op: 10, d: {} }).heartbeatInterval, 30000)
  assert.equal(classifyPayload({ op: 10, d: { heartbeat_interval: 1500 } }).heartbeatInterval, 5000)
  assert.equal(classifyPayload({ op: 10, d: { heartbeat_interval: 45000 } }).heartbeatInterval, 45000)
})

test('classifyPayload: READY/RESUMED/普通 dispatch 分型', () => {
  assert.deepEqual(classifyPayload({ op: 0, s: 12, t: 'READY', d: { session_id: 'S1' } }), { action: 'ready', seq: 12, sessionId: 'S1' })
  assert.deepEqual(classifyPayload({ op: 0, s: 13, t: 'RESUMED' }), { action: 'resumed', seq: 13 })
  assert.deepEqual(classifyPayload({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'M1' } }), { action: 'dispatch' })
  assert.deepEqual(classifyPayload({ op: 0, s: 5, t: 'C2C_MESSAGE_CREATE' }), { action: 'dispatch', seq: 5 })
  // READY 缺 session_id：不携带 sessionId 键
  assert.deepEqual(classifyPayload({ op: 0, t: 'READY' }), { action: 'ready' })
})

test('classifyPayload: 信令帧分型（reconnect/invalid/ack/未知）', () => {
  assert.equal(classifyPayload({ op: 7 }).action, 'reconnect')
  assert.equal(classifyPayload({ op: 9 }).action, 'invalid-session')
  assert.equal(classifyPayload({ op: 11 }).action, 'heartbeat-ack')
  assert.equal(classifyPayload({ op: 99 }).action, 'unknown')
})
