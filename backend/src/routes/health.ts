import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOS_PATH = path.join(__dirname, '../../../TOS.md');

// Read TOS once at module load — static file, no per-request I/O needed.
// Eliminates the CodeQL js/missing-rate-limiting finding (file access in handler)
// and removes repeated syscall overhead.
let tosContent: string | null = null;
try {
  tosContent = fs.readFileSync(TOS_PATH, 'utf-8');
} catch {
  // TOS file absent — route will return 404
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Public runtime configuration for the frontend.
  // Only non-secret, browser-safe values are exposed here.
  // Config is frozen at startup — safe to cache for 60 s on the client.
  app.get('/api/config', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=60');
    return reply.send({
      maxFileSize: config.MAX_FILE_SIZE,
      chunkSize: config.CHUNK_SIZE,
      defaultTtl: config.DEFAULT_TTL,
      defaultMaxDownloads: config.DEFAULT_MAX_DOWNLOADS,
      turnstileSiteKey: config.TURNSTILE_SITE_KEY,
      turnstileEnabled: config.TURNSTILE_ENABLED,
    });
  });

  app.get('/api/health', async (_request, reply) => {
    return reply.send({
      status: 'ok',
      timestamp: Date.now(),
      uptime: process.uptime(),
    });
  });

  app.get('/api/tos', async (_request, reply) => {
    if (tosContent === null) {
      return reply.status(404).send({ error: 'TOS not found' });
    }
    return reply.type('text/plain; charset=utf-8').send(tosContent);
  });
}
