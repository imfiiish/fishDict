import { useEffect, useRef } from 'react'
import type { SearchItem } from '../api/search'
import { audioSources } from '../lib/audio'
import { Highlight } from './Highlight'
import { SoundButton } from './SoundButton'

/** Korean homonyms carry a trailing index (톤01) — render it as a superscript. */
function Word({ text, query }: { text: string; query: string }) {
  const match = /^(.*?)(\d+)$/.exec(text)
  if (!match) return <Highlight text={text} query={query} />
  return (
    <>
      <Highlight text={match[1]} query={query} />
      <sup className="result__homonym">{match[2]}</sup>
    </>
  )
}

export function ResultList({
  items,
  query,
  activeIndex,
}: {
  items: SearchItem[]
  query: string
  activeIndex: number
}) {
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  return (
    <ul className="result-list" ref={listRef}>
      {items.map((item, index) => {
        const senses = item.senses ?? []
        const classifiers = item.classifiers ?? []
        const korean = item.korean
        return (
          <li
            key={`${item.lang}\u0000${item.word}`}
            className={index === activeIndex ? 'result result--active' : 'result'}
            data-active={index === activeIndex ? 'true' : 'false'}
          >
            <div className="result__head">
              <span className="result__lang">{item.lang}</span>
              <span className="result__word">
                <Word text={item.word} query={query} />
              </span>
              {korean?.romanization && (
                <span className="result__rom">{korean.romanization}</span>
              )}
              {korean?.origin && (
                <span className="result__origin">{korean.origin}</span>
              )}
              {item.sound && (
                <SoundButton sources={audioSources(item.lang, item.sound)} />
              )}
              {item.categories.length > 0 && (
                <span className="result__cats">{item.categories.join(' · ')}</span>
              )}
            </div>

            {korean && korean.senses.length > 0 && (
              <ul className="senses">
                {korean.senses.map((sense, senseIndex) => {
                  const gloss =
                    sense.zh && sense.zh !== '(无对应词汇)' ? sense.zh : sense.en
                  const note = sense.zh_def || sense.ko
                  return (
                    <li className="sense sense--ko" key={senseIndex}>
                      <span className="sense__defs">{gloss}</span>
                      {sense.en && gloss !== sense.en && (
                        <span className="sense__gloss">{sense.en}</span>
                      )}
                      {note && <span className="sense__note">{note}</span>}
                    </li>
                  )
                })}
              </ul>
            )}

            {!korean && (senses.length > 0 || classifiers.length > 0) && (
              <ul className="senses">
                {senses.map((sense, senseIndex) => (
                  <li className="sense" key={senseIndex}>
                    <span className="sense__defs">{sense.en.join('; ')}</span>
                  </li>
                ))}
                {classifiers.length > 0 && (
                  <li className="sense">
                    <span className="sense__cls">
                      量词：{classifiers.join(' / ')}
                    </span>
                  </li>
                )}
              </ul>
            )}
          </li>
        )
      })}
    </ul>
  )
}
