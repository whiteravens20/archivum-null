import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Transform, pipeline } from 'node:stream';
import type { Readable } from 'node:stream';
import { vaultManager } from '../vault/manager.js';
import { config } from '../config.js';
import { verifyTurnstile } from '../middleware/turnstile.js';
import { clientKey } from '../middleware/clientKey.js';

interface VaultParams {
  vaultId: string;
}

interface UploadParams {
  uploadId: string;
}

/**
 * Reply to a failed chunked-upload call. Only the client errors the vault manager
 * raises itself (4xx with a statusCode) are passed through; anything else — fs errors
 * in particular, whose messages carry STORAGE_PATH — is logged and hidden behind a 500.
 */
function sendUploadError(request: FastifyRequest, reply: FastifyReply, err: unknown) {
  const error = err as Error & { statusCode?: number; expectedChunkIndex?: number };
  if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
    return reply
      .status(error.statusCode)
      .send(
        typeof error.expectedChunkIndex === 'number'
          ? { error: error.message, expectedChunkIndex: error.expectedChunkIndex }
          : { error: error.message },
      );
  }
  request.log.error(err, 'Chunked upload failed');
  return reply.status(500).send({ error: 'Internal server error' });
}

/**
 * The most one upload request may add to storage: the size limit of its file part,
 * which the multipart parser enforces (app.ts). Fastify's own bodyLimit does not apply
 * to multipart bodies, so there is no point in setting one on the upload routes.
 */
const UPLOAD_REQUEST_LIMIT = config.CHUNK_SIZE + 1024 * 64;

/**
 * A file part over the multipart size limit is not an error to the parser: it cuts
 * the part off at the limit and ends the stream as if the part were complete. Read
 * through this, such a part fails with 413, as soon as the limit is hit and at the
 * latest where it ends. What was cut short then goes down the path of every other
 * failed write, which removes it, and is never stored as a whole upload.
 */
function refuseTruncated(file: Readable & { truncated: boolean }): Readable {
  const tooLarge = () =>
    Object.assign(new Error('File exceeds maximum allowed size'), { statusCode: 413 });
  const guard = new Transform({
    transform(chunk, _encoding, callback) {
      callback(null, chunk);
    },
    flush(callback) {
      callback(file.truncated ? tooLarge() : null);
    },
  });
  file.once('limit', () => guard.destroy(tooLarge()));
  // pipeline, not pipe: an error or a close on either side has to end the other.
  pipeline(file, guard, () => {});
  return guard;
}

export async function vaultRoutes(app: FastifyInstance): Promise<void> {
  // Upload (create vault)
  // A single-request upload carries what fits into one chunk; anything larger is
  // sent through the chunked endpoints below.
  app.post(
    '/api/vault',
    {
      preHandler: verifyTurnstile,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: 'No file provided' });
      }

      // Read TTL and maxDownloads from fields.
      // @fastify/multipart types `fields` as a broad union; we narrow to the known multipart field shape.
      const fields = data.fields as Record<string, { value?: string }>;
      const ttl = Number(fields?.ttl?.value) || config.DEFAULT_TTL;
      const maxDownloads = Number(fields?.maxDownloads?.value) || config.DEFAULT_MAX_DOWNLOADS;
      const rawCPS = Number(fields?.chunkPlaintextSize?.value);
      const chunkPlaintextSize =
        Number.isFinite(rawCPS) && rawCPS > 0 && Number.isInteger(rawCPS)
          ? rawCPS
          : config.CRYPTO_CHUNK_SIZE;

      // The request's own length bounds what this upload can add to storage. Handing it
      // over lets the quota refuse an upload before any of it is read.
      const contentLength = Number(request.headers['content-length']);
      const declaredSize =
        Number.isSafeInteger(contentLength) && contentLength > 0
          ? Math.min(contentLength, UPLOAD_REQUEST_LIMIT)
          : undefined;

      const body = refuseTruncated(data.file);
      try {
        const meta = await vaultManager.createVault(
          body,
          ttl,
          maxDownloads,
          chunkPlaintextSize,
          declaredSize,
        );

        return reply.status(201).send({
          vaultId: meta.vaultId,
          expiresAt: meta.expiresAt,
          maxDownloads: meta.maxDownloads,
          ciphertextSize: meta.ciphertextSize,
        });
      } catch (err: unknown) {
        // An upload refused before it was read still has its body waiting. Drain it.
        body.resume();
        // Narrow unknown error to Error with an optional statusCode set by the vault manager.
        const error = err as Error & { statusCode?: number };
        if (error.statusCode === 413) {
          return reply.status(413).send({ error: 'File exceeds maximum allowed size' });
        }
        if (error.statusCode === 400) {
          return reply.status(400).send({ error: error.message });
        }
        if (error.statusCode === 507) {
          return reply.status(507).send({
            error: 'Storage quota exceeded. Please try again later or contact the administrator.',
          });
        }
        request.log.error(err, 'Failed to create vault');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

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

  // Download vault content (consumes a download).
  // No HEAD twin: Fastify would run this handler for HEAD as well, and a request that
  // only asks for headers would take a download without delivering anything.
  app.get<{ Params: VaultParams }>(
    '/api/vault/:vaultId/download',
    {
      exposeHeadRoute: false,
    },
    async (request, reply) => {
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
    },
  );

  // ── Chunked upload endpoints ─────────────────────────────────────────────
  // These let the frontend split large encrypted blobs into small chunks that
  // individually stay under Cloudflare's 100 MB per-request limit.

  // 1. Initialise a chunked upload session (Turnstile-verified)
  app.post(
    '/api/vault/upload/init',
    {
      preHandler: verifyTurnstile,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as Record<string, unknown> | undefined;
      const totalSize = Number(body?.totalSize);
      const ttl = Number(body?.ttl) || config.DEFAULT_TTL;
      const maxDownloads = Number(body?.maxDownloads) || config.DEFAULT_MAX_DOWNLOADS;
      const rawCPS = Number(body?.chunkPlaintextSize);
      const chunkPlaintextSize =
        Number.isFinite(rawCPS) && rawCPS > 0 && Number.isInteger(rawCPS)
          ? rawCPS
          : config.CRYPTO_CHUNK_SIZE;

      if (!Number.isSafeInteger(totalSize) || totalSize <= 0) {
        return reply
          .status(400)
          .send({ error: 'totalSize is required and must be a positive integer' });
      }

      try {
        const session = vaultManager.initChunkedUpload(
          totalSize,
          ttl,
          maxDownloads,
          chunkPlaintextSize,
          clientKey(request.ip),
        );
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
        return sendUploadError(request, reply, err);
      }
    },
  );

  // 2. Upload a single chunk
  app.post<{ Params: UploadParams }>(
    '/api/vault/upload/:uploadId/chunk',
    async (request, reply) => {
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

      const body = refuseTruncated(data.file);
      try {
        const session = await vaultManager.appendChunk(uploadId, chunkIndex, body);
        return reply.send({
          uploadId: session.uploadId,
          receivedBytes: session.receivedBytes,
          nextChunkIndex: session.nextChunkIndex,
        });
      } catch (err: unknown) {
        // A refused chunk never reached storage, so its body is still unread. Drain it,
        // or the connection is left waiting on a request nobody will finish reading.
        body.resume();
        return sendUploadError(request, reply, err);
      }
    },
  );

  // 3. Finalise — assemble chunks into a vault
  app.post<{ Params: UploadParams }>(
    '/api/vault/upload/:uploadId/complete',
    async (request, reply) => {
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
        return sendUploadError(request, reply, err);
      }
    },
  );

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
