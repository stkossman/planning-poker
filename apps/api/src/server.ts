import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';

const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
const app = await buildApp({
  databasePath: process.env.DATABASE_PATH ?? fileURLToPath(new URL('../../../data/planning-poker.sqlite', import.meta.url)),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  secureCookies: process.env.NODE_ENV === 'production',
  webRoot: existsSync(webRoot) ? webRoot : undefined,
});
try {
  const address = await app.listen({ port: Number(process.env.PORT ?? 3001), host: process.env.HOST ?? '127.0.0.1' });
  console.log(`Planning Poker API listening at ${address}`);
} catch (error) {
  console.error(error);
  await app.close();
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => { await app.close(); });
}
