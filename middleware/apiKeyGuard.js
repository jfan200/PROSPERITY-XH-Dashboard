// middleware/apiKeyGuard.js
// Simple API key authentication middleware for versioned read‑only endpoints.
// Expects the secret key to be provided via the environment variable DSH_API_KEY.
// Returns 401 Unauthorized if the "x-api-key" header is missing or does not match.

module.exports = function apiKeyGuard(req, reply, done) {
  const expectedKey = String(process.env.DSH_API_KEY || "").trim();
  const providedKey = req.headers["x-api-key"] || "";
  if (!expectedKey || providedKey !== expectedKey) {
    reply.code(401).send({
      error: {
        code: "UNAUTHORIZED",
        message: "Invalid or missing API key.",
      },
    });
    return;
  }
  done();
};
