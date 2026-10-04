#!/usr/bin/env node
// Imports CC-CEDICT English definitions into public.hsk.senses.
//
// Output: a SQL script on stdout to be piped into psql, e.g.
//   node db/import-cedict.mjs | docker compose exec -T db psql -U fishdict -d fishdict
//
// Data source: CC-CEDICT, published by MDBG, licensed CC BY-SA 4.0.
//   https://cc-cedict.org/  ·  https://www.mdbg.net/chinese/dictionary?page=cc-cedict
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const cedictPath = join(here, 'cedict.txt')
const dumpPath = join(here, 'dump.sql')
const CEDICT_URL =
  'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz'

if (!existsSync(cedictPath)) {
  process.stderr.write(`downloading CC-CEDICT -> ${cedictPath}\n`)
  const res = await fetch(CEDICT_URL)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  writeFileSync(cedictPath, gunzipSync(Buffer.from(await res.arrayBuffer())))
}

// ---------------------------------------------------------------------------
// Parse CC-CEDICT
// ---------------------------------------------------------------------------
const TONE_MARKS = {
  a: ['ā', 'á', 'ǎ', 'à'],
  e: ['ē', 'é', 'ě', 'è'],
  i: ['ī', 'í', 'ǐ', 'ì'],
  o: ['ō', 'ó', 'ǒ', 'ò'],
  u: ['ū', 'ú', 'ǔ', 'ù'],
  ü: ['ǖ', 'ǘ', 'ǚ', 'ǜ'],
}

/** Convert one numeric-pinyin syllable ("da3", "nu:3") to diacritics ("dǎ", "nǚ"). */
function markSyllable(syllable) {
  const match = /^([A-Za-zü:]+?)([1-5])?$/.exec(syllable)
  if (!match) return syllable
  const tone = match[2] ? Number(match[2]) : 5
  const wasCapitalized = /^[A-Z]/.test(match[1])
  let base = match[1].toLowerCase().replace(/u:|v/g, 'ü')

  if (tone >= 1 && tone <= 4) {
    let index = -1
    for (const vowel of ['a', 'o', 'e']) {
      const i = base.indexOf(vowel)
      if (i >= 0) {
        index = i
        break
      }
    }
    if (index < 0) {
      for (let i = base.length - 1; i >= 0; i--) {
        if (TONE_MARKS[base[i]]) {
          index = i
          break
        }
      }
    }
    if (index >= 0) {
      base =
        base.slice(0, index) +
        TONE_MARKS[base[index]][tone - 1] +
        base.slice(index + 1)
    }
  }
  return wasCapitalized ? base[0].toUpperCase() + base.slice(1) : base
}

// Some CC-CEDICT pinyin has stray spaces around the ü colon ("nu : 3").
const toPinyin = (value) =>
  value.replace(/\s*:\s*/g, ':').split(/\s+/).map(markSyllable).join(' ')

/** simplified -> array of { pinyin, defs } */
const cedict = new Map()
for (const line of readFileSync(cedictPath, 'utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue
  const match = /^(\S+) (\S+) \[([^\]]*)\] \/(.*)\/\s*$/.exec(line)
  if (!match) continue
  const [, , simplified, pinyin, rawDefs] = match
  const defs = rawDefs.split('/').map((d) => d.trim()).filter(Boolean)
  if (defs.length === 0) continue
  const list = cedict.get(simplified) ?? []
  list.push({ pinyin: toPinyin(pinyin), defs })
  cedict.set(simplified, list)
}

// ---------------------------------------------------------------------------
// Build senses for every HSK word (parsed from db/dump.sql, no DB needed)
// ---------------------------------------------------------------------------
function readHskRows(sql) {
  const lines = sql.split('\n')
  const header = lines.findIndex((l) => l.startsWith('COPY public.hsk ('))
  if (header < 0) throw new Error('COPY public.hsk block not found in dump.sql')
  const columns = lines[header]
    .slice(lines[header].indexOf('(') + 1, lines[header].indexOf(')'))
    .split(',')
    .map((c) => c.trim())
  const wordIndex = columns.indexOf('word')
  const pinyinIndex = columns.indexOf('pinyin')
  if (wordIndex < 0 || pinyinIndex < 0) {
    throw new Error('missing "word"/"pinyin" columns in hsk copy')
  }
  const rows = []
  for (let i = header + 1; i < lines.length; i++) {
    if (lines[i] === '\\.') break
    const cells = lines[i].split('\t')
    if (cells[wordIndex] && cells[pinyinIndex]) {
      rows.push({ word: cells[wordIndex], pinyin: cells[pinyinIndex] })
    }
  }
  return rows
}

