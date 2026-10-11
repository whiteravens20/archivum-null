import type { VaultMetadata, ChunkedUploadSession } from './types.js';
import { config, calcEncryptionOverhead, MIN_TTL_SECONDS, MAX_DOWNLOADS_PER_VAULT } from '../config.js';
import { LocalStorage } from '../storage/local.js';
import { nanoid } from 'nanoid';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';

const storage = new LocalStorage(config.STORAGE_PATH);
const vaults = new Map<string, VaultMetadata>();
const uploadSessions = new Map<string, ChunkedUploadSession>();

/**
 * Bytes held for uploads that are not vaults yet: the declared size of every open
 * chunked session, and of every single-request upload while it is being written.
 * Without it, uploads that overlap would each pass the quota check on their own and
 * together exceed MAX_TOTAL_STORAGE.
 */
let reservedBytes = 0;

/**
 * Count of open (uncompleted) chunked-upload sessions per client IP.
 * Caps how much storage quota a single IP can tie up via reservations
 * without ever completing an upload (reservation-exhaustion DoS).
 */
const ipSessionCounts = new Map<string, number>();

/** HMAC secret generated at startup — used to sign upload session tokens. */
const sessionSecret = randomBytes(32);

// Max bytes the client-side metadata header can occupy:
// 2 (nameLen) + 510 (MAX_NAME_BYTES) + 2 (mimeLen) + 254 (MAX_MIME_BYTES)
const MAX_METADATA_HEADER = 768;

// Every vault and upload id is a nanoid of this length.
const ID_LENGTH = 24;

// The smallest ciphertext a real upload produces: one chunk's IV and tag around the
// 4 bytes of an empty metadata header (12 + 16 + 4). Anything shorter cannot be
// decrypted into a file, and zero bytes would even pass for one in the client.
const MIN_CIPHERTEXT_SIZE = 32;

// Cleanup interval — every 60 seconds, purge expired vaults
const CLEANUP_INTERVAL = 60_000;

/** Storage is full, or the upload would take it over MAX_TOTAL_STORAGE. */
function quotaExceeded(): Error {
  return Object.assign(
    new Error('Storage quota exceeded. Please try again later or contact the administrator.'),
    { statusCode: 507 }
  );
}

/**
 * Whether what was read from a meta.json is the metadata of the vault in that
 * directory. A file of that name written by anything else must not become a vault.
 */
function isVaultMetadata(meta: VaultMetadata, vaultId: string): boolean {
  return (
    meta.vaultId === vaultId &&
    Number.isFinite(meta.ciphertextSize) &&
    Number.isFinite(meta.expiresAt) &&
    Number.isFinite(meta.remainingDownloads)
  );
}

/** A second request for an upload session whose data file is being written to. */
function sessionBusy(): Error {
  return Object.assign(
    new Error('Another request for this upload is still being processed'),
    { statusCode: 409 }
  );
}

export class VaultManager {
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  async init(): Promise<void> {
    await storage.init();
    // Restore metadata from disk
    await this.restoreMetadata();
    // Remove any orphaned _uploads directories left after a crash / restart.
    // At this point uploadSessions is empty, so every _uploads/* dir is an orphan.
    const activeIds = new Set(Array.from(uploadSessions.keys()));
    await storage.purgeOrphanedUploads(activeIds);
    this.startCleanup();
  }

