import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

/** React.lazy for a *named* export, keeping prop types:
 *    const MisPage = lazyNamed(() => import('./MisPage'), 'MisPage')
 *  Calling the loader again (e.g. to warm a chunk) is free; the module map dedupes it. */
export function lazyNamed<M extends Record<K, ComponentType<any>>, K extends keyof M & string>(
  loader: () => Promise<M>,
  name: K,
): LazyExoticComponent<M[K]> {
  return lazy(() => loader().then(m => ({ default: m[name] })))
}
