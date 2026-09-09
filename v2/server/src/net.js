// Shared client-IP helpers.
// Behind cloudflared every socket arrives from loopback, so the real client IP lives in
// CF-Connecting-IP / X-Forwarded-For. Those headers are trusted ONLY when the socket itself is
// loopback (i.e. they were set by our own tunnel) — a client connecting directly cannot spoof them.
const isLoopback = (ip) => !ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.');

const isLocalIp = (ip) => {
  if (isLoopback(ip)) return true;
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return v4.startsWith('192.168.') || v4.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(v4)
    || /^fe80:/i.test(ip) || /^fc|^fd/i.test(ip);
};

function clientIp(req) {
  const sock = req?.socket?.remoteAddress || '';
  if (!isLoopback(sock)) return sock; // direct connection: proxy headers are untrusted
  const h = req?.headers || {};
  if (h['cf-connecting-ip']) return String(h['cf-connecting-ip']).trim();
  if (h['x-forwarded-for']) return String(h['x-forwarded-for']).split(',')[0].trim();
  return sock;
}

module.exports = { clientIp, isLocalIp, isLoopback };
