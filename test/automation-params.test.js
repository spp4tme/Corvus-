// Playbooks, étape 2 : paramètres typés, injection échappée, secrets et masquage. Modules PURS (server/lib/automation/params.js, mask.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateDefs, coerceValues, scanTemplate, render, quote, PlaybookError } from '../server/lib/automation/params.js';
import { createMasker, checkSecretValue, MASK } from '../server/lib/automation/mask.js';
import { findBash } from './helpers/fake-sshd.js';

const refuse = (fn, re) => assert.throws(fn, (e) => e instanceof PlaybookError && (!re || re.test(e.message)), String(re));

describe('définitions de paramètres', () => {
  test('types valides, valeurs par défaut vérifiées', () => {
    const d = validateDefs([
      { name: 'service', type: 'choice', choices: ['nginx', 'ssh'], default: 'nginx' },
      { name: 'port', type: 'int', min: 1, max: 65535 },
      { name: 'message', type: 'string', max: 40, required: false },
      { name: 'dossier', type: 'path' },
      { name: 'cible', type: 'host' },
    ]);
    assert.equal(d.length, 5);
    assert.equal(d[0].default, 'nginx');
  });

  test('définitions hostiles refusées', () => {
    for (const bad of [
      'texte', [null], [{ name: '1x', type: 'string' }], [{ name: 'a b', type: 'string' }], [{ name: 'x'.repeat(40), type: 'string' }],
      [{ name: 'a', type: 'bidon' }], [{ name: 'a', type: 'string' }, { name: 'A', type: 'int' }], [{ name: 'a', type: 'choice', choices: [] }],
      [{ name: 'a', type: 'choice', choices: ['x', 'x'] }], [{ name: 'a', type: 'int', min: 5, max: 1 }], [{ name: 'a', type: 'string', max: 99999 }],
      [{ name: 'a', type: 'choice', choices: ['ok'], default: 'autre' }], [{ name: 'a', type: 'string', label: 'x\ny' }],
      Array.from({ length: 21 }, (_, i) => ({ name: `p${i}`, type: 'string' })),
    ]) refuse(() => validateDefs(bad));
  });
});

describe('valeurs fournies', () => {
  const defs = validateDefs([
    { name: 'service', type: 'choice', choices: ['nginx', 'ssh'] },
    { name: 'port', type: 'int', min: 1, max: 65535 },
    { name: 'note', type: 'string', max: 20, required: false },
    { name: 'dossier', type: 'path', required: false },
    { name: 'cible', type: 'host', required: false },
  ]);

  test('valeurs correctes, entier reçu en texte accepté', () => {
    assert.deepEqual(coerceValues(defs, { service: 'ssh', port: '8080', note: 'bonjour' }), { service: 'ssh', port: 8080, note: 'bonjour' });
  });

  test('manquant, inconnu, hors liste, hors bornes, mauvais type', () => {
    refuse(() => coerceValues(defs, {}), /requis/);
    refuse(() => coerceValues(defs, { service: 'ssh', port: 1, extra: 'x' }), /inconnu/);
    refuse(() => coerceValues(defs, { service: 'apache', port: 1 }), /liste/);
    refuse(() => coerceValues(defs, { service: 'ssh', port: 0 }), /entier/);
    refuse(() => coerceValues(defs, { service: 'ssh', port: 70000 }), /entier/);
    refuse(() => coerceValues(defs, { service: 'ssh', port: 1.5 }), /entier/);
    refuse(() => coerceValues(defs, { service: 'ssh', port: '1e3' }), /entier/);
    refuse(() => coerceValues(defs, { service: 'ssh', port: 1, note: 42 }), /chaîne/);
    refuse(() => coerceValues(defs, { service: ['ssh'], port: 1 }), /liste/);
    refuse(() => coerceValues(defs, 'x'), /objet/);
  });

  test('chaînes : longueur, caractères de contrôle, retours à la ligne, NUL', () => {
    for (const note of ['x'.repeat(21), 'a\nb', 'a\rb', 'a\u0000b', 'a\u001bb', 'a\tb', 'a\u007fb']) refuse(() => coerceValues(defs, { service: 'ssh', port: 1, note }), /caractères|maximum/);
  });

  test('chemins : absolus, sans « .. », sans NUL ni retour à la ligne', () => {
    assert.equal(coerceValues(defs, { service: 'ssh', port: 1, dossier: '/var/log' }).dossier, '/var/log');
    assert.equal(coerceValues(defs, { service: 'ssh', port: 1, dossier: '~/projets' }).dossier, '~/projets');
    for (const dossier of ['relatif', '../etc', '/a/../b', '/a/..', '/a\nb', '/a\u0000b', '~x', '-rf']) refuse(() => coerceValues(defs, { service: 'ssh', port: 1, dossier }));
  });

  test('hôte : seulement ceux que le playbook autorise (casse comprise)', () => {
    const ok = 'aabbccdd11223344';
    assert.equal(coerceValues(defs, { service: 'ssh', port: 1, cible: ok }, { hostIds: [ok] }).cible, ok);
    refuse(() => coerceValues(defs, { service: 'ssh', port: 1, cible: 'ffffffff11223344' }, { hostIds: [ok] }), /non autorisé/);
    refuse(() => coerceValues(defs, { service: 'ssh', port: 1, cible: '; rm -rf /' }, { hostIds: [ok] }), /invalide/);
  });

  test('noms de paramètres insensibles à la casse (« PORT » = « port ») sans créer de doublon', () => {
    assert.equal(coerceValues(defs, { SERVICE: 'ssh', Port: 5 }).port, 5);
  });
});