// Cross-reference only defs ("erhua variant of 好玩[hao3 wan2]", "see X[x]",
// "abbr. for X[x]", …) -> keep the note and pull in the referenced entry's defs.
const REFERENCE_REF =
  /^(?:(?:(?:erhua|old|traditional|simplified|colloquial)\s+)?(?:variant|form|spelling|reading) of|abbr\. for|see|short for)\s+(.+?)\[([^\]]*)\]$/i

function expandVariantDefs(defs, seen) {
  const out = []
  for (const def of defs) {
    const match = REFERENCE_REF.exec(def.trim())
    if (!match) {
      out.push(def)
      continue
    }
    const target = match[1].split('|').pop().trim()
    const wanted = match[2] ? normalizePinyin(toPinyin(match[2])) : null
    // Guard on target + reading so 血 xiě -> 血 xuè still resolves.
    const key = `${target}\u0000${wanted ?? ''}`
    if (seen.has(key)) continue
    const entries = cedict.get(target)
    const expanded = []
    if (entries) {
      const nextSeen = new Set(seen)
      nextSeen.add(key)
      for (const entry of entries) {
        if (wanted && normalizePinyin(entry.pinyin) !== wanted) continue
        expanded.push(...expandVariantDefs(entry.defs, nextSeen))
      }
    }
    // Drop the redundant "see X" / "variant of X" pointer; only fall back to it
    // when the target could not be resolved.
    if (expanded.length > 0) {
      out.push(...expanded)
    } else {
      out.push(
        def
          .replace(/\s*\[[^\]]*\]$/, '')
          .replace(/([\u4e00-\u9fff]+)\|([\u4e00-\u9fff]+)/g, '$2'),
      )
    }
  }
  return out
}

// "CL:個|个[ge4],位[wei4],名[ming2]" -> ["个", "位", "名"]
const CLASSIFIER_REF = /^CL:\s*(.+)$/i
// "mountain; hill (CL:座[zuo4])" -> "mountain; hill" (+ classifier 座)
const INLINE_CLASSIFIER = /\(CL:([^)]*)\)/gi

function parseClassifiers(spec, classifiers) {
  for (const token of spec.split(/[,;]/)) {
    const word = token.replace(/\[[^\]]*\]/g, '').split('|').pop().trim()
    if (word && !classifiers.includes(word)) classifiers.push(word)
  }
}

function splitClassifiers(defs) {
  const kept = []
  const classifiers = []
  for (const def of defs) {
    const trimmed = def.trim()
    const standalone = CLASSIFIER_REF.exec(trimmed)
    if (standalone) {
      parseClassifiers(standalone[1], classifiers)
      continue
    }
    if (!trimmed.includes('CL:')) {
      kept.push(def)
      continue
    }
    const cleaned = trimmed
      .replace(INLINE_CLASSIFIER, (_, spec) => {
        parseClassifiers(spec, classifiers)
        return ''
      })
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([;,])/g, '$1')
      .replace(/([;,])\s*$/, '')
      .trim()
    if (cleaned) kept.push(cleaned)
  }
  return { defs: kept, classifiers }
}

