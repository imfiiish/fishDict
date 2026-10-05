#!/usr/bin/env node
// Imports English per-word data into public.english.
//
// Output: a SQL script on stdout to be piped into psql, e.g.
//   node db/import-english.mjs | docker compose exec -T db psql -U fishdict -d fishdict
//
// The table holds one row per English word:
//   word  text primary key
//   ipa   jsonb  { "us": "/ˈbæŋk/", "uk": "/bˈæŋk/" }  (keys omitted when absent)
//   senses jsonb  [{ "pos": "n.", "zh": ["银行", "堤", "岸"] }, ...]
//   sound text   audio filename, sha1('en:' + word)[:10] + '.mp3'
//
// Pronunciations come from ipa-dict (MIT) and are stored verbatim; the US file
// marks stress at the syllable onset, the UK file marks it before the vowel.
//   https://github.com/open-dict-data/ipa-dict
// Translations come from ECDICT (MIT).
//   https://github.com/skywind3000/ECDICT
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dumpPath = join(here, 'dump.sql')
const IPA_SOURCES = {
  us: {
    file: join(here, 'ipa_en_US.txt'),
    url: 'https://raw.githubusercontent.com/open-dict-data/ipa-dict/master/data/en_US.txt',
  },
  uk: {
    file: join(here, 'ipa_en_UK.txt'),
    url: 'https://raw.githubusercontent.com/open-dict-data/ipa-dict/master/data/en_UK.txt',
  },
}
const ECDICT_URL =
  'https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv'
const ecdictPath = join(here, 'ecdict.csv')

for (const { file, url } of Object.values(IPA_SOURCES)) {
  if (existsSync(file)) continue
  process.stderr.write(`downloading ipa-dict -> ${file}\n`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  writeFileSync(file, Buffer.from(await res.arrayBuffer()))
}
if (!existsSync(ecdictPath)) {
  process.stderr.write(`downloading ECDICT -> ${ecdictPath}\n`)
  const res = await fetch(ECDICT_URL)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  writeFileSync(ecdictPath, Buffer.from(await res.arrayBuffer()))
}

// ---------------------------------------------------------------------------
// Word list: every English word, parsed from db/dump.sql (no DB needed)
// ---------------------------------------------------------------------------
function readEnglishWords(sql) {
  const lines = sql.split('\n')
  const header = lines.findIndex((l) => l.startsWith('COPY public.words ('))
  if (header < 0) throw new Error('COPY public.words block not found in dump.sql')
  const columns = lines[header]
    .slice(lines[header].indexOf('(') + 1, lines[header].indexOf(')'))
    .split(',')
    .map((c) => c.trim())
  const langIndex = columns.indexOf('lang')
  const wordIndex = columns.indexOf('word')
  if (langIndex < 0 || wordIndex < 0) {
    throw new Error('missing "lang"/"word" columns in words copy')
  }
  const words = []
  for (let i = header + 1; i < lines.length; i++) {
    if (lines[i] === '\\.') break
    const cells = lines[i].split('\t')
    if (cells[langIndex] === 'en' && cells[wordIndex]) words.push(cells[wordIndex])
  }
  return words
}

/** Read `word\t/ipa/` lines into a Map<word, value>. */
function parseIpa(path) {
  const map = new Map()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    map.set(line.slice(0, tab), line.slice(tab + 1))
  }
  return map
}

/** Parse one CSV record (no embedded newlines; ECDICT encodes them as \\n). */
function parseCsvLine(line) {
  const out = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      out.push(field)
      field = ''
    } else field += ch
  }
  out.push(field)
  return out
}

/** Load ECDICT `word -> translation`, plus a lowercase index for fallback. */
function parseEcdict(path) {
  const exact = new Map()
  const lower = new Map()
  const text = readFileSync(path, 'utf8')
  let start = text.indexOf('\n') + 1 // skip header
  for (const line of text.slice(start).split('\n')) {
    if (!line) continue
    const cells = parseCsvLine(line)
    const word = cells[0]
    const translation = cells[3]
      ?.replace(/\\r\\n|\\n|\\r/g, '\n')
      .trim()
    if (!word || !translation) continue
    exact.set(word, translation)
    if (!lower.has(word.toLowerCase())) lower.set(word.toLowerCase(), translation)
  }
  return { exact, lower }
}

