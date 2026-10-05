import { useEffect, useState } from 'react'

// Returns `value` only after it has stopped changing for `delayMs` — used by
// the roster search boxes so typing "Ramesh" fires one request, not six.
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}