  private async restoreMetadata(): Promise<void> {
    try {
      const ids = await storage.listVaults();
      const foreign: string[] = [];
      for (const vaultId of ids) {
        const meta = await storage.readMetadata(vaultId);
        if (meta && isVaultMetadata(meta, vaultId)) {
          // Check if expired
          if (meta.expiresAt <= Date.now() || meta.remainingDownloads <= 0) {
            await this.deleteVault(vaultId);
          } else {
            vaults.set(vaultId, meta);
          }
        } else if (vaultId.length === ID_LENGTH && (await storage.holdsOnlyVaultFiles(vaultId))) {
          // Orphaned vault directory (missing or corrupted meta.json) —
          // e.g. crash between writeFile and writeMetadata.  Clean it up.
          await storage.deleteVault(vaultId);
        } else {
          // Not something this app made: another tool's directory under a shared
          // STORAGE_PATH, or a bind mount of a directory that holds more than vaults.
          // Removing it would delete data that is not the app's to delete.
          foreign.push(vaultId);
        }
      }
      if (foreign.length > 0) {
        const shown = foreign.slice(0, 5).join(', ');
        const more = foreign.length > 5 ? ` and ${foreign.length - 5} more` : '';
        console.warn(
          `[WARN] STORAGE_PATH holds directories that are not vaults and were left alone: ${shown}${more}. Give the app a directory of its own.`
        );
      }
    } catch {
      // First run — no vaults exist yet
    }
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => this.purgeExpired(), CLEANUP_INTERVAL);
    // Don't keep process alive just for cleanup
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  private async purgeExpired(): Promise<void> {
    const now = Date.now();

    const expiredVaults = Array.from(vaults.entries())
      .filter(([, meta]) => meta.expiresAt <= now || meta.remainingDownloads <= 0)
      .map(([id]) => this.deleteVault(id));

    const expiredSessions = Array.from(uploadSessions.entries())
      .filter(([, session]) => session.expiresAt <= now)
      .map(([id, session]) => {
        this.releaseSessionAccounting(session);
        uploadSessions.delete(id);
        return storage.deleteChunkedUpload(id).catch(() => {});
      });

    await Promise.allSettled([...expiredVaults, ...expiredSessions]);
  }

  /**
   * Release the quota reservation and per-IP session slot held by a session.
   * Must be called whenever a session is discarded (completed, aborted, or expired).
   */
  private releaseSessionAccounting(session: ChunkedUploadSession): void {
    reservedBytes = Math.max(0, reservedBytes - session.totalSize);
    if (session.clientIp) {
      const remaining = (ipSessionCounts.get(session.clientIp) ?? 0) - 1;
      if (remaining <= 0) ipSessionCounts.delete(session.clientIp);
      else ipSessionCounts.set(session.clientIp, remaining);
    }
  }

  async createVault(
    stream: Readable,
    ttl: number,
    maxDownloads: number,
    chunkPlaintextSize: number = config.CRYPTO_CHUNK_SIZE,
    declaredSize?: number
  ): Promise<VaultMetadata> {
    // MAX_FILE_SIZE refers to the user's raw file — account for the encrypted
    // metadata header (filename + MIME) that the frontend prepends before encryption.
    const plaintextMax = config.MAX_FILE_SIZE + MAX_METADATA_HEADER;
    const maxSize = plaintextMax + calcEncryptionOverhead(plaintextMax);

    // What the request says it carries, when it says anything usable. The upload cannot
    // store more than that, so it is what the quota holds for it while it is written.
    const declared =
      declaredSize !== undefined && Number.isSafeInteger(declaredSize) && declaredSize > 0
        ? Math.min(declaredSize, maxSize)
        : 0;

    // Enforce the global storage quota before reading the upload. Reservations of
    // uploads still in progress count, chunked and single-request alike, so uploads
    // that overlap cannot each pass the same check.
    if (config.MAX_TOTAL_STORAGE > 0) {
      const projected = this.getStats().totalStorageBytes + reservedBytes + declared;
      // With nothing declared, only a quota that is already full shows here. The real
      // size is checked below, once it is known.
      const over = declared > 0
        ? projected > config.MAX_TOTAL_STORAGE
        : projected >= config.MAX_TOTAL_STORAGE;
      if (over) throw quotaExceeded();
    }

    let held = declared;
    reservedBytes += held;
    try {
      const vaultId = nanoid(ID_LENGTH);
      const now = Date.now();

      const clampedTtl = Math.min(Math.max(ttl, MIN_TTL_SECONDS), config.MAX_TTL);
      const clampedDownloads = Math.min(Math.max(maxDownloads, 1), MAX_DOWNLOADS_PER_VAULT);

      let size: number;
      try {
        size = await storage.writeFile(vaultId, stream, maxSize);
      } catch (err) {
        // Ensure the vault directory is fully removed on any write failure
        await storage.deleteVault(vaultId).catch(() => {});
        throw err;
      }

      if (size < MIN_CIPHERTEXT_SIZE) {
        await storage.deleteVault(vaultId).catch(() => {});
        throw Object.assign(
          new Error('Upload is too small to be an encrypted file'),
          { statusCode: 400 }
        );
      }

      // What was stored takes the place of what was declared: the declared length
      // includes the request's framing, and some requests declare none. Held until the
      // vault is in the map, so two uploads finishing together cannot both fit.
      reservedBytes += size - held;
      held = size;
      if (
        config.MAX_TOTAL_STORAGE > 0 &&
        this.getStats().totalStorageBytes + reservedBytes > config.MAX_TOTAL_STORAGE
      ) {
        await storage.deleteVault(vaultId).catch(() => {});
        throw quotaExceeded();
      }

      const meta: VaultMetadata = {
        vaultId,
        ciphertextSize: size,
        chunkPlaintextSize,
        createdAt: now,
        expiresAt: now + clampedTtl * 1000,
        remainingDownloads: clampedDownloads,
        maxDownloads: clampedDownloads,
      };

      await storage.writeMetadata(vaultId, meta);
      vaults.set(vaultId, meta);

      return meta;
    } finally {
      reservedBytes = Math.max(0, reservedBytes - held);
    }
  }

