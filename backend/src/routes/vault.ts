import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { vaultManager } from '../vault/manager.js';
import { config } from '../config.js';
import { verifyTurnstile } from '../middleware/turnstile.js';

interface VaultParams {
  vaultId: string;
}

interface UploadParams {
  uploadId: string;
}

export async function vaultRoutes(app: FastifyInstance): Promise<void> {
  // Upload (create vault)
  app.post('/api/vault', {
    preHandler: verifyTurnstile,
    bodyLimit: config.CHUNK_SIZE + 1024 * 64, // with streaming encryption, single uploads also fit in one CHUNK_SIZE
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: 'No file provided' });
    }

    // Multipart stream was truncated — file exceeded the allowed size
    if (data.file.truncated) {
      // Drain the stream to free the connection before responding
      data.file.resume();
      return reply.status(413).send({ error: 'File exceeds maximum allowed size' });
    }

    // Read TTL and maxDownloads from fields.
    // @fastify/multipart types `fields` as a broad union; we narrow to the known multipart field shape.
    const fields = data.fields as Record<string, { value?: string }>;
    const ttl = Number(fields?.ttl?.value) || config.DEFAULT_TTL;
    const maxDownloads = Number(fields?.maxDownloads?.value) || config.DEFAULT_MAX_DOWNLOADS;
    const rawCPS = Number(fields?.chunkPlaintextSize?.value);
    const chunkPlaintextSize = (Number.isFinite(rawCPS) && rawCPS > 0 && Number.isInteger(rawCPS))
      ? rawCPS
      : config.CRYPTO_CHUNK_SIZE;

    try {
      const meta = await vaultManager.createVault(
        data.file,
        ttl,
        maxDownloads,
        chunkPlaintextSize
      );

      return reply.status(201).send({
        vaultId: meta.vaultId,
        expiresAt: meta.expiresAt,
        maxDownloads: meta.maxDownloads,
        ciphertextSize: meta.ciphertextSize,
      });
    } catch (err: unknown) {
      // Narrow unknown error to Error with an optional statusCode set by the vault manager.
      const error = err as Error & { statusCode?: number };
      if (error.statusCode === 413) {
        return reply.status(413).send({ error: 'File exceeds maximum allowed size' });
      }
      if (error.statusCode === 507) {
        return reply.status(507).send({
          error: 'Storage quota exceeded. Please try again later or contact the administrator.',
        });
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
      ciphertextSize: meta.ciphertextSize,
      chunkPlaintextSize: meta.chunkPlaintextSize,
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

  // ── Chunked upload endpoints ─────────────────────────────────────────────
  // These let the frontend split large encrypted blobs into small chunks that
  // individually stay under Cloudflare's 100 MB per-request limit.

  // 1. Initialise a chunked upload session (Turnstile-verified)
  app.post('/api/vault/upload/init', {
    preHandler: verifyTurnstile,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const totalSize = Number(body?.totalSize);
    const ttl = Number(body?.ttl) || config.DEFAULT_TTL;
    const maxDownloads = Number(body?.maxDownloads) || config.DEFAULT_MAX_DOWNLOADS;
    const rawCPS = Number(body?.chunkPlaintextSize);
    const chunkPlaintextSize = (Number.isFinite(rawCPS) && rawCPS > 0 && Number.isInteger(rawCPS))
      ? rawCPS
      : config.CRYPTO_CHUNK_SIZE;

    if (!totalSize || totalSize <= 0) {
      return reply.status(400).send({ error: 'totalSize is required and must be positive' });
    }

    try {
      const session = vaultManager.initChunkedUpload(totalSize, ttl, maxDownloads, chunkPlaintextSize, request.ip);
      const sessionToken = vaultManager.signUploadSession(session.uploadId);
      return reply.status(201).send({
        uploadId: session.uploadId,
        chunkSize: config.CHUNK_SIZE,
        expiresAt: session.expiresAt,
        sessionToken,
      });
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number };
      if (error.statusCode === 507) {
        return reply.status(507).send({
          error: 'Storage quota exceeded. Please try again later or contact the administrator.',
        });
      }
      return reply.status(error.statusCode || 500).send({ error: error.message || 'Internal server error' });
    }
  });

  // 2. Upload a single chunk
  app.post<{ Params: UploadParams }>('/api/vault/upload/:uploadId/chunk', {
    bodyLimit: config.CHUNK_SIZE + 1024 * 64, // chunk + multipart overhead
  }, async (request, reply) => {
    const { uploadId } = request.params;

    // Verify session HMAC token
    const sessionToken = request.headers['x-session-token'] as string;
    if (!sessionToken || !vaultManager.verifyUploadSession(uploadId, sessionToken)) {
      return reply.status(403).send({ error: 'Invalid or missing session token' });
    }

    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: 'No chunk data provided' });
    }

    const fields = data.fields as Record<string, { value?: string }>;
    const chunkIndex = Number(fields?.chunkIndex?.value);
    if (Number.isNaN(chunkIndex) || chunkIndex < 0) {
      data.file.resume();
      return reply.status(400).send({ error: 'chunkIndex is required and must be non-negative' });
    }

    try {
      const session = await vaultManager.appendChunk(uploadId, chunkIndex, data.file);
      return reply.send({
        uploadId: session.uploadId,
        receivedBytes: session.receivedBytes,
        nextChunkIndex: session.nextChunkIndex,
      });
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode || 500).send({ error: error.message || 'Internal server error' });
    }
  });

  // 3. Finalise — assemble chunks into a vault
  app.post<{ Params: UploadParams }>('/api/vault/upload/:uploadId/complete', async (request, reply) => {
    const { uploadId } = request.params;

    // Verify session HMAC token
    const sessionToken = request.headers['x-session-token'] as string;
    if (!sessionToken || !vaultManager.verifyUploadSession(uploadId, sessionToken)) {
      return reply.status(403).send({ error: 'Invalid or missing session token' });
    }

    try {
      const meta = await vaultManager.completeChunkedUpload(uploadId);
      return reply.status(201).send({
        vaultId: meta.vaultId,
        expiresAt: meta.expiresAt,
        maxDownloads: meta.maxDownloads,
        ciphertextSize: meta.ciphertextSize,
      });
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode || 500).send({ error: error.message || 'Internal server error' });
    }
  });

  // 4. Abort — cancel a chunked upload and delete partial data
  app.delete<{ Params: UploadParams }>('/api/vault/upload/:uploadId', async (request, reply) => {
    const { uploadId } = request.params;

    // Verify session HMAC token
    const sessionToken = request.headers['x-session-token'] as string;
    if (!sessionToken || !vaultManager.verifyUploadSession(uploadId, sessionToken)) {
      return reply.status(403).send({ error: 'Invalid or missing session token' });
    }

    await vaultManager.abortChunkedUpload(uploadId);
    return reply.status(204).send();
  });
}
