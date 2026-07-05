'use strict';

/**
 * CLI i18n — en (source of truth) + pt-BR.
 *
 * Locale resolution, first match wins:
 *   MESHAD_LANG env → config `lang` → LANG env prefix → 'en'.
 * `--help` screens stay in English (like most dev tools); everything the
 * user reads in normal operation is translated.
 *
 * t(key, vars) interpolates {placeholders} and falls back to English for
 * any key missing from the active catalog — a hole is never a crash.
 */

const en = {
  // dispatcher
  'usage.tagline': "your agent's idle time becomes revenue.",
  'usage.unknown': 'unknown command "{cmd}"',

  // shared
  'err.notInitialized': 'not initialized — run',
  'err.emailRequired': 'a valid e-mail is required',

  // init
  'init.consent.title': 'MeshAd — your wait becomes AI revenue.',
  'init.consent.collectTitle': 'What we collect (exactly these 5 signals, nothing else):',
  'init.consent.item1': 'processing start (idle_start)',
  'init.consent.item2': 'processing end (idle_end)',
  'init.consent.item3': 'wait duration in ms',
  'init.consent.item4': 'an anonymous random ID (rotatable: meshad rotate-id)',
  'init.consent.item5': 'your terminal type (e.g. claude-code)',
  'init.consent.neverTitle': 'What we NEVER collect:',
  'init.consent.neverBody':
    'prompts, code, agent responses, file contents or names, project\n' +
    '    names, environment variables. The schema is a closed allowlist —\n' +
    '    the client physically cannot send anything else, and the server\n' +
    '    rejects any batch with an extra field. Verify: packages/schema.',
  'init.consent.inspect': 'Inspect every byte sent at any time: meshad status --explain',
  'init.consent.pause': 'Pause forever, no questions asked:    meshad pause forever',
  'init.accept': 'Accept? [y/N] ',
  'init.acceptedNonInteractive': 'consent accepted via --yes (non-interactive)',
  'init.declined': 'No problem — nothing was installed, nothing was sent.',
  'init.emailPrompt': 'E-mail for your publisher account: ',
  'init.already': 'already initialized',
  'init.startOver': 'Use {cmd} to start over.',
  'init.registered': 'registered as {email}',
  'init.device': 'device registered with anon_id {anonId}',
  'init.saved': 'config saved at {path}',
  'init.tryIt': 'Try it: {demo} · earnings: {earnings} · pause: {pause}',

  // earnings
  'earnings.title': 'Earnings',
  'earnings.total': 'total',
  'earnings.pending': 'pending',
  'earnings.pendingNote': '(matures to available after 30 days)',
  'earnings.available': 'available',
  'earnings.empty': 'no activity yet — try: meshad demo',
  'earnings.colDate': 'date',
  'earnings.colImpressions': 'impressions',
  'earnings.colClicks': 'clicks',
  'earnings.colEarned': 'earned',

  // pause / resume
  'pause.resumed': 'ads resumed',
  'pause.forever': 'ads paused forever',
  'pause.foreverHint': '(resume any time: meshad resume)',
  'pause.until': 'ads paused until {ts}',
  'pause.badArg': 'expected 1h, 1d or forever',
  'pause.offline': '(offline — server preference will not match until you are back online)',

  // uninstall
  'uninstall.confirm': 'Remove {dir} and all local MeshAd data? [y/N] ',
  'uninstall.cancelled': 'cancelled — nothing removed',
  'uninstall.removed': 'removed {dir}',
  'uninstall.thanks': 'Thanks for trying MeshAd. Your anon_id is gone; nothing links back to you.',
  'uninstall.nothing': 'nothing to remove ({dir} does not exist)',

  // status
  'status.active': 'active',
  'status.pausedForever': 'paused forever',
  'status.pausedUntil': 'paused until {ts}',
  'status.config': 'config',
  'status.api': 'api',
  'status.anonId': 'anon_id',
  'status.noneRunInit': '(none — run init)',
  'status.none': '(none)',
  'status.account': 'account',
  'status.terminal': 'terminal',
  'status.minWait': 'min wait',
  'status.freqCap': 'freq cap',
  'status.adPack': 'ad pack',
  'status.fresh': 'fresh ({s}s left)',
  'status.expired': 'expired',
  'status.noCache': '(no cache yet)',
  'status.badSignatures': 'bad signatures',
  'status.dropped': 'payload(s) dropped (invalid Ed25519)',
  'status.queue': 'telemetry queue',
  'status.buffered': 'event(s) buffered',
  'status.earnings': 'earnings',
  'status.unreachable': '(API unreachable — meshad earnings when back online)',
  'status.destinations': 'Network destinations',
  'status.destinationsNote': '(the complete list — there are no others)',
  'status.destTelemetry': 'POST · the 5 allowed signals only',
  'status.destPack': 'GET  · signed ad pack pre-fetch',
  'status.destKeys': 'GET  · Ed25519 verification key',
  'status.destPublisher': 'register/devices/me/earnings (explicit commands only)',
  'status.lastBatch': 'Last telemetry batch sent',
  'status.noBatch': '(no batch sent yet)',

  // payout / stats
  'payout.title': 'Payouts',
  'payout.none': 'no payouts yet — earnings mature to available after 30 days',
  'payout.methods': 'minimums',
  'payout.requested': 'payout {id} requested: {amount} via {method}',
  'stats.title': 'Stats',

  // demo
  'demo.summary': 'ad displayed {shown}s · cleared in {clear}ms · {sent} event(s) delivered',
  'demo.earned': 'this wait earned ~{amount}',
  'demo.earnedHint': '({model} · check: meshad earnings)',
  'demo.paused': 'ads are paused — no ad was shown, no impression sent (meshad resume)',
  'demo.noAd': 'no ad shown (no eligible signed ad in cache, frequency cap hit, or wait < 3s)',
  'demo.tooShort': 'ad shown < 2s — not billable, no impression sent (by design)',
};