function sensesFor(word) {
  let entries = cedict.get(word)
  // A few HSK entries are erhua or compounds that CC-CEDICT lacks verbatim.
  if (!entries && word.endsWith('儿')) entries = cedict.get(word.slice(0, -1))
  if (!entries) {
    for (let i = 2; i <= word.length - 2; i++) {
      const head = cedict.get(word.slice(0, i))
      const tail = cedict.get(word.slice(i))
      if (head && tail) {
        entries = [...head, ...tail]
        break
      }
    }
  }
  if (!entries) return null

  // Merge all readings of the word (including capitalized proper-noun ones);
  // the proper-noun / obscure senses are pushed to the end by orderDefs().
  const groups = new Map()
  for (const { pinyin, defs } of entries) {
    const key = normalizePinyin(pinyin)
    let group = groups.get(key)
    if (!group) {
      group = { pinyin, defs: [] }
      groups.set(key, group)
    }
    for (const def of defs) if (!group.defs.includes(def)) group.defs.push(def)
  }
  for (const group of groups.values()) {
    const expanded = [...new Set(expandVariantDefs(group.defs, new Set()))]
    const { defs, classifiers } = splitClassifiers(expanded)
    group.defs = orderDefs(defs.map(cleanDef))
    group.classifiers = classifiers.map(stripTraditional)
  }
  return [...groups.values()]
}

// HSK marks tone sandhi / neutral tones (bú kèqi, yíxià, hòumiàn) while CC-CEDICT
// uses citation tones (bù, yī, miàn). Match in two passes: exact, then a loose
// match that ignores tone marks and keeps only the best-scoring reading(s), so
// polyphonic words lose the readings that do not correspond to the HSK pinyin.
// Irregular interjection readings: HSK ǹg = CC-CEDICT èn, etc.
const applyAliases = (value) =>
  value
    .replace(/ǹg/g, 'èn')
    .replace(/ńg/g, 'én')
    .replace(/ňg/g, 'ěn')
    .replace(/ǹ/g, 'èn')
    .replace(/ń/g, 'én')
    .replace(/ň/g, 'ěn')

