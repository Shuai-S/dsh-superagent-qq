import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunkText, QQ_TEXT_LIMIT_BYTES } from '../lib/index.js'

test('默认上限 = 2000 字节（unverified 保守值）', () => {
  assert.equal(QQ_TEXT_LIMIT_BYTES, 2000)
})

test('ASCII 按字节边界切', () => {
  assert.deepEqual(chunkText('abcdefgh', 3), ['abc', 'def', 'gh'])
})

test('多字节字符不会被切半', () => {
  assert.deepEqual(chunkText('你好世界', 4), ['你', '好', '世', '界'])
  assert.deepEqual(chunkText('你好世界', 6), ['你好', '世界'])
})

test('emoji（代理对）整体成块', () => {
  assert.deepEqual(chunkText('a👍b', 3), ['a', '👍', 'b'])
})

test('恰好整除与空文本', () => {
  assert.deepEqual(chunkText('abc', 3), ['abc'])
  assert.deepEqual(chunkText('', 10), [''])
})

test('重拼恒等：任意长文本与任意上限切块后 join 还原原文', () => {
  const text = '混合文本 mixed 👍 content—'.repeat(37)
  for (const limit of [1, 2, 3, 7, 64, 2000]) {
    assert.equal(chunkText(text, limit).join(''), text)
  }
})

test('每块都不超上限（单个码点自身超限时独立成块）', () => {
  const text = 'foobar🀄你好'.repeat(5)
  for (const piece of chunkText(text, 5)) {
    assert.ok(piece.length === 1 || Buffer.byteLength(piece, 'utf8') <= 5)
  }
})
