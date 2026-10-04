import { useEffect, useRef } from 'react'
import type { SearchItem } from '../api/search'
import { Highlight } from './Highlight'

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
        return (
          <li
            key={`${item.lang}\u0000${item.word}`}
            className={index === activeIndex ? 'result result--active' : 'result'}
            data-active={index === activeIndex ? 'true' : 'false'}
          >
            <div className="result__head">
              <span className="result__lang">{item.lang}</span>
              <span className="result__word">
                <Highlight text={item.word} query={query} />
              </span>
              {item.categories.length > 0 && (
                <span className="result__cats">{item.categories.join(' · ')}</span>
              )}
            </div>

            {(senses.length > 0 || classifiers.length > 0) && (
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
