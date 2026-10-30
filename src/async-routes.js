// Express 4 ignores promises returned by middleware and route handlers, so a failing `await` would leave
// the request hanging. This passes rejected promises to the error handler (what Express 5 does natively).
// Required once, before any routes are created.
const Layer = require('express/lib/router/layer');

const handle = Layer.prototype.handle_request;
Layer.prototype.handle_request = function handleRequest(req, res, next) {
  if (this.handle.length > 3) return handle.call(this, req, res, next); // error handlers
  try {
    const out = this.handle(req, res, next);
    if (out && typeof out.catch === 'function') out.catch(next);
  } catch (e) {
    next(e);
  }
};
