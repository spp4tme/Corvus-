// Ce que l'agent d'un hôte sait faire (calculé par le serveur : `agent.support`). Sans agent connu, rien n'est grisé.
import { state } from '../state.js';

/** `feat(hostId)('restore')` → { ok, reason } : `reason` explique pourquoi la fonction est indisponible. */
export const agentFeature = (hostId) => (f) => state.host(hostId)?.agent?.support?.[f] || { ok: true, reason: null };
