import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { SEEN_LIMIT, seenFile, seenOrAdd } from '../lib/index.js'

const dirs = []
async function tempBase() {
  const dir = await mkdtemp(join(tmpdir(), 'qq-dedup-test-'))
  dirs.push(dir)
  return dir
}
after(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

test('seenOrAdd: 首次 false，重放 true，新 id false', async () => {
  const base = await tempBase()
  assert.equal(await seenOrAdd('bot1', 'm1', base), false)
  assert.equal(await seenOrAdd('bot1', 'm1', base), true)
  assert.equal(await seenOrAdd('bot1', 'm2', base), false)
})

test('seenOrAdd: 状态落盘持久（store 文件内容为 id 数组）', async () => {
  const base = await tempBase()
  await seenOrAdd('bot1', 'm1', base)
  assert.deepEqual(JSON.parse(await readFile(seenFile('bot1', base), 'utf8')), ['m1'])
})

test('seenOrAdd: 每 bot 一个 store 文件，键名净化', async () => {
  const base = await tempBase()
  await seenOrAdd('bot/A', 'm1', base)
  assert.deepEqual(await readdir(base), ['seen-bot_A.json'])
})

test('seenOrAdd: 空 id 不登记不去重', async () => {
  const base = await tempBase()
  assert.equal(await seenOrAdd('bot1', '', base), false)
  assert.equal(await seenOrAdd('bot1', '', base), false)
  assert.deepEqual(await readdir(base), [])
})

test('seenOrAdd: FIFO 上限 SEEN_LIMIT=1000，最旧被逐出', async () => {
  const base = await tempBase()
  for (let i = 0; i < SEEN_LIMIT; i++) await seenOrAdd('bot1', 'm' + i, base)
  assert.equal(await seenOrAdd('bot1', 'm0', base), true)   // 恰好 1000，未逐出
  await seenOrAdd('bot1', 'new-1', base)                    // 逐出 m0
  const ids = JSON.parse(await readFile(seenFile('bot1', base), 'utf8'))
  assert.equal(ids.length, SEEN_LIMIT)
  assert.ok(!ids.includes('m0'))
  assert.ok(ids.includes('new-1'))
  assert.equal(await seenOrAdd('bot1', 'm0', base), false)  // 已逐出 → 视为新 id
})

test('seenOrAdd: 存储不可写时降级放行（宁重复勿丢失，不抛出）', async () => {
  const base = await tempBase()
  const blocker = join(base, 'blocker')
  await writeFile(blocker, 'not a dir')
  assert.equal(await seenOrAdd('bot1', 'm1', blocker), false)
  assert.equal(await seenOrAdd('bot1', 'm1', blocker), false) // 写失败 → 不记忆 → 放行
})
