/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Health Endpoint
 */

import { Router, Request, Response } from 'express';
import { BUSINESS_TIMEZONE } from '../../src/types/index.ts';

const router = Router();

router.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    timezone: BUSINESS_TIMEZONE,
    service: 'Galon Salon API',
  });
});

export default router;
