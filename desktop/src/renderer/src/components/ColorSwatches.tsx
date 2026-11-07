import { CheckIcon } from './icons'
import { inkOn } from '../lib/colors'

interface Props {
  value: string
  onChange(color: string): void
  colors: readonly string[]
  disabled?: boolean
}

export function ColorSwatches({ value, onChange, colors, disabled }: Props) {
  return (
    <div className="swatches" role="radiogroup" aria-label="Color">
      {colors.map((c) => {
        const selected = c.toLowerCase() === value.toLowerCase()
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={c}
            className={`swatch ${selected ? 'is-selected' : ''}`}
            style={{ background: c, color: inkOn(c) }}
            onClick={() => onChange(c)}
            disabled={disabled}
          >
            {selected && <CheckIcon size={14} strokeWidth={3} />}
          </button>
        )
      })}
    </div>
  )
}
