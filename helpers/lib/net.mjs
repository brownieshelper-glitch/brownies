/// The address a request came from. Behind Caddy every socket is 127.0.0.1 and the client is the LAST value of
/// X-Forwarded-For: Caddy replaces that header for clients it does not trust, so the last value is the real one.
/// Off the proxy the socket address is used and the header is ignored, so nobody can pick their own address.
export function clientIp(req) {
  const sock = String(req?.socket?.remoteAddress || "");
  const loop = /^(::1|127\.|::ffff:127\.)/.test(sock);
  const fwd = String(req?.headers?.["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (loop && fwd.length) return fwd[fwd.length - 1];
  return sock || "?";
}