  // ── Chunked upload ────────────────────────────────────────────────────────

  initChunkedUpload(totalSize: number, ttl: number, maxDownloads: number, chunkPlaintextSize: number = config.CRYPTO_CHUNK_SIZE, clientIp?: string): ChunkedUploadSession {
    const plaintextMax = config.MAX_FILE_SIZE + MAX_METADATA_HEADER;
    const maxAllowed = plaintextMax + calcEncryptionOverhead(plaintextMax);
    if (!Number.isSafeInteger(totalSize) || totalSize < MIN_CIPHERTEXT_SIZE || totalSize > maxAllowed) {
      throw Object.assign(new Error('Invalid total size'), { statusCode: 400 });
    }

    // Cap concurrent open sessions per IP. Without this, a single client can open
    // many sessions — each reserving quota via reservedBytes — and never complete
    // them, tying up MAX_TOTAL_STORAGE and blocking legitimate uploads until the
    // sessions expire (reservation-exhaustion DoS).
    if (clientIp && config.MAX_UPLOAD_SESSIONS_PER_IP > 0) {
      const open = ipSessionCounts.get(clientIp) ?? 0;
      if (open >= config.MAX_UPLOAD_SESSIONS_PER_IP) {
        throw Object.assign(
          new Error('Too many concurrent uploads. Complete or cancel an upload before starting another.'),
          { statusCode: 429 }
        );
      }
    }

    // Enforce global storage quota — include reservedBytes to prevent TOCTOU.
    if (config.MAX_TOTAL_STORAGE > 0) {
      const { totalStorageBytes } = this.getStats();
      if (totalStorageBytes + reservedBytes + totalSize > config.MAX_TOTAL_STORAGE) {
        throw quotaExceeded();
      }
    }

    // Reserve quota and a per-IP session slot for the duration of the upload.
    reservedBytes += totalSize;
    if (clientIp) ipSessionCounts.set(clientIp, (ipSessionCounts.get(clientIp) ?? 0) + 1);

    const uploadId = nanoid(ID_LENGTH);
    const session: ChunkedUploadSession = {
      uploadId,
      totalSize,
      receivedBytes: 0,
      nextChunkIndex: 0,
      ttl: Math.min(Math.max(ttl, MIN_TTL_SECONDS), config.MAX_TTL),
      maxDownloads: Math.min(Math.max(maxDownloads, 1), MAX_DOWNLOADS_PER_VAULT),
      chunkPlaintextSize,
      expiresAt: Date.now() + config.UPLOAD_SESSION_TTL * 1000,
      clientIp,
    };
    uploadSessions.set(uploadId, session);
    return session;
  }

