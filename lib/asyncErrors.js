// lib/asyncErrors.js — Express 4 doesn't catch rejected promises from async
// handlers, so a throw after an `await` leaves the request hanging. Patch the
// shared Layer so every handler's rejection goes to next(err) and lands in the
// global error handler (Express 5 does this natively).

import Layer from 'express/lib/router/layer.js'

Layer.prototype.handle_request = function handle(req, res, next) {
  const fn = this.handle
  if (fn.length > 3) return next()  // error handler, not a request handler
  try {
    const ret = fn(req, res, next)
    if (ret && typeof ret.catch === 'function') {
      ret.catch(err => next(err || new Error('Rejected without a reason')))
    }
  } catch (err) {
    next(err)
  }
}