const ptBR = {
  'usage.tagline': 'o tempo ocioso do seu agente paga a si mesmo.',
  'usage.unknown': 'comando desconhecido "{cmd}"',

  'err.notInitialized': 'não inicializado — rode',
  'err.emailRequired': 'um e-mail válido é obrigatório',

  'init.consent.title': 'MeshAd — sua espera paga sua IA.',
  'init.consent.collectTitle': 'O que coletamos (exatamente estes 5 sinais, nada mais):',
  'init.consent.item1': 'início do processamento (idle_start)',
  'init.consent.item2': 'fim do processamento (idle_end)',
  'init.consent.item3': 'duração da espera em ms',
  'init.consent.item4': 'um ID anônimo aleatório (rotacionável: meshad rotate-id)',
  'init.consent.item5': 'o tipo do seu terminal (ex.: claude-code)',
  'init.consent.neverTitle': 'O que NUNCA coletamos:',
  'init.consent.neverBody':
    'prompts, código, respostas do agente, conteúdo ou nomes de arquivos,\n' +
    '    nomes de projeto, variáveis de ambiente. O schema é uma allowlist\n' +
    '    fechada — o client é fisicamente incapaz de enviar qualquer outra\n' +
    '    coisa, e o servidor rejeita batches com campo extra. Verifique: packages/schema.',
  'init.consent.inspect': 'Inspecione cada byte enviado, quando quiser: meshad status --explain',
  'init.consent.pause': 'Pause para sempre, sem perguntas:        meshad pause forever',
  'init.accept': 'Aceita? [s/N] ',
  'init.acceptedNonInteractive': 'consentimento aceito via --yes (não interativo)',
  'init.declined': 'Sem problema — nada foi instalado, nada foi enviado.',
  'init.emailPrompt': 'E-mail da sua conta de publisher: ',
  'init.already': 'já inicializado',
  'init.startOver': 'Use {cmd} para recomeçar.',
  'init.registered': 'registrado como {email}',
  'init.device': 'dispositivo registrado com anon_id {anonId}',
  'init.saved': 'config salva em {path}',
  'init.tryIt': 'Experimente: {demo} · ganhos: {earnings} · pausar: {pause}',

  'earnings.title': 'Ganhos',
  'earnings.total': 'total',
  'earnings.pending': 'pendente',
  'earnings.pendingNote': '(libera para disponível após 30 dias)',
  'earnings.available': 'disponível',
  'earnings.empty': 'nenhuma atividade ainda — experimente: meshad demo',
  'earnings.colDate': 'data',
  'earnings.colImpressions': 'impressões',
  'earnings.colClicks': 'cliques',
  'earnings.colEarned': 'ganho',

  'pause.resumed': 'anúncios reativados',
  'pause.forever': 'anúncios pausados para sempre',
  'pause.foreverHint': '(reative quando quiser: meshad resume)',
  'pause.until': 'anúncios pausados até {ts}',
  'pause.badArg': 'esperado 1h, 1d ou forever',
  'pause.offline': '(offline — a preferência no servidor só sincroniza quando você voltar)',

  'uninstall.confirm': 'Remover {dir} e todos os dados locais do MeshAd? [s/N] ',
  'uninstall.cancelled': 'cancelado — nada foi removido',
  'uninstall.removed': 'removido {dir}',
  'uninstall.thanks': 'Obrigado por experimentar o MeshAd. Seu anon_id se foi; nada leva de volta a você.',
  'uninstall.nothing': 'nada a remover ({dir} não existe)',

  'status.active': 'ativo',
  'status.pausedForever': 'pausado para sempre',
  'status.pausedUntil': 'pausado até {ts}',
  'status.config': 'config',
  'status.api': 'api',
  'status.anonId': 'anon_id',
  'status.noneRunInit': '(nenhum — rode init)',
  'status.none': '(nenhuma)',
  'status.account': 'conta',
  'status.terminal': 'terminal',
  'status.minWait': 'espera mín.',
  'status.freqCap': 'limite freq.',
  'status.adPack': 'pack de ads',
  'status.fresh': 'válido ({s}s restantes)',
  'status.expired': 'expirado',
  'status.noCache': '(sem cache ainda)',
  'status.badSignatures': 'assinaturas ruins',
  'status.dropped': 'payload(s) descartado(s) (Ed25519 inválido)',
  'status.queue': 'fila de telemetria',
  'status.buffered': 'evento(s) em buffer',
  'status.earnings': 'ganhos',
  'status.unreachable': '(API inalcançável — meshad earnings quando voltar)',
  'status.destinations': 'Destinos de rede',
  'status.destinationsNote': '(a lista completa — não existem outros)',
  'status.destTelemetry': 'POST · somente os 5 sinais permitidos',
  'status.destPack': 'GET  · pré-fetch do pack assinado',
  'status.destKeys': 'GET  · chave de verificação Ed25519',
  'status.destPublisher': 'register/devices/me/earnings (somente comandos explícitos)',
  'status.lastBatch': 'Último batch de telemetria enviado',
  'status.noBatch': '(nenhum batch enviado ainda)',

  'payout.title': 'Saques',
  'payout.none': 'nenhum saque ainda — ganhos liberam para disponível após 30 dias',
  'payout.methods': 'mínimos',
  'payout.requested': 'saque {id} solicitado: {amount} via {method}',
  'stats.title': 'Estatísticas',

  'demo.summary': 'anúncio exibido {shown}s · removido em {clear}ms · {sent} evento(s) entregues',
  'demo.earned': 'esta espera rendeu ~{amount}',
  'demo.earnedHint': '({model} · confira: meshad earnings)',
  'demo.paused': 'anúncios pausados — nada foi exibido, nenhuma impressão enviada (meshad resume)',
  'demo.noAd': 'nenhum anúncio exibido (sem ad assinado elegível no cache, limite de frequência, ou espera < 3s)',
  'demo.tooShort': 'anúncio exibido < 2s — não faturável, nenhuma impressão enviada (por design)',
};

