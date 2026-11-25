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
import { claudeRoutes } from './claude.js';
import { systemRoutes } from './system.js';
import { terminalRoutes } from './terminals.js';
import { agentRoutes } from './agents.js';
import { rewindRoutes } from './rewind.js';
import { previewRoutes } from './preview.js';
import { xrayRoutes } from './xray.js';
import { Rewind } from '../lib/rewind.js';
import { productivityRoutes } from './productivity.js';
import { hostAdminRoutes } from './hostadmin.js';
import { HostAdmin } from '../lib/hostadmin.js';
import { UndoService } from '../lib/undo.js';
import { HostStatus } from '../lib/hoststatus.js';
import { MetricsCollector } from '../lib/metrics.js';

/** Services instanciés avant le montage des routes (le proxy est monté hors /api). */
export function createServices(ctx) {
  ctx.sftp = new SftpService(ctx);
  ctx.git = new GitService(ctx);
  ctx.monitor = new MonitorService(ctx);
  ctx.hostAdmin = new HostAdmin({ pool: ctx.pool, hosts: ctx.hosts, journal: ctx.journal });
  ctx.undo = new UndoService({ db: ctx.db, pool: ctx.pool, blobs: ctx.blobs, journal: ctx.journal, hosts: ctx.hosts });
  ctx.hostStatus = new HostStatus({ db: ctx.db, hosts: ctx.hosts, pool: ctx.pool, alerts: ctx.alerts, intervalSec: ctx.config.hostProbeSec || 60, downAlertMin: ctx.config.hostDownAlertMin });
  ctx.metrics = new MetricsCollector({ db: ctx.db, hosts: ctx.hosts, monitor: ctx.monitor, hostStatus: ctx.hostStatus, intervalSec: ctx.config.metricsIntervalSec || 30 });
  ctx.proxy = new ProxyService({ db: ctx.db, journal: ctx.journal, config: ctx.config });
  ctx.push = new PushService({ db: ctx.db, vault: ctx.vault, config: ctx.config, journal: ctx.journal });
  // Alertes : aux administrateurs, et aux comptes qui ont accès à l'hôte concerné.
  ctx.push.audience = (userId, hostId) => {
    const u = userId && ctx.users.row(userId);
    if (!u || u.disabled) return false;
    if (u.role === 'admin') return true;
    const host = hostId && ctx.hosts.find(hostId);
    return !!host && !!ctx.users.hostRole(u, host);
  };
  ctx.notify = (n) => {
    ctx.journal.add({ type: 'terminal', event: 'notify', host: n.hostId ? ctx.hosts.find(n.hostId) : undefined, user: n.owner || null, ip: null, detail: `${n.title} : ${n.body}` });
    // Notification d'un terminal : seulement aux appareils de son propriétaire.
    ctx.push.notify(n, n.owner ? { userIds: [n.owner.id] } : undefined).catch(() => {});
  };
}

export function extraRoutes(ctx) {
  const r = Router();
  r.use(fileRoutes(ctx));
  r.use(gitRoutes(ctx));
  r.use(monitorRoutes(ctx));
  r.use(serviceRoutes(ctx));
  r.use(claudeRoutes(ctx));
  r.use(systemRoutes(ctx));
  r.use(terminalRoutes(ctx));
  r.use(agentRoutes(ctx));
  ctx.rewind = new Rewind(ctx);
  r.use(rewindRoutes(ctx));
  r.use(previewRoutes(ctx));
  r.use(xrayRoutes(ctx));
  r.use(productivityRoutes(ctx));
  r.use(hostAdminRoutes(ctx));
  return r;
}
