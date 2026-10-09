import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { createApp } from './app/api';
import { Repository } from './storage/repository';

if (existsSync('.env')) process.loadEnvFile('.env');
const repository = new Repository();
repository.seed();
const app = createApp(repository);

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(resolve('dist/web')));
  app.use((_req, res) => res.sendFile(resolve('dist/web/index.html')));
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'custom' });
  app.use(vite.middlewares);
  app.use(async (req, res, next) => {
    try {
      const html = await vite.transformIndexHtml(req.originalUrl, readFileSync('src/web/index.html', 'utf8'));
      res.type('html').send(html);
    } catch (error) { next(error); }
  });
}

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, '127.0.0.1', () => console.log(`Industrial Pi demo: http://127.0.0.1:${port}`));
function shutdown() { server.close(); repository.close(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
