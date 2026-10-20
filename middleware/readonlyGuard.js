// middleware/readonlyGuard.js
// Rejects non-GET requests, but only on the versioned read-only surface.
//
// Scoped to /api/v1/ on purpose: the dashboard's own endpoints
// (POST /api/auto-sync/run, /api/scrape/run, /api/orders/prefetch,
// /api/reports/daily/generate) are internal writes the UI needs.
// A global guard made the dashboard report "auto sync failed (405)".
module.exports = function readonlyGuard(req, reply, done) {
  const url = req.raw.url || '';
  if (!url.startsWith('/api/v1/')) {
    return done();
  }
  if (req.raw.method !== 'GET') {
    reply.code(405).send({
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: 'Only GET requests are allowed on /api/v1/.',
      },
    });
    return;
  }
  done();
};