  async appendChunk(uploadId: string, chunkIndex: number, stream: Readable): Promise<ChunkedUploadSession> {
    const session = uploadSessions.get(uploadId);
    if (!session || session.expiresAt <= Date.now()) {
      if (session) {
        this.releaseSessionAccounting(session);
        uploadSessions.delete(uploadId);
        await storage.deleteChunkedUpload(uploadId).catch(() => {});
      }
      throw Object.assign(new Error('Upload session not found or expired'), { statusCode: 404 });
    }

    // One chunk at a time. Whatever its index, a second request for the session is
    // refused while a write is running: the size bound handed to storage below is only
    // right when it counts every byte written before it, and two writers appending to
    // one file would interleave. The flag is set before the first await, so requests
    // that arrive together cannot both pass.
    if (session.writing) {
      throw sessionBusy();
    }

    if (chunkIndex !== session.nextChunkIndex) {
      throw Object.assign(
        new Error(`Expected chunk index ${session.nextChunkIndex}, got ${chunkIndex}`),
        { statusCode: 400 }
      );
    }

    session.writing = true;
    try {
      const chunkBytes = await storage.appendChunk(
        uploadId,
        stream,
        session.totalSize,
        session.receivedBytes
      );
      // Advance only once the bytes are on disk. A failed chunk leaves the session
      // where it was, so the client can send the same index again.
      session.receivedBytes += chunkBytes;
      session.nextChunkIndex += 1;
    } finally {
      session.writing = false;
    }

    return session;
  }

  async completeChunkedUpload(uploadId: string): Promise<VaultMetadata> {
    const session = uploadSessions.get(uploadId);
    if (!session || session.expiresAt <= Date.now()) {
      if (session) {
        this.releaseSessionAccounting(session);
        uploadSessions.delete(uploadId);
        await storage.deleteChunkedUpload(uploadId).catch(() => {});
      }
      throw Object.assign(new Error('Upload session not found or expired'), { statusCode: 404 });
    }

    // A chunk still being written is not part of the count yet. Judging the upload
    // now would call it empty or incomplete, and discard a session that is in use.
    if (session.writing) {
      throw sessionBusy();
    }

    if (session.receivedBytes === 0) {
      this.releaseSessionAccounting(session);
      uploadSessions.delete(uploadId);
      await storage.deleteChunkedUpload(uploadId).catch(() => {});
      throw Object.assign(new Error('No chunks received'), { statusCode: 400 });
    }

    if (session.receivedBytes !== session.totalSize) {
      throw Object.assign(
        new Error(`Upload incomplete: expected ${session.totalSize} bytes, got ${session.receivedBytes}`),
        { statusCode: 400 }
      );
    }

    const vaultId = nanoid(ID_LENGTH);
    const now = Date.now();

    // Held while the file is moved, so a second complete or a late chunk is refused
    // instead of racing the rename.
    session.writing = true;
    try {
      await storage.finalizeChunkedUpload(uploadId, vaultId);
    } catch (err) {
      session.writing = false;
      throw err;
    }
    this.releaseSessionAccounting(session);
    uploadSessions.delete(uploadId);

    const meta: VaultMetadata = {
      vaultId,
      ciphertextSize: session.receivedBytes,
      chunkPlaintextSize: session.chunkPlaintextSize,
      createdAt: now,
      expiresAt: now + session.ttl * 1000,
      remainingDownloads: session.maxDownloads,
      maxDownloads: session.maxDownloads,
    };

    await storage.writeMetadata(vaultId, meta);
    vaults.set(vaultId, meta);
    return meta;
  }

