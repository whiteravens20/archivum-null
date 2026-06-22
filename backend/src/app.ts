import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { config, validateConfig } from './config.js';
import { vaultRoutes } from './routes/vault.js';
import { adminRoutes } from './routes/admin.js';
import { healthRoutes } from './routes/health.js';
import { rateLimitPlugin } from './middleware/rateLimit.js';
import { vaultManager } from './vault/manager.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build the fully-wired Fastify instance (without listening).
 *
 * Kept separate from the server entrypoint so tests exercise the exact same
 * wiring production uses — see `__tests__/app.test.ts`.
 */
export async function buildApp(): Promise<FastifyInstance> {
  validateConfig();

  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
      transport:
        config.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
    // Trust only as many proxy hops as configured (default: 1 — nearest proxy).
    // Do NOT use `true` (trust all) in production — clients can spoof X-Forwarded-For.
    trustProxy: config.TRUST_PROXY,
    bodyLimit: config.CHUNK_SIZE + 1024 * 64,
  });

  // Security headers
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-XSS-Protection', '0');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    );
    reply.header(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload'
    );
    return payload;
  });

  // CORS — only the local dev setup (frontend on a separate Vite port) needs
  // cross-origin access. Everything else — production (frontend served same-origin
  // via fastifyStatic), staging, test, or an unrecognised NODE_ENV — fails safe to
  // no cross-origin reflection. Keyed on `development` (not `!== 'production'`) so a
  // misconfigured NODE_ENV can never silently open CORS on an internet-facing box.
  await app.register(cors, {
    origin: config.NODE_ENV === 'development',
    methods: ['GET', 'POST', 'DELETE'],
    credentials: false,
  });

  // Multipart (streaming)
  // The per-request file size limit must accommodate both single-shot uploads
  // (up to MAX_FILE_SIZE) and individual chunk requests (up to CHUNK_SIZE).
  await app.register(multipart, {
    limits: {
      fileSize: config.CHUNK_SIZE + 1024 * 64,
      files: 1,
      fields: 10,
    },
  });

  // Rate limiting.
  // Call the plugin function directly (NOT via app.register) so its global
  // `onRequest` hook is added to this root scope and therefore covers every
  // route below. Using `app.register(rateLimitPlugin)` would encapsulate the
  // hook in a child context where it never runs for the sibling-registered
  // routes — silently disabling all rate limiting.
  await rateLimitPlugin(app);

  // API routes
  await app.register(healthRoutes);
  await app.register(vaultRoutes);
  await app.register(adminRoutes, { prefix: '' });

  // Serve frontend static files in production
  const frontendDist = path.join(__dirname, '..', '..', 'frontend', 'dist');
  if (fs.existsSync(frontendDist)) {
    await app.register(fastifyStatic, {
      root: frontendDist,
      prefix: '/',
    });

    // SPA fallback — serve index.html for non-API routes
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html', frontendDist);
    });
  } else {
    app.setNotFoundHandler(async (_request, reply) => {
      return reply.status(404).send({ error: 'Not found' });
    });
  }

  // Init vault manager
  await vaultManager.init();

  return app;
}