const ipa = { us: parseIpa(IPA_SOURCES.us.file), uk: parseIpa(IPA_SOURCES.uk.file) }
const ecdict = parseEcdict(ecdictPath)
const sound = (word) =>
  createHash('sha1').update(`en:${word}`).digest('hex').slice(0, 10) + '.mp3'

// ipa-dict keys are lowercase and ECDICT is inconsistently cased, so both use a
// case-insensitive fallback. A few words collide with a different word; those
// get an explicit value here.
const OVERRIDES = {
  IT: { us: '/ˌaɪˈti/', uk: '/ˌaɪˈti/', zh: 'abbr. 信息技术（Information Technology）' },
  Ms: { us: '/ˈmɪz/', uk: '/ˈmɪz/', zh: 'n. 女士' },
  BCE: { zh: 'abbr. 公元前（Before Common Era）' },
}

function lookup(dict, word) {
  if (dict.has(word)) return dict.get(word)
  const lower = word.toLowerCase()
  return lower !== word && dict.has(lower) ? dict.get(lower) : null
}

function lookupZh(word) {
  return ecdict.exact.get(word) ?? ecdict.lower.get(word.toLowerCase()) ?? null
}

/**
 * ECDICT uses its own POS tags (vt./vi./a.); normalize them to the same set
 * Oxford uses so both can be shown the same way. Bracketed tags such as [医]
 * are subject domains, not parts of speech, so they move to `domain`.
 */
const POS_MAP = {
  'n.': 'n.',
  'v.': 'v.',
  'vt.': 'v.',
  'vi.': 'v.',
  'a.': 'adj.',
  'adj.': 'adj.',
  'adv.': 'adv.',
  'pron.': 'pron.',
  'prep.': 'prep.',
  'conj.': 'conj.',
  'num.': 'number',
  'interj.': 'exclam.',
  'aux.': 'auxiliary v.',
  'art.': 'det.',
  'pl.': 'n.',
  'abbr.': 'abbr.',
  'pref.': 'pref.',
}

/** Split on commas, but ignore commas nested inside brackets, e.g.
 * "依赖(如对药物的依赖, 即瘾或癖)" stays one gloss. */
