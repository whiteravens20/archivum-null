import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { timingSafeEqual } from 'node:crypto';
import { clientKey } from './clientKey.js';
import { recordAdminAuthFailure } from './rateLimit.js';

/**
 * Compare a supplied credential with the configured one. timingSafeEqual needs two
 * buffers of one length, so the supplied value is first cut or zero-padded to the
 * length of the configured one: the comparison always runs over that whole length,
 * with no early exit, and a difference in length is settled after it has run.
 */
function safeCompare(supplied: string, expected: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  const fitted = Buffer.alloc(expectedBytes.length);
  suppliedBytes.copy(fitted);
  const sameBytes = timingSafeEqual(fitted, expectedBytes);
  return sameBytes && suppliedBytes.length === expectedBytes.length;
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
