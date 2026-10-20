module.exports = function readonlyGuard(req, reply, done) {
  if (req.raw.method !== 'GET') {
    // Allow health endpoints and static files
    const allowed = ['/healthz', '/readyz', '/status'];
    if (allowed.some(p => req.raw.url.startsWith(p))) {
      return done();
    }
    reply.code(405).send({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET requests are allowed.' } });
    return;
  }
  done();
};
