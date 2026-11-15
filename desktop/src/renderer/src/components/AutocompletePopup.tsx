// The list that floats above the composer while typing `@name` or `:emoji`: arrow keys / Enter / Tab are
// handled by the textarea (it stays focused); this renders the options and reports hover and picks.
import { useEffect, useRef, type ReactNode } from 'react'

export interface AutocompletePopupProps<T> {
  /** Id of the listbox; option ids are `${id}-${index}` (for aria-activedescendant). */
  id: string
  title: ReactNode
  /** Accessible name of the listbox. */
  label: string
  items: T[]
  active: number
  itemKey(item: T): string
  renderItem(item: T): ReactNode
  onHover(index: number): void
  onPick(item: T): void
}

export function AutocompletePopup<T>({ id, title, label, items, active, itemKey, renderItem, onHover, onPick }: AutocompletePopupProps<T>) {
  const listRef = useRef<HTMLUListElement>(null)
  // Keep the highlighted row visible while arrowing through a long list.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(`${id}-${active}`)}`)?.scrollIntoView({ block: 'nearest' })
  }, [id, active])
  return (
    <div className="mention-popup">
      <div className="mention-popup-title">{title}</div>
      <ul ref={listRef} id={id} role="listbox" aria-label={label}>
        {items.map((item, i) => (
          <li
            key={itemKey(item)}
            id={`${id}-${i}`}
            role="option"
            aria-selected={i === active}
            className={`mention-option ${i === active ? 'is-active' : ''}`}
            onMouseEnter={() => onHover(i)}
            // mousedown, not click: keep the textarea focused (its blur closes the popup).
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(item)
            }}
          >
            {renderItem(item)}
          </li>
        ))}
      </ul>
    </div>
  )
}
