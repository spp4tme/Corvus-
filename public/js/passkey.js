// Passkeys côté navigateur : conversion base64url ↔ ArrayBuffer autour de navigator.credentials.
import { post } from './api.js';

const toBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0)).buffer;
const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const passkeysSupported = () => !!window.PublicKeyCredential && window.isSecureContext;

/** Ajoute une passkey au compte connecté. */
export async function registerPasskey(name) {
  const { challengeId, publicKey } = await post('/api/me/passkeys/options');
  const cred = await navigator.credentials.create({
    publicKey: {
      ...publicKey,
      challenge: toBuf(publicKey.challenge),
      user: { ...publicKey.user, id: toBuf(publicKey.user.id) },
      excludeCredentials: publicKey.excludeCredentials.map((c) => ({ ...c, id: toBuf(c.id) })),
    },
  });
  return post('/api/me/passkeys', {
    challengeId, name,
    credential: {
      id: cred.id, type: cred.type,
      response: { clientDataJSON: toB64u(cred.response.clientDataJSON), attestationObject: toB64u(cred.response.attestationObject) },
    },
  });
}

/** Connexion sans mot de passe (passkey « découvrable » : pas besoin de saisir l'identifiant). */
export async function loginWithPasskey() {
  const { challengeId, publicKey } = await post('/api/auth/passkey/options');
  const cred = await navigator.credentials.get({ publicKey: { ...publicKey, challenge: toBuf(publicKey.challenge) } });
  return post('/api/auth/passkey/login', {
    challengeId,
    credential: {
      id: cred.id, type: cred.type,
      response: {
        clientDataJSON: toB64u(cred.response.clientDataJSON),
        authenticatorData: toB64u(cred.response.authenticatorData),
        signature: toB64u(cred.response.signature),
        userHandle: cred.response.userHandle ? toB64u(cred.response.userHandle) : null,
      },
    },
  });
}
