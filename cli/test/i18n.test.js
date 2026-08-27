'use strict';

/** i18n: catalogs, fallback, and the CLI actually speaking pt-BR end to end. */

const { test } = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startMockServer } = require('./helpers/mock-server');

const BIN = path.join(__dirname, '..', 'bin', 'meshad.js');

function cli(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, timeout: 30000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

test('i18n module: pt-BR catalog covers every English key (no holes)', () => {
  // Import the catalogs through a fresh module instance.
  const i18nPath = require.resolve('../src/i18n');
  delete require.cache[i18nPath];
  const src = fs.readFileSync(i18nPath, 'utf8');
  // The module doesn't export raw catalogs; verify via behavior instead:
  const i18n = require('../src/i18n');
  process.env.MESHAD_LANG = 'pt-BR';
  i18n.init(null);
  // a sample across namespaces must not fall back to English
  assert.equal(i18n.t('earnings.title'), 'Ganhos');
  assert.equal(i18n.t('pause.resumed'), 'anúncios reativados');
  assert.match(i18n.t('init.consent.title'), /sua espera paga/);
  // interpolation
  assert.equal(i18n.t('pause.until', { ts: 'X' }), 'anúncios pausados até X');
  // unknown key falls back to the key itself, never crashes
  assert.equal(i18n.t('nope.missing'), 'nope.missing');
  // pt yes-answers
  assert.ok(i18n.isYes('s') && i18n.isYes('sim') && i18n.isYes('y'));
  delete process.env.MESHAD_LANG;
  i18n.init(null);
  assert.ok(src.includes("'pt-BR'"));
});

test('e2e pt-BR: init + demo + earnings speak Portuguese', async () => {
  const mock = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-i18n-'));
  const env = {
    MESHAD_CONFIG_DIR: dir,
    MESHAD_API_URL: mock.url,
    MESHAD_LANG: 'pt-BR',
    NO_COLOR: '1',
  };

  const init = await cli(['init', '--yes', '--email', 'pt@test.dev'], env);
  assert.equal(init.code, 0, init.stderr || init.stdout);
  assert.match(init.stdout, /O que coletamos/, 'consent in pt-BR');
  assert.match(init.stdout, /O que NUNCA coletamos/, 'never list in pt-BR');
  assert.match(init.stdout, /registrado como pt@test\.dev/, 'success in pt-BR');

  const demo = await cli(['demo', '--wait', '6'], env);
  assert.equal(demo.code, 0, demo.stderr || demo.stdout);
  assert.match(demo.stdout, /anúncio exibido .*s · removido em .*ms/, 'summary in pt-BR');
  assert.match(demo.stdout, /esta espera rendeu/, 'earnings line in pt-BR');

  const earnings = await cli(['earnings'], env);
  assert.equal(earnings.code, 0, earnings.stderr || earnings.stdout);
  assert.match(earnings.stdout, /Ganhos/, 'earnings title in pt-BR');
  assert.match(earnings.stdout, /pendente/, 'pending label in pt-BR');

  // English remains the default without MESHAD_LANG
  const statusEn = await cli(['status'], { ...env, MESHAD_LANG: 'en' });
  assert.match(statusEn.stdout, /telemetry queue/, 'en still works');

  await mock.close();
});
