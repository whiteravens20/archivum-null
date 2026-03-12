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
  });
});