const CATALOGS = { en, 'pt-BR': ptBR };
const SUPPORTED = Object.keys(CATALOGS);

let current = null; // resolved lazily

function resolveLocale(cfg) {
  const explicit = process.env.MESHAD_LANG || (cfg && cfg.lang);
  if (explicit && SUPPORTED.includes(explicit)) return explicit;
  if (explicit && explicit.toLowerCase().startsWith('pt')) return 'pt-BR';
  const sys = (process.env.LC_ALL || process.env.LANG || '').toLowerCase();
  if (sys.startsWith('pt')) return 'pt-BR';
  return 'en';
}

/** Set the active locale from config/env. Call once per command entry. */
function init(cfg) {
  current = resolveLocale(cfg);
  return current;
}

function locale() {
  if (!current) init(null);
  return current;
}

/** Translate + interpolate. Missing keys fall back to English. */
function t(key, vars) {
  const catalog = CATALOGS[locale()] || en;
  let s = catalog[key] ?? en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
  return s;
}

/** Locale-aware yes answers ("y"/"yes" always accepted). */
function isYes(answer) {
  const a = String(answer).trim().toLowerCase();
  return a === 'y' || a === 'yes' || (locale() === 'pt-BR' && (a === 's' || a === 'sim'));
}

module.exports = { t, init, locale, isYes, SUPPORTED };
