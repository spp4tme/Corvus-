// Routes des modules fonctionnels.
import { Router } from 'express';
import { SftpService } from '../lib/sftp.js';
import { fileRoutes } from './files.js';

export function extraRoutes(ctx) {
  ctx.sftp = new SftpService(ctx);
  const r = Router();
  r.use(fileRoutes(ctx));
  return r;
}
