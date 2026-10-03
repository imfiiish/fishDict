export function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim()
  if (!q) return <>{text}</>

  const index = text.toLowerCase().indexOf(q.toLowerCase())
  if (index < 0) return <>{text}</>

  return (
    <>
      {text.slice(0, index)}
      <mark className="hl">{text.slice(index, index + q.length)}</mark>
      {text.slice(index + q.length)}
    </>
  )
}
