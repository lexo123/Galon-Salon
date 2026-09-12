/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Main Server Entry Point (Express + Vite)
 */

import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { createExpressApp } from './server/app.ts';
import { errorHandler } from './server/utils/errors.ts';
import { logger } from './server/utils/logger.ts';

const PORT = 3000;
const HOST = '0.0.0.0';

async function startServer() {
  const app = createExpressApp();

  // API error handling middleware
  app.use('/api', errorHandler);

  // Vite integration: Middleware mode in development, static files in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    logger.info('Vite dev middleware attached');
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
    logger.info(`Serving static production files from ${distPath}`);
  }

  // Global fallback error handler
  app.use(errorHandler);

  const server = app.listen(PORT, HOST, () => {
    logger.info(`Galon Salon server running at http://${HOST}:${PORT}`);
  });

  // Graceful shutdown handling
  const handleShutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    server.close(() => {
      logger.info('HTTP server closed.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}

startServer().catch((err) => {
  logger.error('Failed to start server', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
