// Web Push : Apple (web.push.apple.com) refuse en 403 un jeton VAPID dont le contact (« sub ») est en « localhost »
// (constaté sur le Pi avec un iPhone, point E). Le contact par défaut doit avoir un vrai nom de domaine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../server/config.js';

test('contact VAPID par défaut : mailto: avec un domaine, pas localhost', () => {
  const subject = config.vapidSubject;
  assert.match(subject, /^mailto:[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i);
  assert.ok(!/localhost/i.test(subject), subject);
});