function splitGlosses(body) {
  const OPEN = '(（[〔【｛{'
  const CLOSE = ')）]〕】｝}'
  const out = []
  let depth = 0
  let current = ''
  for (const ch of body) {
    if (OPEN.includes(ch)) depth++
    else if (CLOSE.includes(ch)) depth = Math.max(0, depth - 1)
    if ((ch === ',' || ch === '，') && depth === 0) {
      out.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  out.push(current.trim())
  return out.filter(Boolean)
}

// ECDICT subject tags (bracketed). Only these are split out as `domain`;
// a bracketed character inside a gloss (e.g. 疾[病], 适应[作用]) stays text.
const DOMAINS = new Set(['计', '医', '法', '经', '化', '机', '电', '建'])

/**
 * Turn an ECDICT translation into structured senses, one per line. A line is
 * `[pos]? [domain]? glosses`:
 *   "n. 银行, 堤, 岸"   -> { pos: "n.", zh: ["银行", "堤", "岸"] }
 *   "[医] 库"          -> { domain: "[医]", zh: ["库"] }
 *   "art. [计] 累加器"  -> { pos: "det.", domain: "[计]", zh: ["累加器"] }
 */
function parseSenses(translation) {
  const senses = []
  for (const line of translation.split('\n')) {
    let body = line.trim()
    if (!body) continue
    let pos
    let domain
    const posMatch = /^([a-z]+\.)\s*/.exec(body)
    if (posMatch) {
      pos = POS_MAP[posMatch[1]] ?? posMatch[1]
      body = body.slice(posMatch[0].length)
    }
    const domainMatch = /^\[([^\]]+)\]\s*/.exec(body)
    if (domainMatch && DOMAINS.has(domainMatch[1])) {
      domain = `[${domainMatch[1]}]`
      body = body.slice(domainMatch[0].length)
    }
    const zh = splitGlosses(body)
    if (zh.length === 0) continue
    const sense = {}
    if (pos) sense.pos = pos
    if (domain) sense.domain = domain
    sense.zh = zh
    senses.push(sense)
  }
  return senses
}

const words = [...new Set(readEnglishWords(readFileSync(dumpPath, 'utf8')))]
const rows = words.map((word) => {
  const entry = {}
  const us = lookup(ipa.us, word)
  const uk = lookup(ipa.uk, word)
  if (us) entry.us = us
  if (uk) entry.uk = uk
  if (OVERRIDES[word]) {
    if (OVERRIDES[word].us) entry.us = OVERRIDES[word].us
    if (OVERRIDES[word].uk) entry.uk = OVERRIDES[word].uk
  }
  const zh = OVERRIDES[word]?.zh ?? lookupZh(word)
  const senses = zh ? parseSenses(zh) : []
  return {
    word,
    ipa: Object.keys(entry).length > 0 ? JSON.stringify(entry) : null,
    senses: senses.length > 0 ? JSON.stringify(senses) : null,
    sound: sound(word),
  }
})

const noIpa = rows.filter((r) => !r.ipa).length
const noSenses = rows.filter((r) => !r.senses).length

const escapeCopy = (value) =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')

process.stderr.write(
  `english words: ${words.length}; without ipa: ${noIpa}; ` +
    `without senses: ${noSenses}\n`,
)

const out = []
out.push('BEGIN;')
out.push('DROP TABLE IF EXISTS public.english;')
out.push(
  'CREATE TABLE public.english (' +
    'word text PRIMARY KEY, ipa jsonb, senses jsonb, sound text);',
)
// The per-word audio filename now lives in public.english only.
out.push('ALTER TABLE public.cet DROP COLUMN IF EXISTS sound;')
out.push('ALTER TABLE public.gaokao DROP COLUMN IF EXISTS sound;')
out.push('ALTER TABLE public.oxford DROP COLUMN IF EXISTS sound;')
out.push(
  'ALTER TABLE public.words DROP COLUMN IF EXISTS ipa_us, ' +
    'DROP COLUMN IF EXISTS ipa_uk;',
)
out.push(
  'CREATE TEMP TABLE _english (word text, ipa jsonb, senses jsonb, sound text) ' +
    'ON COMMIT DROP;',
)
out.push('COPY _english (word, ipa, senses, sound) FROM stdin;')
for (const { word, ipa: json, senses, sound: snd } of rows) {
  out.push(
    `${escapeCopy(word)}\t${json ? escapeCopy(json) : '\\N'}\t` +
      `${senses ? escapeCopy(senses) : '\\N'}\t${snd}`,
  )
}
out.push('\\.')
out.push(
  'INSERT INTO public.english (word, ipa, senses, sound) ' +
    'SELECT word, ipa, senses, sound FROM _english e ' +
    'ON CONFLICT (word) DO UPDATE SET ipa = EXCLUDED.ipa, ' +
    'senses = EXCLUDED.senses, sound = EXCLUDED.sound;',
)
out.push(
  "COMMENT ON COLUMN public.english.ipa IS " +
    "'US/UK IPA from ipa-dict (MIT), stored verbatim; data (c) ipa-dict contributors';",
)
out.push(
  "COMMENT ON COLUMN public.english.sound IS " +
    "'Audio filename: sha1(''en:'' || word)[:10] || ''.mp3''';",
)
out.push(
  "COMMENT ON COLUMN public.english.senses IS " +
    "'Senses from ECDICT translations (MIT): [{ pos, zh: [...] }]';",
)
out.push('COMMIT;')

process.stdout.write(out.join('\n') + '\n')
