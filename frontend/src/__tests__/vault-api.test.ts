/**
 * API vault client — unit tests.
 *
 * Verifies uploadVault, getVaultInfo, downloadVault with mocked fetch/XHR.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock crypto module — vault.ts now does encryption internally
vi.mock('../crypto/encrypt.js', () => ({
  buildMetadataHeader: () => new Uint8Array([0, 4, 116, 101, 115, 116, 0, 0]),
  encryptChunk: async (plaintext: Uint8Array) => plaintext, // passthrough
  calculateTotalEncryptedSize: (size: number) => size,
  countChunks: (size: number, chunkSize: number) => {
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error('Invalid crypto chunk size');
    return Math.max(1, Math.ceil(size / chunkSize));
  },
  PER_CHUNK_OVERHEAD: 28,
}));

describe('vault API client', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getVaultInfo', () => {
    it('should return vault info on success', async () => {
      const mockInfo = {
        vaultId: 'test-id',
        ciphertextSize: 1024,
        chunkPlaintextSize: 5242880,
        createdAt: 1000,
        expiresAt: 9999,
        remainingDownloads: 5,
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockInfo),
      });

      const { getVaultInfo } = await import('../api/vault.js');
      const info = await getVaultInfo('test-id');

      expect(info).toEqual(mockInfo);
      expect(fetch).toHaveBeenCalledWith('/api/vault/test-id');
    });

    it('should throw on error response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: 'Vault not found' }),
      });

      const { getVaultInfo } = await import('../api/vault.js');
      await expect(getVaultInfo('bad-id')).rejects.toThrow('Vault not found');
    });

    it('should throw generic error when JSON parsing fails', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('invalid json')),
      });

      const { getVaultInfo } = await import('../api/vault.js');
      await expect(getVaultInfo('bad-id')).rejects.toThrow('Request failed');
    });

    it('should encode vault ID in URL', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const { getVaultInfo } = await import('../api/vault.js');
      await getVaultInfo('id/with/slashes');

      expect(fetch).toHaveBeenCalledWith('/api/vault/id%2Fwith%2Fslashes');
    });
  });

  describe('downloadVault', () => {
    it('should return a blob on success', async () => {
      const mockBlob = new Blob(['encrypted']);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(mockBlob),
      });

      const { downloadVault } = await import('../api/vault.js');
      const blob = await downloadVault('test-id');

      expect(blob).toBe(mockBlob);
      expect(fetch).toHaveBeenCalledWith('/api/vault/test-id/download');
    });

    it('should throw on error response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: 'Download failed' }),
      });

      const { downloadVault } = await import('../api/vault.js');
      await expect(downloadVault('bad-id')).rejects.toThrow('Download failed');
    });
  });

  describe('uploadVault', () => {
    function createMockXhr(overrides: Record<string, unknown> = {}) {
      let resolveSend: () => void;
      const sendCalled = new Promise<void>(r => { resolveSend = r; });

      const Ctor = function (this: Record<string, unknown>) {
        Object.assign(this, {
          open: vi.fn(),
          setRequestHeader: vi.fn(),
          send: vi.fn(() => resolveSend()),
          abort: vi.fn(),
          upload: {},
          status: 201,
          responseText: '{}',
          onload: null,
          onerror: null,
          ...overrides,
        });
        Ctor._instance = this;
      } as unknown as { new (): Record<string, unknown>; _instance: Record<string, unknown>; sendCalled: Promise<void> };
      Ctor.sendCalled = sendCalled;
      return Ctor;
    }

    it('should resolve on successful upload via XHR', async () => {
      const mockResponse = {
        vaultId: 'new-vault',
        expiresAt: 9999,
        maxDownloads: 5,
        ciphertextSize: 100,
      };
      const XhrCtor = createMockXhr({
        status: 201,
        responseText: JSON.stringify(mockResponse),
      });
      vi.stubGlobal('XMLHttpRequest', XhrCtor);

      const { uploadVault } = await import('../api/vault.js');
      const file = new File(['data'], 'test.txt', { type: 'text/plain' });
      const mockKey = {} as CryptoKey;
      const promise = uploadVault(file, mockKey, 5242880, 3600, 5, 'token123');

      await XhrCtor.sendCalled;
      const inst = XhrCtor._instance;
      (inst.onload as () => void)();

      const result = await promise;
      expect(result).toEqual(mockResponse);
      expect(inst.open).toHaveBeenCalledWith('POST', '/api/vault');
      expect(inst.setRequestHeader).toHaveBeenCalledWith('x-turnstile-token', 'token123');
    });

    it('should reject on XHR error', async () => {
      const XhrCtor = createMockXhr();
      vi.stubGlobal('XMLHttpRequest', XhrCtor);

      const { uploadVault } = await import('../api/vault.js');
      const file = new File(['data'], 'test.txt', { type: 'text/plain' });
      const mockKey = {} as CryptoKey;
      const promise = uploadVault(file, mockKey, 5242880, 3600, 5);

      await XhrCtor.sendCalled;
      (XhrCtor._instance.onerror as () => void)();

      await expect(promise).rejects.toThrow('Network error');
    });

    it('should reject on non-201 response', async () => {
      const XhrCtor = createMockXhr({
        status: 413,
        responseText: JSON.stringify({ error: 'File too large' }),
      });
      vi.stubGlobal('XMLHttpRequest', XhrCtor);

      const { uploadVault } = await import('../api/vault.js');
      const file = new File(['data'], 'test.txt', { type: 'text/plain' });
      const mockKey = {} as CryptoKey;
      const promise = uploadVault(file, mockKey, 5242880, 3600, 5);

      await XhrCtor.sendCalled;
      (XhrCtor._instance.onload as () => void)();

      await expect(promise).rejects.toThrow('File too large');
    });

    it('should call onProgress during upload', async () => {
      const XhrCtor = createMockXhr({
        status: 201,
        responseText: JSON.stringify({ vaultId: 'v', expiresAt: 0, maxDownloads: 1, ciphertextSize: 1 }),
      });
      vi.stubGlobal('XMLHttpRequest', XhrCtor);

      const onProgress = vi.fn();
      const { uploadVault } = await import('../api/vault.js');
      const file = new File(['data'], 'test.txt', { type: 'text/plain' });
      const mockKey = {} as CryptoKey;
      const promise = uploadVault(file, mockKey, 5242880, 3600, 5, undefined, onProgress);

      await XhrCtor.sendCalled;
      const inst = XhrCtor._instance;

      // Encryption progress callbacks happen before XHR (30%)
      // XHR upload progress maps to 30-100% range
      const upload = inst.upload as { onprogress: (e: unknown) => void };
      upload.onprogress({ lengthComputable: true, loaded: 50, total: 100 });
      // XHR upload progress: 0.3 + (50/100) * 0.7 ≈ 0.65
      const xhrCall = onProgress.mock.calls.find(c => c[0] > 0.6);
      expect(xhrCall).toBeDefined();
      expect(xhrCall![0]).toBeCloseTo(0.65, 10);

      (inst.onload as () => void)();
      await promise;
    });

    it('should abort XHR when signal is aborted', async () => {
      const XhrCtor = createMockXhr({
        status: 201,
        responseText: '{}',
      });
      vi.stubGlobal('XMLHttpRequest', XhrCtor);

      const ac = new AbortController();
      const { uploadVault } = await import('../api/vault.js');
      const file = new File(['data'], 'test.txt', { type: 'text/plain' });
      const mockKey = {} as CryptoKey;
      const promise = uploadVault(file, mockKey, 5242880, 3600, 5, undefined, undefined, ac.signal);

      await XhrCtor.sendCalled;
      const inst = XhrCtor._instance;

      ac.abort(new DOMException('Upload cancelled', 'AbortError'));

      await expect(promise).rejects.toThrow('Upload cancelled');
      expect(inst.abort).toHaveBeenCalled();
    });

    it('should send nothing when the crypto chunk size is unusable', async () => {
      const XhrCtor = createMockXhr();
      vi.stubGlobal('XMLHttpRequest', XhrCtor);
      globalThis.fetch = vi.fn();

      const { uploadVault, uploadVaultChunked } = await import('../api/vault.js');
      const file = new File(['data'], 'test.txt', { type: 'text/plain' });
      const mockKey = {} as CryptoKey;
      // What a value missing from the runtime configuration turns into
      const missing = undefined as unknown as number;

      await expect(uploadVault(file, mockKey, missing, 3600, 5)).rejects.toThrow('Invalid crypto chunk size');
      await expect(uploadVaultChunked(file, mockKey, missing, 3600, 5)).rejects.toThrow('Invalid crypto chunk size');

      // No request with an empty body, and no upload session opened
      expect(XhrCtor._instance).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('uploadVaultChunked', () => {
    const init = { uploadId: 'up-1', chunkSize: 38, expiresAt: 9999, sessionToken: 'tok' };
    const created = { vaultId: 'v-1', expiresAt: 9999, maxDownloads: 5, ciphertextSize: 20 };
    const key = {} as CryptoKey;
    // 8 bytes of header (the mock above) and 12 of file: 20 bytes, so two crypto chunks
    // of 10. With a chunk size of 38 from the server, each request carries one of them.
    const upload = async (signal?: AbortSignal) => {
      const { uploadVaultChunked } = await import('../api/vault.js');
      const file = new File(['x'.repeat(12)], 'test.txt', { type: 'text/plain' });
      return uploadVaultChunked(file, key, 10, 3600, 5, undefined, undefined, signal);
    };

    function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(headers),
        json: () => Promise.resolve(body),
      };
    }
    const stored = (index: number) => reply(200, { uploadId: 'up-1', receivedBytes: 10 * (index + 1), nextChunkIndex: index + 1 });

    /** A fetch that answers init, complete and abort, and takes each chunk's answer from a queue. */
    function mockFetch(chunkAnswers: Array<ReturnType<typeof reply> | Error>, completeAnswer = reply(201, created)) {
      const calls: string[] = [];
      globalThis.fetch = vi.fn(async (url: string, options?: RequestInit) => {
        if (url.endsWith('/upload/init')) {
          calls.push('init');
          return reply(201, init);
        }
        if (url.endsWith('/chunk')) {
          calls.push(`chunk ${(options?.body as FormData).get('chunkIndex')}`);
          const answer = chunkAnswers.shift();
          if (answer === undefined) throw new Error('a chunk request nobody expected');
          if (answer instanceof Error) throw answer;
          return answer;
        }
        if (url.endsWith('/complete')) {
          calls.push('complete');
          return completeAnswer;
        }
        if (options?.method === 'DELETE') {
          calls.push('abort');
          return reply(204, null);
        }
        throw new Error(`a request nobody expected: ${options?.method} ${url}`);
      }) as unknown as typeof fetch;
      return calls;
    }

    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should send the chunks in order and complete the upload', async () => {
      const calls = mockFetch([stored(0), stored(1)]);

      await expect(upload()).resolves.toEqual(created);
      expect(calls).toEqual(['init', 'chunk 0', 'chunk 1', 'complete']);
    });

    it('should send a chunk again after a network failure', async () => {
      const calls = mockFetch([new TypeError('Failed to fetch'), stored(0), stored(1)]);

      const result = upload();
      await vi.advanceTimersByTimeAsync(1000);

      await expect(result).resolves.toEqual(created);
      expect(calls).toEqual(['init', 'chunk 0', 'chunk 0', 'chunk 1', 'complete']);
    });

    it('should wait as long as the server asks before retrying a rate-limited chunk', async () => {
      const calls = mockFetch([
        reply(429, { error: 'Too many requests. Try again later.', retryAfter: 7 }, { 'Retry-After': '7' }),
        stored(0),
        stored(1),
      ]);

      const result = upload();
      await vi.advanceTimersByTimeAsync(6000);
      expect(calls).toEqual(['init', 'chunk 0']);

      await vi.advanceTimersByTimeAsync(1000);
      await expect(result).resolves.toEqual(created);
      expect(calls).toEqual(['init', 'chunk 0', 'chunk 0', 'chunk 1', 'complete']);
    });

    it('should go on when the server already has the chunk whose response was lost', async () => {
      const calls = mockFetch([
        new TypeError('Failed to fetch'),
        reply(400, { error: 'Expected chunk index 1, got 0', expectedChunkIndex: 1 }),
        stored(1),
      ]);

      const result = upload();
      await vi.advanceTimersByTimeAsync(1000);

      await expect(result).resolves.toEqual(created);
      expect(calls).toEqual(['init', 'chunk 0', 'chunk 0', 'chunk 1', 'complete']);
    });

    it('should not take an out-of-step answer to a first attempt for success', async () => {
      const calls = mockFetch([reply(400, { error: 'Expected chunk index 1, got 0', expectedChunkIndex: 1 })]);

      await expect(upload()).rejects.toThrow('Expected chunk index 1, got 0');
      expect(calls).toEqual(['init', 'chunk 0', 'abort']);
    });

    it('should not retry a refusal that another attempt cannot change', async () => {
      const calls = mockFetch([reply(413, { error: 'File too large' })]);

      await expect(upload()).rejects.toThrow('File too large');
      expect(calls).toEqual(['init', 'chunk 0', 'abort']);
    });

    it('should give up after four attempts and abort the session', async () => {
      const failure = () => reply(500, { error: 'Internal server error' });
      const calls = mockFetch([failure(), failure(), failure(), failure()]);

      const result = upload();
      const outcome = expect(result).rejects.toThrow('Internal server error');
      await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);

      await outcome;
      expect(calls).toEqual(['init', 'chunk 0', 'chunk 0', 'chunk 0', 'chunk 0', 'abort']);
    });

    it('should abort the session when completion fails', async () => {
      const calls = mockFetch([stored(0), stored(1)], reply(500, { error: 'Internal server error' }));

      await expect(upload()).rejects.toThrow('Internal server error');
      expect(calls).toEqual(['init', 'chunk 0', 'chunk 1', 'complete', 'abort']);
    });

    it('should stop waiting and abort the session when cancelled during a pause', async () => {
      const calls = mockFetch([reply(429, { error: 'Too many requests. Try again later.' }, { 'Retry-After': '30' })]);
      const ac = new AbortController();

      const result = upload(ac.signal);
      const outcome = expect(result).rejects.toThrow('Upload cancelled');
      await vi.advanceTimersByTimeAsync(2000);
      ac.abort(new DOMException('Upload cancelled', 'AbortError'));

      await outcome;
      expect(calls).toEqual(['init', 'chunk 0', 'abort']);
    });
  });
});
