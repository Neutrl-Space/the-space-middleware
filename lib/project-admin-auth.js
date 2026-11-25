import crypto from 'node:crypto';

export function hasProjectAdminAccess(header, secret) {
  if (typeof secret !== 'string' || !secret || typeof header !== 'string' || !header) return false;
  const digest = value => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(header), digest(secret));
}