  async abortChunkedUpload(uploadId: string): Promise<void> {
    const session = uploadSessions.get(uploadId);
    if (session) {
      this.releaseSessionAccounting(session);
    }
    uploadSessions.delete(uploadId);
    await storage.deleteChunkedUpload(uploadId).catch(() => {});
  }

  /**
   * Generate an HMAC token that binds an uploadId to a session.
   * The frontend must present this token on every chunk/complete/abort request.
   */
  signUploadSession(uploadId: string): string {
    return createHmac('sha256', sessionSecret).update(uploadId).digest('hex');
  }

  /** Verify that a session token matches the given uploadId. */
  verifyUploadSession(uploadId: string, token: string): boolean {
    const expected = this.signUploadSession(uploadId);
    if (expected.length !== token.length) return false;
    // Constant-time comparison
    const bufA = Buffer.from(expected);
    const bufB = Buffer.from(token);
    return timingSafeEqual(bufA, bufB);
  }

  getVault(vaultId: string): VaultMetadata | undefined {
    const meta = vaults.get(vaultId);
    if (!meta) return undefined;
    if (meta.expiresAt <= Date.now() || meta.remainingDownloads <= 0) {
      // Do NOT call deleteVault() here. A concurrent consumeDownload may have
      // just decremented remainingDownloads to 0 and is still opening / streaming
      // the file. Triggering an immediate rm() would race with that open, causing
      // ENOENT errors. Instead, rely on stream 'end' handlers and purgeExpired()
      // (every 60 s) for physical cleanup.
      return undefined;
    }
    return meta;
  }

  async consumeDownload(vaultId: string): Promise<{ stream: Readable; meta: VaultMetadata } | null> {
    const meta = this.getVault(vaultId);
    if (!meta) return null;

    // Decrement FIRST (synchronously, before the initial await) to maintain
    // atomicity in Node.js's cooperative scheduling model.  If we awaited anything
    // before this, concurrent requests in the same microtask batch could all pass
    // the getVault() guard with the same remainingDownloads value.
    //
    // Trade-off (Risk-4): if the underlying file is missing (storage corruption),
    // the slot has already been consumed.  That is acceptable — a corrupt vault
    // would be deleted regardless, and the damage is bounded to a single slot.
    meta.remainingDownloads -= 1;
    await storage.writeMetadata(vaultId, meta);

    const stream = await storage.readFile(vaultId);
    if (!stream) {
      // File missing despite valid metadata — storage is corrupt.
      // Delete the vault; we intentionally do NOT restore the counter because
      // the vault is irrecoverable and will never serve further downloads.
      await this.deleteVault(vaultId);
      return null;
    }

    // Schedule deletion if no downloads remain
    if (meta.remainingDownloads <= 0) {
      // Delete after stream ends
      stream.on('end', () => {
        this.deleteVault(vaultId).catch(() => {});
      });
      stream.on('error', () => {
        this.deleteVault(vaultId).catch(() => {});
      });
    }

    return { stream, meta };
  }

  /** Whether the id is a vault this instance holds, expired or not. */
  hasVault(vaultId: string): boolean {
    return vaults.has(vaultId);
  }

  async deleteVault(vaultId: string): Promise<boolean> {
    vaults.delete(vaultId);
    return storage.deleteVault(vaultId);
  }

  listVaults(): VaultMetadata[] {
    const now = Date.now();
    const result: VaultMetadata[] = [];
    for (const meta of vaults.values()) {
      if (meta.expiresAt > now && meta.remainingDownloads > 0) {
        result.push(meta);
      }
    }
    return result;
  }

  getStats(): { totalVaults: number; totalStorageBytes: number; activeVaults: number } {
    const now = Date.now();
    let totalStorage = 0;
    let active = 0;
    for (const meta of vaults.values()) {
      if (meta.expiresAt > now && meta.remainingDownloads > 0) {
        totalStorage += meta.ciphertextSize;
        active++;
      }
    }
    return {
      totalVaults: vaults.size,
      totalStorageBytes: totalStorage,
      activeVaults: active,
    };
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }
}

export const vaultManager = new VaultManager();
