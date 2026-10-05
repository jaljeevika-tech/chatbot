import { FF } from '../../theme/colors'

/** Full-screen splash, identical to the static `.ff-boot` splash in index.html so the
 *  hand-off is seamless; keep them in sync. No wordmark, since tenants are white-labelled. */
export function BootSplash({ failed = false }: { failed?: boolean }) {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-4"
      style={{ background: FF.bg }}
      role="status"
      aria-live="polite"
    >
      {failed ? (
        <>
          <p className="text-sm" style={{ color: FF.textMuted }}>
            Something went wrong loading this page.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 rounded-xl text-sm font-semibold text-white hover:opacity-90 transition"
            style={{ background: FF.tealDark }}
          >
            Reload
          </button>
        </>
      ) : (
        <>
          <div
            className="w-7 h-7 rounded-full animate-spin"
            style={{ border: `3px solid ${FF.border}`, borderTopColor: FF.tealDark }}
          />
          <span className="sr-only">Loading…</span>
        </>
      )}
    </div>
  )
}