const normalizePinyin = (value) =>
  applyAliases(value.replace(/[\s\-'’·]/g, '').toLowerCase())

// Senses that are technically correct but not what an HSK learner wants first:
// surnames, place names, and old / dialectal / vulgar / slang registers. They are
// kept but pushed to the end of the list instead of removed.
const SECONDARY_DEFS = [
  /\bsurname [A-Z]/, // surname Deng
  /\b[A-Z][a-zA-Z]+.*\b(?:a district of|a county(?:-level)? (?:in|city)|a city in|City|County|Province)\b/, // place names
  /\((?:archaic|obsolete|old|dated|dialect|dialectal|Tw|Taiwanese|vulgar|slang|derogatory|offensive|disparaging)\)/i,
]
// "兩個|两个" -> "两个" (CC-CEDICT renders trad|simp inline in defs).
const stripTraditional = (def) =>
  def.replace(
    /([^\s|]*[\u3400-\u9fff][^\s|]*)\|([^\s|]*[\u3400-\u9fff][^\s|]*)/g,
    '$2',
  )

// Drop inline numeric pinyin, e.g. "guqin 古琴[gu3 qin2]" -> "guqin 古琴".
// Only touches brackets whose content is tone-numbered pinyin.
const stripPinyin = (def) =>
  def
    .replace(/\s*\[([^\]]*)\]/g, (match, inner) =>
      /[0-9]/.test(inner) && /^[a-zA-Zü:0-9 ,'-]+$/.test(inner) ? '' : match,
    )
    .replace(/\s{2,}/g, ' ')
    .trim()

const cleanDef = (def) => stripPinyin(stripTraditional(def))

const orderDefs = (defs) => {
  const primary = []
  const secondary = []
  for (const def of defs) {
    ;(SECONDARY_DEFS.some((re) => re.test(def)) ? secondary : primary).push(def)
  }
  return [...primary, ...secondary]
}
// Drop only the tone diacritics, keep the umlaut (ü).
const stripTone = (value) =>
  normalizePinyin(value).normalize('NFD').replace(/[\u0300\u0301\u0304\u030c]/g, '')
const TONED = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/
const baseChar = (char) =>
  char.normalize('NFD').replace(/[\u0300\u0301\u0304\u030c]/g, '')

// A toned syllable still "corresponds" to a neutral-tone one (hǎochù ~ hǎo chu).
const charScore = (a, b) => {
  if (a === b) return 1
  if (baseChar(a) === baseChar(b) && (!TONED.test(a) || !TONED.test(b))) return 0.5
  return 0
}

function pickSenses(all, hskPinyin) {
  const target = normalizePinyin(hskPinyin)
  const exact = all.filter((s) => normalizePinyin(s.pinyin) === target)
  if (exact.length > 0) return exact

  const candidates = all.filter((s) => stripTone(s.pinyin) === stripTone(hskPinyin))
  if (candidates.length <= 1) return candidates.length === 1 ? candidates : all

  // Same base syllables: keep the reading(s) whose tones match best.
  const score = (pinyin) => {
    const value = normalizePinyin(pinyin)
    if (value.length !== target.length) return -1
    let hits = 0
    for (let i = 0; i < target.length; i++) hits += charScore(value[i], target[i])
    return hits
  }
  const scored = candidates.map((sense) => ({ sense, hits: score(sense.pinyin) }))
  const best = Math.max(...scored.map((s) => s.hits))
  return scored.filter((s) => s.hits === best).map((s) => s.sense)
}

const hskRows = readHskRows(readFileSync(dumpPath, 'utf8'))
const rows = []
const seen = new Set()
let filtered = 0
for (const { word, pinyin } of hskRows) {
  const key = `${word}\u0000${pinyin}`
  if (seen.has(key)) continue
  seen.add(key)
  const all = sensesFor(word)
  if (!all) continue
  const senses = pickSenses(all, pinyin)
  if (senses.length < all.length) filtered++
  const classifiers = [...new Set(senses.flatMap((s) => s.classifiers))]
  const plain = senses.map(({ defs }) => ({ en: defs }))
  rows.push([word, pinyin, JSON.stringify(plain), classifiers])
}
const missing = new Set(hskRows.map((r) => r.word)).size -
  new Set(rows.map((r) => r[0])).size

const escapeCopy = (value) =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')

const toPgArray = (items) =>
  items.length === 0
    ? '{}'
    : '{' +
      items
        .map((item) => `"${item.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
        .join(',') +
      '}'

process.stderr.write(
  `CC-CEDICT entries: ${cedict.size}; HSK rows: ${hskRows.length}; ` +
    `distinct (word,pinyin): ${rows.length}; pinyin-filtered words: ${filtered}; ` +
    `missing: ${missing}\n`,
)
if (missing > 0) {
  const withSenses = new Set(rows.map((r) => r[0]))
  const missingWords = [...new Set(hskRows.map((r) => r.word))].filter(
    (w) => !withSenses.has(w),
  )
  process.stderr.write(`  missing words: ${missingWords.join(' ')}\n`)
}

const out = []
out.push('BEGIN;')
out.push('ALTER TABLE public.hsk ADD COLUMN IF NOT EXISTS senses jsonb;')
out.push('ALTER TABLE public.hsk ADD COLUMN IF NOT EXISTS classifiers text[];')
out.push(
  'CREATE TEMP TABLE _cedict_senses ' +
    '(word text, pinyin text, senses jsonb, classifiers text[], ' +
    'PRIMARY KEY (word, pinyin)) ON COMMIT DROP;',
)
out.push('COPY _cedict_senses (word, pinyin, senses, classifiers) FROM stdin;')
for (const [word, pinyin, json, classifiers] of rows) {
  out.push(
    `${escapeCopy(word)}\t${escapeCopy(pinyin)}\t${escapeCopy(json)}\t` +
      escapeCopy(toPgArray(classifiers)),
  )
}
out.push('\\.')
out.push(
  'UPDATE public.hsk h SET senses = s.senses, classifiers = s.classifiers ' +
    'FROM _cedict_senses s WHERE h.word = s.word AND h.pinyin = s.pinyin;',
)
out.push(
  "COMMENT ON COLUMN public.hsk.senses IS " +
    "'CC-CEDICT definitions for this pinyin; data (c) MDBG, CC BY-SA 4.0';",
)
out.push(
  "COMMENT ON COLUMN public.hsk.classifiers IS " +
    "'CC-CEDICT measure words (CL:) for this pinyin; data (c) MDBG, CC BY-SA 4.0';",
)
out.push('COMMIT;')
process.stdout.write(out.join('\n') + '\n')
