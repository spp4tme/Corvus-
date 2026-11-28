// Playbooks, étape 6 : parseur cron pur, fuseaux, heure d'été / d'hiver, fenêtres de maintenance.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, nextRun, checkTimeZone, localParts, zonedToUtc, parseWindow, inWindow, CronError } from '../server/lib/automation/cron.js';

const utc = (s) => Date.parse(s);
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const next = (expr, after, tz = 'UTC') => iso(nextRun(parseCron(expr), utc(after), tz));
const bad = (expr, re) => assert.throws(() => parseCron(expr), (e) => e instanceof CronError && (!re || re.test(e.message)), String(expr));

describe('syntaxe', () => {
  test('champs simples, plages, pas, listes, noms, dimanche = 0 ou 7', () => {
    const c = parseCron('*/15 9-17 1,15 JAN-MAR mon-fri');
    assert.deepEqual([...c.minute], [0, 15, 30, 45]);
    assert.deepEqual([...c.hour], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
    assert.deepEqual([...c.dom], [1, 15]);
    assert.deepEqual([...c.month], [1, 2, 3]);
    assert.deepEqual([...c.dow], [1, 2, 3, 4, 5]);
    assert.deepEqual([...parseCron('0 0 * * 7').dow], [0]);
    assert.deepEqual([...parseCron('0 0 * * SUN,sat').dow].sort(), [0, 6]);
    assert.deepEqual([...parseCron('10-50/20 * * * *').minute], [10, 30, 50]);
    assert.deepEqual([...parseCron('5/20 * * * *').minute], [5, 25, 45]);
  });

  test('raccourcis', () => {
    assert.equal(parseCron('@daily').source, '0 0 * * *');
    assert.equal(parseCron('@HOURLY').source, '0 * * * *');
    assert.equal(parseCron('@weekly').source, '0 0 * * 0');
  });

  test('syntaxes refusées (jamais ignorées en silence)', () => {
    for (const e of [
      '', '   ', '* * * *', '* * * * * *', '0 0 0 * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * 32 * *', '* * * 0 *', '* * * 13 *', '* * * * 8',
      '5-1 * * * *', '*/0 * * * *', '*/-1 * * * *', '*/x * * * *', '? * * * *', 'L * * * *', '1W * * * *', '1#2 * * * *', '1,,2 * * * *', ',1 * * * *',
      '1-2-3 * * * *', '- * * * *', '*/5/2 * * * *', '* * * FOO *', '* * * * FRI-MON', '@reboot', '@every 5m', '*/1000 * * * *',
      '0 0 * * *;rm -rf /', '0 0 * * *\n0 1 * * *', 'x'.repeat(200), '0 0 * * * # commentaire', 42, null, undefined, {},
    ]) bad(e);
    bad('x'.repeat(200), /trop longue/);
    bad('* * * *', /5 champs/);
  });
});

describe('prochain déclenchement (UTC)', () => {
  test('simple, toujours STRICTEMENT dans le futur', () => {
    assert.equal(next('30 14 * * *', '2026-06-10T12:00:00Z'), '2026-06-10T14:30:00Z');
    assert.equal(next('30 14 * * *', '2026-06-10T14:30:00Z'), '2026-06-11T14:30:00Z', 'pile à l\'heure : le suivant');
    assert.equal(next('30 14 * * *', '2026-06-10T14:29:59Z'), '2026-06-10T14:30:00Z');
    assert.equal(next('* * * * *', '2026-06-10T12:00:30Z'), '2026-06-10T12:01:00Z');
  });

  test('pas, listes, jours de semaine, mois', () => {
    assert.equal(next('*/15 * * * *', '2026-06-10T12:07:00Z'), '2026-06-10T12:15:00Z');
    assert.equal(next('0 9 * * 1-5', '2026-06-12T10:00:00Z'), '2026-06-15T09:00:00Z', 'vendredi 10 h → lundi');
    assert.equal(next('0 0 1 */3 *', '2026-02-01T00:00:00Z'), '2026-04-01T00:00:00Z');
    assert.equal(next('0 12 * JUN,DEC *', '2026-07-01T00:00:00Z'), '2026-12-01T12:00:00Z');
  });

  test('jour du mois ET jour de semaine restreints : l\'un OU l\'autre (comme cron)', () => {
    // le 13 OU un vendredi
    assert.equal(next('0 0 13 * 5', '2026-06-01T00:00:00Z'), '2026-06-05T00:00:00Z', 'premier vendredi');
    assert.equal(next('0 0 13 * 5', '2026-06-12T00:00:01Z'), '2026-06-13T00:00:00Z', 'le 13 (un samedi)');
  });

  test('le 31 saute les mois courts ; le 29 février trouve la prochaine année bissextile', () => {
    assert.equal(next('0 0 31 * *', '2026-04-01T00:00:00Z'), '2026-05-31T00:00:00Z');
    assert.equal(next('0 0 29 2 *', '2026-03-01T00:00:00Z'), '2028-02-29T00:00:00Z');
    assert.equal(nextRun(parseCron('0 0 30 2 *'), utc('2026-01-01T00:00:00Z'), 'UTC'), null, 'le 30 février n\'existe jamais');
  });

  test('changements d\'année et de mois', () => {
    assert.equal(next('59 23 31 12 *', '2026-12-31T23:59:00Z'), '2027-12-31T23:59:00Z');
    assert.equal(next('0 0 * * *', '2026-12-31T23:59:59Z'), '2027-01-01T00:00:00Z');
  });
});

describe('fuseaux et heure d\'été / d\'hiver (Europe/Paris, America/New_York)', () => {
  const PARIS = 'Europe/Paris';

  test('fuseau explicite : l\'heure locale compte, pas l\'UTC', () => {
    // 09:00 à Paris en juin (UTC+2) = 07:00Z ; en janvier (UTC+1) = 08:00Z
    assert.equal(next('0 9 * * *', '2026-06-10T00:00:00Z', PARIS), '2026-06-10T07:00:00Z');
    assert.equal(next('0 9 * * *', '2026-01-10T00:00:00Z', PARIS), '2026-01-10T08:00:00Z');
    assert.equal(next('0 9 * * *', '2026-06-10T00:00:00Z', 'America/New_York'), '2026-06-10T13:00:00Z');
  });

  test('PASSAGE À L\'HEURE D\'ÉTÉ (Paris, 29 mars 2026, 02:00 → 03:00) : 02:30 n\'existe pas ce jour-là, il est SAUTÉ', () => {
    // 28 mars 02:30 CET = 01:30Z ; le 29 n'existe pas ; le 30 : 02:30 CEST = 00:30Z
    assert.equal(next('30 2 * * *', '2026-03-28T01:30:00Z', PARIS), '2026-03-30T00:30:00Z');
    assert.equal(zonedToUtc(2026, 3, 29, 2, 30, PARIS), null, 'cette heure locale n\'existe pas');
    // un horaire qui existe reste exact avant et après
    assert.equal(next('30 3 * * *', '2026-03-28T05:00:00Z', PARIS), '2026-03-29T01:30:00Z', '03:30 CEST = 01:30Z');
    assert.equal(next('0 1 * * *', '2026-03-28T23:00:00Z', PARIS), '2026-03-29T00:00:00Z', '01:00 CET existe encore ce jour-là');
  });

  test('RETOUR À L\'HEURE D\'HIVER (Paris, 25 octobre 2026, 03:00 → 02:00) : 02:30 existe deux fois, il ne déclenche QU\'UNE fois', () => {
    // première occurrence 02:30 CEST = 00:30Z ; seconde 02:30 CET = 01:30Z (jamais retournée)
    assert.equal(next('30 2 * * *', '2026-10-24T01:00:00Z', PARIS), '2026-10-25T00:30:00Z', 'première occurrence');
    assert.equal(next('30 2 * * *', '2026-10-25T00:30:00Z', PARIS), '2026-10-26T01:30:00Z', 'pas de seconde occurrence : on saute au lendemain (02:30 CET)');
  });

  test('New York : passage à l\'heure d\'été le 8 mars 2026 (02:00 → 03:00)', () => {
    assert.equal(next('30 2 * * *', '2026-03-07T07:30:00Z', 'America/New_York'), '2026-03-09T06:30:00Z', '8 mars sauté ; 9 mars 02:30 EDT = 06:30Z');
  });

  test('autour des deux transitions de Paris : toujours croissant, jamais deux fois le même instant, jamais dans le passé', () => {
    for (const from of ['2026-03-27T00:00:00Z', '2026-10-23T00:00:00Z']) {
      const c = parseCron('*/30 * * * *');
      let t = utc(from);
      const seen = new Set();
      for (let i = 0; i < 400; i++) { // ~ 8 jours en pas de 30 minutes
        const n = nextRun(c, t, PARIS);
        assert.ok(n > t, `pas dans le futur à ${iso(t)}`);
        assert.ok(!seen.has(n), `instant répété ${iso(n)}`);
        seen.add(n); t = n;
      }
    }
  });

  test('HORAIRE : une heure locale répétée par le retour à l\'heure d\'hiver ne déclenche qu\'UNE fois (choix documenté)', () => {
    // 25 octobre 2026 : 02:00 locale arrive à 00:00Z (CEST) puis à 01:00Z (CET). On ne garde que la première.
    const c = parseCron('0 * * * *');
    assert.equal(iso(nextRun(c, utc('2026-10-24T23:30:00Z'), PARIS)), '2026-10-25T00:00:00Z');
    assert.equal(iso(nextRun(c, utc('2026-10-25T00:00:00Z'), PARIS)), '2026-10-25T02:00:00Z', '02:00 CET (01:00Z) n\'est pas redéclenchée ; 03:00 CET = 02:00Z');
  });

  test('heures locales : localParts et zonedToUtc se répondent', () => {
    const l = localParts(utc('2026-06-10T07:00:00Z'), PARIS);
    assert.deepEqual([l.hour, l.minute, l.dow], [9, 0, 3]);
    assert.equal(iso(zonedToUtc(2026, 6, 10, 9, 0, PARIS)), '2026-06-10T07:00:00Z');
    assert.equal(iso(zonedToUtc(2026, 10, 25, 2, 30, PARIS)), '2026-10-25T00:30:00Z', 'heure répétée : la première');
  });

  test('fuseaux invalides refusés', () => {
    for (const tz of ['', 'Paris', 'Europe/Parisss', 'x'.repeat(80), 'Europe/Paris; rm', '../etc', null, undefined, 42, 'UTC+25']) {
      assert.throws(() => checkTimeZone(tz), CronError, String(tz));
    }
    assert.equal(checkTimeZone('UTC'), 'UTC');
    assert.equal(checkTimeZone('Europe/Paris'), 'Europe/Paris');
  });
});

describe('fenêtres de maintenance', () => {
  test('fenêtre simple', () => {
    const w = parseWindow({ from: '02:00', to: '04:00' });
    assert.equal(inWindow(w, utc('2026-06-10T01:59:00Z'), 'UTC'), false);
    assert.equal(inWindow(w, utc('2026-06-10T02:00:00Z'), 'UTC'), true);
    assert.equal(inWindow(w, utc('2026-06-10T03:59:00Z'), 'UTC'), true);
    assert.equal(inWindow(w, utc('2026-06-10T04:00:00Z'), 'UTC'), false);
  });

  test('fenêtre qui passe minuit, jours = jour de DÉBUT', () => {
    const w = parseWindow({ from: '22:00', to: '02:00', days: [5] }); // vendredi soir → samedi matin
    assert.equal(inWindow(w, utc('2026-06-12T23:00:00Z'), 'UTC'), true, 'vendredi 23 h');
    assert.equal(inWindow(w, utc('2026-06-13T01:00:00Z'), 'UTC'), true, 'samedi 1 h (la fenêtre a commencé vendredi)');
    assert.equal(inWindow(w, utc('2026-06-13T23:00:00Z'), 'UTC'), false, 'samedi 23 h : pas un jour de début');
    assert.equal(inWindow(w, utc('2026-06-14T01:00:00Z'), 'UTC'), false);
  });

  test('évaluée dans le fuseau', () => {
    const w = parseWindow({ from: '02:00', to: '04:00' });
    assert.equal(inWindow(w, utc('2026-06-10T00:30:00Z'), 'Europe/Paris'), true, '02:30 à Paris');
    assert.equal(inWindow(w, utc('2026-06-10T02:30:00Z'), 'Europe/Paris'), false, '04:30 à Paris');
  });

  test('aucune fenêtre = toujours dedans ; fenêtres invalides refusées', () => {
    assert.equal(inWindow(null, Date.now(), 'UTC'), true);
    assert.equal(parseWindow(undefined), null);
    for (const w of ['x', [], { from: '2:00', to: '4:00' }, { from: '25:00', to: '01:00' }, { from: '02:00', to: '02:00' }, { from: '02:00' }, { from: '02:00', to: '04:00', days: [7] },
      { from: '02:00', to: '04:00', days: [] }, { from: '02:00', to: '04:00', days: 'lundi' }, { from: '02:00', to: '04:00', extra: 1 }]) {
      assert.throws(() => parseWindow(w), CronError, JSON.stringify(w));
    }
  });
});
