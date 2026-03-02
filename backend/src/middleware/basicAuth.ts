import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { timingSafeEqual } from 'node:crypto';

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare with self to maintain constant-ish time
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export async function basicAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const auth = request.headers.authorization;

  if (!config.ADMIN_PASSWORD || config.ADMIN_PASSWORD === 'CHANGE_ME_IMMEDIATELY') {
    reply.status(403).send({ error: 'Admin panel is disabled. Set ADMIN_PASSWORD.' });
    return;
  }

  if (!auth || !auth.startsWith('Basic ')) {
    reply.header('WWW-Authenticate', 'Basic realm="Archivum Null Admin"');
    reply.status(401).send({ error: 'Authentication required' });
    return;
  }

  try {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf-8');
    const [user, ...passParts] = decoded.split(':');
    const pass = passParts.join(':');

    if (!safeCompare(user, config.ADMIN_USER) || !safeCompare(pass, config.ADMIN_PASSWORD)) {
      reply.header('WWW-Authenticate', 'Basic realm="Archivum Null Admin"');
      reply.status(401).send({ error: 'Invalid credentials' });
      return;
    }
  } catch {
    reply.status(401).send({ error: 'Invalid authorization header' });
  }
}
