import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { logServer } from './logger';

export function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

export function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : (value ?? '');
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: 'Validation error', details: error.issues });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  logServer('error', 'Request failed', { message });
  res.status(500).json({ error: message });
}
