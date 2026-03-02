import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { vaultManager } from '../vault/manager.js';
import { config } from '../config.js';
import { verifyTurnstile } from '../middleware/turnstile.js';

interface VaultParams {
  vaultId: string;
}

export async function vaultRoutes(app: FastifyInstance): Promise<void> {
  // Upload (create vault)
  app.post('/api/vault', {
    preHandler: verifyTurnstile,
    bodyLimit: config.MAX_FILE_SIZE + 1024 * 64, // metadata overhead
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: 'No file provided' });
    }

    // Read TTL and maxDownloads from fields
    const fields = data.fields as Record<string, { value?: string }>;
    const ttl = Number(fields?.ttl?.value) || config.DEFAULT_TTL;
    const maxDownloads = Number(fields?.maxDownloads?.value) || config.DEFAULT_MAX_DOWNLOADS;
    const originalName = data.filename || 'unnamed';
    const mimeType = data.mimetype || 'application/octet-stream';

    try {
      const meta = await vaultManager.createVault(
        data.file,
        originalName,
        mimeType,
        ttl,
        maxDownloads
      );

      return reply.status(201).send({
        vaultId: meta.vaultId,
        expiresAt: meta.expiresAt,
        maxDownloads: meta.maxDownloads,
        ciphertextSize: meta.ciphertextSize,
      });
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number };
      if (error.statusCode === 413) {
        return reply.status(413).send({ error: 'File exceeds maximum allowed size' });
      }
      request.log.error(err, 'Failed to create vault');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // Get vault info (without consuming a download)
  app.get<{ Params: VaultParams }>('/api/vault/:vaultId', async (request, reply) => {
    const { vaultId } = request.params;
    const meta = vaultManager.getVault(vaultId);

    if (!meta) {
      return reply.status(404).send({ error: 'Vault not found or expired' });
    }

    return reply.send({
      vaultId: meta.vaultId,
      originalName: meta.originalName,
      mimeType: meta.mimeType,
      ciphertextSize: meta.ciphertextSize,
      createdAt: meta.createdAt,
      expiresAt: meta.expiresAt,
      remainingDownloads: meta.remainingDownloads,
    });
  });

  // Download vault content (consumes a download)
  app.get<{ Params: VaultParams }>('/api/vault/:vaultId/download', async (request, reply) => {
    const { vaultId } = request.params;
    const result = await vaultManager.consumeDownload(vaultId);

    if (!result) {
      return reply.status(404).send({ error: 'Vault not found or expired' });
    }

    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', result.meta.ciphertextSize);
    reply.header('Content-Disposition', `attachment; filename="encrypted.bin"`);
    // Security headers — no caching of vault content
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    reply.header('Pragma', 'no-cache');

    return reply.send(result.stream);
  });
}
