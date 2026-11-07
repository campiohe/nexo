// Tiny global toast system. Usable from anywhere (React or not): `toast('Saved')`, `toast(err, 'error')`.
import { create } from 'zustand'

export type ToastKind = 'info' | 'success' | 'error'

export interface ToastItem {
  id: number
  message: string
  kind: ToastKind
}

interface ToastState {
  toasts: ToastItem[]
  dismiss(id: number): void
}

export const useToasts = create<ToastState>()((set) => ({
  toasts: [],
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

let nextId = 1
const MAX_VISIBLE = 4

/** Show a toast. Accepts an Error/unknown too (its message is used). Returns the toast id. */
export function toast(message: unknown, kind: ToastKind = 'info', durationMs?: number): number {
  const text = errorMessage(message)
  const id = nextId++
  useToasts.setState((s) => {
    // Collapse exact duplicates that are already visible.
    const rest = s.toasts.filter((t) => !(t.message === text && t.kind === kind))
    return { toasts: [...rest, { id, message: text, kind }].slice(-MAX_VISIBLE) }
  })
  const ms = durationMs ?? (kind === 'error' ? 6000 : 3500)
  setTimeout(() => useToasts.getState().dismiss(id), ms)
  return id
}

/** Readable message from anything thrown. */
export function errorMessage(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message || 'Something went wrong'
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string')
    return (err as { message: string }).message
  return 'Something went wrong'
}
