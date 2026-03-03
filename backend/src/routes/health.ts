import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOS_PATH = path.join(__dirname, '../../../TOS.md');

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (_request, reply) => {
    return reply.send({
      status: 'ok',
      timestamp: Date.now(),
      uptime: process.uptime(),
    });
  });

  app.get('/api/tos', async (_request, reply) => {
    try {
      const content = fs.readFileSync(TOS_PATH, 'utf-8');
      return reply.type('text/plain; charset=utf-8').send(content);
    } catch {
      return reply.status(404).send({ error: 'TOS not found' });
    }
  });
}