describe('modèles de commande : contextes refusés', () => {
  const allowed = ['x', 'y'];
  const ok = (t) => scanTemplate(t, { allowedParams: allowed });
  test('mots nus acceptés, y compris dans $( ) et avec des opérateurs', () => {
    assert.deepEqual(ok('echo {{x}}').params, ['x']);
    assert.deepEqual(ok('systemctl restart {{x}} && echo {{y}}').params.sort(), ['x', 'y']);
    assert.deepEqual(ok('echo "$(cat {{x}})"').params, ['x'], 'contexte neuf dans $( ) même au milieu de guillemets doubles');
    assert.deepEqual(ok('echo hi; ls {{x}} | wc -l').params, ['x']);
    assert.deepEqual(ok('echo ne-fait-rien').params, []);
  });

  test('paramètre entre guillemets simples ou doubles, backtick, commentaire : REFUSÉ', () => {
    for (const t of ["echo '{{x}}'", 'echo "{{x}}"', 'echo `cat {{x}}`', 'echo salut # {{x}}', "echo 'a' '{{x}}'", 'echo "a $(b) {{x}}"', 'echo "x"{{x}}"y"']) {
      if (t === 'echo "x"{{x}}"y"') { assert.deepEqual(ok(t).params, ['x'], 'entre deux chaînes closes : mot nu'); continue; }
      refuse(() => ok(t), /quotes|backtick|commentaire/);
    }
  });

  test('heredoc avec paramètre : refusé (le texte y serait réinterprété)', () => {
    refuse(() => ok('cat <<EOF\n{{x}}\nEOF'), /heredoc/);
    refuse(() => ok("cat <<'EOF'\n{{x}}\nEOF"), /heredoc/);
    refuse(() => ok('cat <<-EOF\n{{x}}\nEOF'), /heredoc/);
  });

  test('paramètre non déclaré, nom invalide, marqueur cassé', () => {
    refuse(() => ok('echo {{inconnu}}'), /non déclaré/);
    refuse(() => ok('echo {{a-b}}'), /marqueur|invalide|mal placé/);
  });

  test('NUL refusé, valeur non textuelle refusée', () => {
    refuse(() => scanTemplate('echo \u0000', {}), /NUL/);
    refuse(() => scanTemplate(42, {}), /texte/);
  });

  test('secrets : acceptés nus et entre guillemets doubles, refusés entre quotes simples / backtick / commentaire', () => {
    assert.deepEqual(scanTemplate('curl -u u:{{secret.TOKEN}} x', {}).secrets, ['TOKEN']);
    assert.deepEqual(scanTemplate('echo "pass={{secret.DB_PASS}}"', {}).secrets, ['DB_PASS']);
    for (const t of ["echo '{{secret.TOKEN}}'", 'echo `{{secret.TOKEN}}`', 'echo # {{secret.TOKEN}}']) refuse(() => scanTemplate(t, {}), /quotes simples|backtick|commentaire/);
    for (const n of ['token', 'A', '1TOKEN', 'TOK-EN', 'T'.repeat(40)]) refuse(() => scanTemplate(`echo {{secret.${n}}}`, {}), /secret|marqueur/);
  });
});

describe('rendu : valeur entre quotes ; secret par référence', () => {
  const defs = validateDefs([{ name: 'x', type: 'string', max: 200 }, { name: 'n', type: 'int' }]);
  test('rendu simple', () => {
    assert.equal(render('echo {{x}} {{n}}', defs, { x: "l'été", n: 5 }), "echo 'l'\\''été' '5'");
  });
  test('secret : jamais sa valeur, seulement la variable d\'environnement', () => {
    assert.equal(render('curl -H {{secret.TOKEN}}', defs, {}), 'curl -H "${CORVUS_SECRET_TOKEN}"');
    assert.equal(render('echo "t={{secret.TOKEN}}"', defs, {}), 'echo "t=${CORVUS_SECRET_TOKEN}"');
  });
  test('quote : NUL refusé', () => { refuse(() => quote('a\u0000b'), /NUL/); });
});

