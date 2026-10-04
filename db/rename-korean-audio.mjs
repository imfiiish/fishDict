// Rename Korean pronunciation files to the shared audio convention
//   <sha1('ko:'+word)[:10]>.<ext>
// (zh uses sha1('zh:'+word), en sha1(word) — see audio repo). Files live in
// $AUDIO_DIR/ko and korean.sound is rewritten to the new name.
//
//   AUDIO_DIR=/path/to/audio node db/rename-korean-audio.mjs          # dry run
//   AUDIO_DIR=/path/to/audio node db/rename-korean-audio.mjs --apply  # do it
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))

// Minimal .env loader so AUDIO_DIR/DATABASE_URL can live in the gitignored .env.
try {
  for (const line of readFileSync(resolve(here, '../.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
} catch {}

const AUDIO_DIR = resolve(here, '..', process.env.AUDIO_DIR ?? 'audio')
const KO = resolve(AUDIO_DIR, 'ko')
const apply = process.argv.includes('--apply')
const name = (word, ext) =>
  createHash('sha1').update(`ko:${word}`).digest('hex').slice(0, 10) + ext

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    'postgres://fishdict:fishdict@localhost:5432/fishdict',
})

const { rows } = await pool.query(
  'select word, sound from korean where sound is not null order by word',
)
const plan = rows.map(({ word, sound }) => {
  const ext = /\.[^.]+$/.exec(sound)?.[0] ?? '.wav'
  return { word, from: sound, to: name(word, ext) }
})

// Validate before touching anything.
const missing = plan.filter((p) => !existsSync(resolve(KO, p.from)))
const tos = new Set(plan.map((p) => p.to))
const collision = plan.length - tos.size
const changed = plan.filter((p) => p.from !== p.to)

console.log(`ko 目录: ${KO}`)
console.log(`korean 有 sound: ${plan.length}`)
console.log(`需要改名: ${changed.length}  源文件缺失: ${missing.length}  新名碰撞: ${collision}`)
if (missing.length) console.log('缺失:', missing.slice(0, 5))
if (collision) console.log('碰撞:', plan.filter((p) => plan.filter((q) => q.to === p.to).length > 1).slice(0, 5))

if (missing.length || collision) {
  console.error('校验失败，未做任何改动')
  await pool.end()
  process.exit(1)
}

if (!apply) {
  console.log('\n[干跑] 示例:')
  for (const p of changed.slice(0, 5)) console.log(`  ${p.word}: ${p.from} -> ${p.to}`)
  console.log('\n加 --apply 真正执行')
  await pool.end()
  process.exit(0)
}

// Copy every source to its new name(s), then rewrite the DB, then drop the
// originals. The 219 shared sources fan out into one file per word.
for (const p of changed) copyFileSync(resolve(KO, p.from), resolve(KO, p.to))

const client = await pool.connect()
try {
  await client.query('begin')
  for (const p of plan) {
    await client.query('update korean set sound = $1 where word = $2', [p.to, p.word])
  }
  await client.query('commit')
} catch (err) {
  await client.query('rollback')
  throw err
} finally {
  client.release()
}

for (const from of new Set(plan.map((p) => p.from))) {
  if (!tos.has(from)) unlinkSync(resolve(KO, from))
}

console.log(`\n完成：DB 更新 ${plan.length} 条，文件重命名并清理完成`)
await pool.end()
