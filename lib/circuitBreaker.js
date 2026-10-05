// Three-state circuit breaker (CLOSED / OPEN / HALF_OPEN) for the service proxies;
// callers catch the error and serve locally.

export class CircuitBreaker {
  /** threshold = failures before opening; timeout = ms before a HALF_OPEN retry. */
  constructor(name, { threshold = 5, timeout = 30_000 } = {}) {
    this.name         = name
    this.threshold    = threshold
    this.timeout      = timeout
    this.failureCount = 0
    this.lastFailure  = 0
    this.state        = 'CLOSED' // CLOSED | OPEN | HALF_OPEN
  }

  _onSuccess() {
    this.failureCount = 0
    if (this.state !== 'CLOSED') {
      console.log(`[CircuitBreaker] ${this.name} → CLOSED`)
      this.state = 'CLOSED'
    }
  }

  _onFailure() {
    this.failureCount++
    this.lastFailure = Date.now()
    if (this.failureCount >= this.threshold) {
      console.warn(`[CircuitBreaker] ${this.name} → OPEN after ${this.failureCount} failures`)
      this.state = 'OPEN'
    }
  }

  /** Run fn() through the breaker; throws if OPEN or if fn() throws. */
  async call(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailure > this.timeout) {
        console.log(`[CircuitBreaker] ${this.name} → HALF_OPEN (retrying)`)
        this.state = 'HALF_OPEN'
      } else {
        throw new Error(`Circuit ${this.name} is OPEN — upstream service unavailable`)
      }
    }

    try {
      const result = await fn()
      this._onSuccess()
      return result
    } catch (e) {
      this._onFailure()
      throw e
    }
  }

  get isOpen() {
    // After the timeout an OPEN breaker reports not-open, so callers gating on
    // isOpen (e.g. runAI.js) reach call() for the HALF_OPEN retry.
    if (this.state === 'OPEN' && Date.now() - this.lastFailure > this.timeout) return false
    return this.state === 'OPEN'
  }
  get isClosed()   { return this.state === 'CLOSED' }
  get isHalfOpen() { return this.state === 'HALF_OPEN' }
}
