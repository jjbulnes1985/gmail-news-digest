'use strict';

/**
 * podcast.js — Publica el audio del día como feed de podcast (un episodio por segmento).
 *
 * Cada segmento del audio (Índice, Alertas del día y cada temática) se publica como
 * un episodio independiente en GitHub Pages (rama gh-pages), con un feed.xml compatible
 * con Apple Podcasts. Así se puede saltar, adelantar o retroceder por sección y la app
 * recuerda dónde se iba.
 *
 * Estructura en gh-pages:
 *   .nojekyll, robots.txt, index.html
 *   <PODCAST_PATH_TOKEN>/feed.xml
 *   <PODCAST_PATH_TOKEN>/episodes.json          (manifiesto para la retención)
 *   <PODCAST_PATH_TOKEN>/aaaa-mm-dd/NN.mp3
 *
 * Privacidad: la ruta lleva un identificador aleatorio largo (secreto PODCAST_PATH_TOKEN),
 * el feed lleva itunes:block y robots.txt prohíbe indexar. El repositorio es público, así
 * que quien tenga el enlace puede escucharlo.
 *
 * La rama gh-pages se reescribe con un único commit en cada publicación (sin historial),
 * para que no crezca. Retención: PODCAST_RETENTION_DAYS (7 por defecto).
 *
 * publishPodcast NUNCA lanza: devuelve { ok:false, reason } y el correo sale igual.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { log } = require('./utils');

const RETENTION_DAYS = parseInt(process.env.PODCAST_RETENTION_DAYS, 10) || 7;
const BRANCH         = process.env.PODCAST_BRANCH || 'gh-pages';
const GIT_TIMEOUT_MS = 90 * 1000;
const SHOW_TITLE     = 'Resumen Noticias';

// ─── Funciones puras (feed y retención) ─────────────────────────────────────

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** "aaaa-mm-dd" → "dd/mm/aaaa". */
function isoToDMY(iso) { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; }

/** "dd/mm/aaaa" → "aaaa-mm-dd". */
function dmyToISO(dmy) { const [d, m, y] = dmy.split('/'); return `${y}-${m}-${d}`; }