describe('INJECTION RÉELLE : le texte rendu est exécuté dans un vrai shell avec des valeurs hostiles', () => {
  const { bash } = findBash();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corvus-inject-'));
  const canari = path.join(dir, 'PWNED');
  const defs = validateDefs([{ name: 'x', type: 'string', max: 400 }]);
  const toBash = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);
  const run = (script) => execFileSync(bash, ['-c', script], { encoding: 'utf8', timeout: 20_000 });

  const hostiles = [
    `'; touch ${toBash(canari)}; '`, `"; touch ${toBash(canari)}; "`, `$(touch ${toBash(canari)})`, '`touch ' + toBash(canari) + '`',
    `a'b"c\`d$e\\f`, `x; touch ${toBash(canari)} #`, `| touch ${toBash(canari)}`, `&& touch ${toBash(canari)}`,
    `$IFS$(touch ${toBash(canari)})`, `\\'; touch ${toBash(canari)}; \\'`, `-n`, `--help`, '*', '~', '${HOME}', '$((1+1))', '!!', 'é ü ñ 漢字',
  ];

  test('printf : la valeur ressort à l\'identique et aucune commande injectée ne tourne', () => {
    const tpl = 'printf %s {{x}}';
    scanTemplate(tpl, { allowedParams: ['x'] });
    for (const v of hostiles) {
      const out = run(render(tpl, defs, { x: v }));
      assert.equal(out, v, `valeur altérée : ${JSON.stringify(v)}`);
      assert.equal(fs.existsSync(canari), false, `INJECTION avec ${JSON.stringify(v)}`);
    }
  });

  test('dans un $( ) imbriqué comme dans un pipeline', () => {
    const tpl = 'printf "%s\\n" "$(printf %s {{x}})" | cat';
    scanTemplate(tpl, { allowedParams: ['x'] });
    for (const v of hostiles) {
      const out = run(render(tpl, defs, { x: v })).replace(/\n$/, '');
      assert.equal(out, v, JSON.stringify(v));
      assert.equal(fs.existsSync(canari), false, `INJECTION avec ${JSON.stringify(v)}`);
    }
  });

  test('un paramètre entre quotes est refusé AVANT tout rendu (le texte rendu serait faux, et d\'autres valeurs pourraient s\'évader)', () => {
    refuse(() => scanTemplate("printf %s '{{x}}'", { allowedParams: ['x'] }), /quotes/);
    refuse(() => scanTemplate('printf %s "{{x}}"', { allowedParams: ['x'] }), /quotes/);
  });

  test('nettoyage', () => { fs.rmSync(dir, { recursive: true, force: true }); });
});

describe('masquage des secrets', () => {
  test('forme brute, quotes shell, JSON, base64, hex, URL', () => {
    const s = "p@ss'w\"ord/é+1";
    const mask = createMasker([s]);
    const formes = [s, `'${s.replace(/'/g, `'\\''`)}'`, JSON.stringify(s).slice(1, -1), Buffer.from(s).toString('base64'), Buffer.from(s).toString('hex'), encodeURIComponent(s)];
    for (const f of formes) assert.ok(!mask(`avant ${f} après`).includes(f), f);
    assert.equal(mask(`x${s}y`), `x${MASK}y`);
  });

  test('plusieurs secrets, plusieurs occurrences, Buffer accepté, texte sans secret inchangé', () => {
    const mask = createMasker(['secret-un', 'secret-deux']);
    assert.equal(mask('secret-un et secret-deux et secret-un'), `${MASK} et ${MASK} et ${MASK}`);
    assert.equal(mask(Buffer.from('rien à cacher')), 'rien à cacher');
    assert.equal(createMasker([])('abc'), 'abc');
  });

  test('un secret contenu dans un autre n\'en laisse pas de reste', () => {
    const mask = createMasker(['abcdef', 'abcdefghij']);
    assert.equal(mask('xabcdefghijx'), `x${MASK}x`);
  });

  test('un secret trop court n\'est ni masqué (il abîmerait la sortie) ni accepté', () => {
    assert.equal(createMasker(['ab'])('ababab'), 'ababab');
    assert.match(checkSecretValue('abc'), /trop court/);
  });

  test('valeurs de secret : une ligne, bornées, sans NUL', () => {
    assert.equal(checkSecretValue('un-bon-secret'), null);
    for (const v of ['a\nb-secret', 'a\rb-secret', 'a\u0000b-secret', 'x'.repeat(600), 42, null]) assert.ok(checkSecretValue(v), JSON.stringify(v)?.slice(0, 20));
  });
});
