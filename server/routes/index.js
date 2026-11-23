// Routes des modules fonctionnels.
import { Router } from 'express';
import { SftpService } from '../lib/sftp.js';
import { GitService } from '../lib/git.js';
import { MonitorService } from '../lib/monitor.js';
import { fileRoutes } from './files.js';
import { gitRoutes } from './git.js';
import { monitorRoutes } from './monitor.js';

export function extraRoutes(ctx) {
  ctx.sftp = new SftpService(ctx);
  ctx.git = new GitService(ctx);
  ctx.monitor = new MonitorService(ctx);
  const r = Router();
  r.use(fileRoutes(ctx));
  r.use(gitRoutes(ctx));
  r.use(monitorRoutes(ctx));
  return r;
}
