import { useEffect, useRef } from 'react'
import { Highlight } from './Highlight'

export function ResultList({
  items,
  query,
  activeIndex,
}: {
  items: { lang: string; word: string }[]
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
      {items.map((item, index) => (
        <li
          key={`${item.lang}\u0000${item.word}`}
          className={index === activeIndex ? 'result result--active' : 'result'}
          data-active={index === activeIndex ? 'true' : 'false'}
        >
          <span className="result__lang">{item.lang}</span>
          <span className="result__word">
            <Highlight text={item.word} query={query} />
          </span>
        </li>
      ))}
    </ul>
  )
}