/** Segundos → "hh:mm:ss". */
function hhmmss(sec) {
  const t = Math.max(0, Math.round(sec));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`;
}

/**
 * pubDate del episodio k del día: 08:00 de Santiago (11:00 UTC; Chile usa UTC-3 en
 * horario de verano y UTC-4 en invierno, la diferencia no afecta el orden) más k minutos,
 * para que el orden dentro del día sea estrictamente creciente.
 */
function pubDateFor(iso, k) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 11, k, 0)).toUTCString();
}

/**
 * Episodios del día a partir de los segmentos del audio.
 * @param {string} iso - fecha aaaa-mm-dd (Santiago)
 * @param {{titulo:string, detalle?:string[], bytes:number, seconds:number}[]} segments
 */
function dayEpisodes(iso, segments) {
  const dmy = isoToDMY(iso);
  return segments.map((s, k) => {
    const nn = String(k).padStart(2, '0');
    return {
      date: iso,
      n: k,
      file: `${iso}/${nn}.mp3`,
      title: `${dmy} · ${nn} · ${s.titulo}`,
      description: (s.detalle && s.detalle.length ? s.detalle.join('\n') : s.titulo),
      bytes: s.bytes,
      seconds: s.seconds,
    };
  });
}

/**
 * Reemplaza los episodios del día (una corrida repetida no duplica) y aplica la retención:
 * conserva solo los últimos `days` días distintos.
 */
function mergeEpisodes(previous, today, days = RETENTION_DAYS) {
  const iso = today.length ? today[0].date : null;
  const all = [...(previous || []).filter((e) => e.date !== iso), ...today];
  const keepDates = [...new Set(all.map((e) => e.date))].sort().reverse().slice(0, days);
  return all.filter((e) => keepDates.includes(e.date))
    .sort((a, b) => (a.date === b.date ? a.n - b.n : (a.date < b.date ? -1 : 1)));
}

/**
 * Feed RSS 2.0 con namespace itunes. Serie (serial) con temporada = aaaammdd y
 * episodio = NN + 1: Apple Podcasts reproduce en orden, del Índice a la última sección.
 */
function buildFeed(episodes, baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');
  const items = [...episodes].sort((a, b) => (a.date === b.date ? b.n - a.n : (a.date < b.date ? 1 : -1)))
    .map((e) => `    <item>
      <title>${xmlEscape(e.title)}</title>
      <description>${xmlEscape(e.description)}</description>
      <enclosure url="${xmlEscape(`${base}/${e.file}`)}" length="${e.bytes}" type="audio/mpeg"/>
      <guid isPermaLink="false">resumen-noticias-${e.date}-${String(e.n).padStart(2, '0')}</guid>
      <pubDate>${pubDateFor(e.date, e.n)}</pubDate>
      <itunes:title>${xmlEscape(e.title)}</itunes:title>
      <itunes:duration>${hhmmss(e.seconds)}</itunes:duration>
      <itunes:season>${e.date.replace(/-/g, '')}</itunes:season>
      <itunes:episode>${e.n + 1}</itunes:episode>
      <itunes:episodeType>full</itunes:episodeType>
      <itunes:explicit>false</itunes:explicit>
    </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${SHOW_TITLE}</title>
    <link>${xmlEscape(base + '/')}</link>
    <atom:link href="${xmlEscape(base + '/feed.xml')}" rel="self" type="application/rss+xml"/>
    <language>es-cl</language>
    <description>Resumen diario de noticias en audio, un episodio por sección (uso personal).</description>
    <itunes:author>Resumen Noticias</itunes:author>
    <itunes:type>serial</itunes:type>
    <itunes:block>Yes</itunes:block>
    <itunes:explicit>false</itunes:explicit>
    <itunes:category text="News"/>
${items}
  </channel>
</rss>
`;
}

/** URL base pública del feed en GitHub Pages ("owner/repo" → https://owner.github.io/repo/token). */
function pagesBaseUrl(repository, token) {
  const [owner, repo] = String(repository).split('/');
  return `https://${owner.toLowerCase()}.github.io/${repo}/${token}`;
}

// ─── Publicación en gh-pages ───────────────────────────────────────────────

