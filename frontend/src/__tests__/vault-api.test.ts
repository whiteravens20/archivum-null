/**
 * API vault client — unit tests.
 *
 * Verifies uploadVault, getVaultInfo, downloadVault with mocked fetch/XHR.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
      const instance: Record<string, unknown> = {
        open: vi.fn(),
        setRequestHeader: vi.fn(),
        send: vi.fn(),
        upload: {},
        status: 201,
        responseText: '{}',
        onload: null,
        onerror: null,
        ...overrides,
      };
      // Must be a real function (not arrow) so `new` works
      const Ctor = function (this: Record<string, unknown>) {
        Object.assign(this, instance);
        // Expose the live instance so caller can trigger onload/onerror
        Ctor._instance = this;
      } as unknown as { new (): typeof instance; _instance: Record<string, unknown> };
      Ctor._instance = instance;
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
      const blob = new Blob(['data']);
      const promise = uploadVault(blob, 3600, 5, 'token123');

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
      const blob = new Blob(['data']);
      const promise = uploadVault(blob, 3600, 5);

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
      const blob = new Blob(['data']);
      const promise = uploadVault(blob, 3600, 5);

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
      const blob = new Blob(['data']);
      const promise = uploadVault(blob, 3600, 5, undefined, onProgress);

      const inst = XhrCtor._instance;
      const upload = inst.upload as { onprogress: (e: unknown) => void };
      upload.onprogress({ lengthComputable: true, loaded: 50, total: 100 });
      expect(onProgress).toHaveBeenCalledWith(0.5);

      (inst.onload as () => void)();
      await promise;
    });
  });
});
