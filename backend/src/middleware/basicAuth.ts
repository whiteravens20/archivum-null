import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { clientKey } from './clientKey.js';
import { recordAdminAuthFailure } from './rateLimit.js';

/**
 * Compared as SHA-256 digests. Two digests always have the same length, so the time
 * the comparison takes says nothing about the expected value, its length included.
 */
function safeCompare(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/** A login that failed: counted against the client, then refused. */
function refuse(request: FastifyRequest, reply: FastifyReply, error: string): void {
  recordAdminAuthFailure(clientKey(request.ip));
  reply.header('WWW-Authenticate', 'Basic realm="Archivum Null Admin"');
  reply.status(401).send({ error });
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
    refuse(request, reply, 'Authentication required');
    return;
  }

  const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf-8');
  const [user, ...passParts] = decoded.split(':');
  const pass = passParts.join(':');

  // Execute both comparisons unconditionally to prevent timing side-channels
  // that could reveal whether the username alone was correct.
  const userOk = safeCompare(user, config.ADMIN_USER);
  const passOk = safeCompare(pass, config.ADMIN_PASSWORD);
  if (!userOk || !passOk) {
    refuse(request, reply, 'Invalid credentials');
  }
}
