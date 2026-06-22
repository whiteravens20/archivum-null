import { buildApp } from './app.js';
import { config } from './config.js';
import { vaultManager } from './vault/manager.js';

async function main(): Promise<void> {
  const app = await buildApp();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down...`);
    await vaultManager.shutdown();
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start
  try {
    await app.listen({
      host: config.BIND_ADDRESS,
      port: config.PORT,
    });
    app.log.info(`Archivum Null running on ${config.BIND_ADDRESS}:${config.PORT}`);
  } catch (err) {
    app.log.fatal(err);
    process.exit(1);
  }
}

main();
