// Routes des modules fonctionnels.
import { Router } from 'express';
import { SftpService } from '../lib/sftp.js';
import { GitService } from '../lib/git.js';
import { MonitorService } from '../lib/monitor.js';
import { ProxyService } from '../lib/proxy.js';
import { PushService } from '../lib/push.js';
import { fileRoutes } from './files.js';
import { gitRoutes } from './git.js';
import { monitorRoutes } from './monitor.js';
import { serviceRoutes } from './services.js';

/** Services instanciés avant le montage des routes (le proxy est monté hors /api). */
export function createServices(ctx) {
  ctx.sftp = new SftpService(ctx);
  ctx.git = new GitService(ctx);
  ctx.monitor = new MonitorService(ctx);
  ctx.proxy = new ProxyService({ dataDir: ctx.config.dataDir, journal: ctx.journal, config: ctx.config });
  ctx.push = new PushService({ dataDir: ctx.config.dataDir, config: ctx.config, journal: ctx.journal });
  ctx.notify = (n) => {
    ctx.journal.add({ type: 'terminal', event: 'notify', host: ctx.hosts.hosts.find((h) => h.id === n.hostId), detail: `${n.title} : ${n.body}` });
    ctx.push.notify(n).catch(() => {});
  };
}

export function extraRoutes(ctx) {
  const r = Router();
  r.use(fileRoutes(ctx));
  r.use(gitRoutes(ctx));
  r.use(monitorRoutes(ctx));
  r.use(serviceRoutes(ctx));
  return r;
}
