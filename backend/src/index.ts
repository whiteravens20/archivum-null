import Fastify from 'fastify';
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

async function main(): Promise<void> {
  validateConfig();

  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
      transport:
        config.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
    trustProxy: true,
    bodyLimit: config.MAX_FILE_SIZE + 1024 * 64,
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
      "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'"
    );
    reply.header(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload'
    );
    return payload;
  });

  // CORS — restrictive in production
  await app.register(cors, {
    origin: config.NODE_ENV === 'production' ? false : true,
    methods: ['GET', 'POST', 'DELETE'],
    credentials: false,
  });

  // Multipart (streaming)
  await app.register(multipart, {
    limits: {
      fileSize: config.MAX_FILE_SIZE,
      files: 1,
      fields: 10,
    },
  });

  // Rate limiting
  await app.register(rateLimitPlugin);

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
      decorateReply: false,
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

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down...`);
    await vaultManager.shutdown();
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start
  try {
    await app.listen({
      host: config.BIND_ADDRESS,
      port: config.PORT,
    });
    app.log.info(`Archivum Null running on ${config.BIND_ADDRESS}:${config.PORT}`);
  } catch (err) {
    app.log.fatal(err);
    process.exit(1);
  }
}

main();