function git(cwd, args, env) {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' }, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/** Oculta el token en mensajes de error. */
function scrub(msg, secrets) {
  let out = String(msg);
  for (const s of secrets) if (s) out = out.split(s).join('***');
  return out;
}

/**
 * Publica los segmentos del día en gh-pages. Nunca lanza.
 * @param {{ok:boolean, segments?:object[]}} audio - resultado de generateAudio
 * @param {string} iso - fecha aaaa-mm-dd (Santiago)
 * @returns {Promise<{ok:boolean, reason?:string, feedUrl?:string, episodes?:number}>}
 */
async function publishPodcast(audio, iso, opts = {}) {
  const token = opts.pathToken !== undefined ? opts.pathToken : process.env.PODCAST_PATH_TOKEN;
  const ghToken = opts.githubToken !== undefined ? opts.githubToken : process.env.GITHUB_TOKEN;
  const repository = opts.repository || process.env.GITHUB_REPOSITORY;
  const remote = opts.remote; // solo pruebas: ruta a un repositorio local
  try {
    if (String(process.env.PODCAST_ENABLED || 'true').toLowerCase() === 'false') {
      return { ok: false, skipped: true, reason: 'podcast desactivado (PODCAST_ENABLED=false)' };
    }
    if (!token || !/^[A-Za-z0-9_-]{16,}$/.test(token)) {
      log('WARN', 'Podcast no publicado: falta el secreto PODCAST_PATH_TOKEN (mínimo 16 caracteres, letras, números, - o _).');
      return { ok: false, reason: 'falta configurar el secreto PODCAST_PATH_TOKEN' };
    }
    if (!audio || !audio.ok || !audio.segments || !audio.segments.length) {
      return { ok: false, reason: 'no hay segmentos de audio para publicar' };
    }
    if (!remote && (!ghToken || !repository)) {
      return { ok: false, reason: 'faltan GITHUB_TOKEN o GITHUB_REPOSITORY en el entorno' };
    }

    const url = remote || `https://x-access-token:${ghToken}@github.com/${repository}.git`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-'));
    const env = { GIT_AUTHOR_NAME: 'github-actions[bot]', GIT_AUTHOR_EMAIL: 'github-actions[bot]@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'github-actions[bot]', GIT_COMMITTER_EMAIL: 'github-actions[bot]@users.noreply.github.com' };

    // 1) Traer el estado actual de gh-pages (si existe)
    git(dir, ['init', '-q'], env);
    git(dir, ['remote', 'add', 'origin', url], env);
    let exists = true;
    try { git(dir, ['fetch', '-q', '--depth', '1', 'origin', BRANCH], env); }
    catch (_) { exists = false; }
    if (exists) git(dir, ['checkout', '-q', '-f', 'FETCH_HEAD'], env);

    // 2) Manifiesto + episodios del día + retención
    const root = path.join(dir, token);
    fs.mkdirSync(root, { recursive: true });
    const manifestPath = path.join(root, 'episodes.json');
    let previous = [];
    try { previous = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')).episodes || []; } catch (_) { previous = []; }
    const today = dayEpisodes(iso, audio.segments);
    const episodes = mergeEpisodes(previous, today);

    fs.rmSync(path.join(root, iso), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, iso), { recursive: true });
    audio.segments.forEach((s, k) => fs.copyFileSync(s.path, path.join(root, today[k].file)));

    // Borra días fuera de la retención y archivos huérfanos
    const keepDates = new Set(episodes.map((e) => e.date));
    const keepFiles = new Set(episodes.map((e) => e.file));
    for (const name of fs.readdirSync(root)) {
      const full = path.join(root, name);
      if (!fs.statSync(full).isDirectory()) continue;
      if (!keepDates.has(name)) { fs.rmSync(full, { recursive: true, force: true }); continue; }
      for (const f of fs.readdirSync(full)) if (!keepFiles.has(`${name}/${f}`)) fs.rmSync(path.join(full, f), { force: true });
    }
    // Cualquier otra ruta de nivel superior (por ejemplo, un token anterior) se elimina
    for (const name of fs.readdirSync(dir)) {
      if (['.git', token, '.nojekyll', 'robots.txt', 'index.html'].includes(name)) continue;
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }

    const baseUrl = opts.baseUrl || pagesBaseUrl(repository, token);
    fs.writeFileSync(manifestPath, JSON.stringify({ updated: new Date().toISOString(), episodes }, null, 2));
    fs.writeFileSync(path.join(root, 'feed.xml'), buildFeed(episodes, baseUrl));
    fs.writeFileSync(path.join(dir, '.nojekyll'), '');
    fs.writeFileSync(path.join(dir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>.</title>\n');

    // 3) Un único commit sin historial, empujado con fuerza SOLO a gh-pages
    git(dir, ['checkout', '-q', '--orphan', 'podcast-tmp'], env);
    git(dir, ['add', '-A'], env);
    git(dir, ['commit', '-q', '-m', `podcast: episodios del ${isoToDMY(iso)}`], env);
    git(dir, ['push', '-q', '--force', 'origin', `HEAD:refs/heads/${BRANCH}`], env);
    fs.rmSync(dir, { recursive: true, force: true });

    const feedUrl = `${baseUrl}/feed.xml`;
    log('INFO', `Podcast publicado: ${today.length} episodios del ${isoToDMY(iso)}; ${episodes.length} en el feed (${keepDates.size} días).`);
    return { ok: true, feedUrl, episodes: today.length };
  } catch (err) {
    const reason = scrub(err.stderr ? `${err.message} ${err.stderr}` : err.message, [ghToken, token]).replace(/\s+/g, ' ').slice(0, 200);
    log('WARN', `Podcast no publicado: ${reason}`);
    return { ok: false, reason };
  }
}

module.exports = { publishPodcast, buildFeed, mergeEpisodes, dayEpisodes, pagesBaseUrl, hhmmss, dmyToISO, isoToDMY, xmlEscape };
