import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { vaultManager } from '../vault/manager.js';
import { basicAuth } from '../middleware/basicAuth.js';

interface VaultParams {
  vaultId: string;
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // All admin routes require basic auth
  app.addHook('onRequest', basicAuth);

  // Dashboard stats
  app.get('/api/admin/stats', async (_request: FastifyRequest, reply: FastifyReply) => {
    const stats = vaultManager.getStats();
    return reply.send({
      totalVaults: stats.totalVaults,
      activeVaults: stats.activeVaults,
      totalStorageBytes: stats.totalStorageBytes,
      totalStorageMB: Math.round(stats.totalStorageBytes / 1024 / 1024 * 100) / 100,
    });
  });

  // List vault metadata (never exposes keys or plaintext)
  app.get('/api/admin/vaults', async (_request: FastifyRequest, reply: FastifyReply) => {
    const vaults = vaultManager.listVaults();
    return reply.send(
      vaults.map((v) => ({
        vaultId: v.vaultId,
        ciphertextSize: v.ciphertextSize,
        originalName: v.originalName,
        createdAt: v.createdAt,
        expiresAt: v.expiresAt,
        remainingDownloads: v.remainingDownloads,
        maxDownloads: v.maxDownloads,
      }))
    );
  });

  // Force delete a vault
  app.delete<{ Params: VaultParams }>('/api/admin/vaults/:vaultId', async (request, reply) => {
    const { vaultId } = request.params;
    const deleted = await vaultManager.deleteVault(vaultId);
    if (!deleted) {
      return reply.status(404).send({ error: 'Vault not found' });
    }
    return reply.send({ deleted: true, vaultId });
  });
}
