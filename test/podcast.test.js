'use strict';

// Pruebas del podcast por secciones: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildFeed, mergeEpisodes, dayEpisodes, publishPodcast, pagesBaseUrl, hhmmss } = require('../src/podcast');
const { podcastHtml } = require('../src/mailer');

const BASE = 'https://ejemplo.github.io/repo/TOKEN1234567890abcd';
const TOKEN = 'TOKEN1234567890abcd';

function segs(n) {
  return Array.from({ length: n }, (_, k) => ({ titulo: k ? `Sección ${k}` : 'Índice', detalle: [`detalle ${k}`], bytes: 1000 + k, seconds: 60 + k }));
}

function isoPlus(start, days) {
  const d = new Date(`${start}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test('feed: un item por segmento, enclosure y orden de episodios', () => {
  const eps = dayEpisodes('2026-10-31', segs(4));
  const xml = buildFeed(eps, BASE);
  assert.match(xml, /<rss version="2.0" xmlns:itunes="http:\/\/www.itunes.com\/dtds\/podcast-1.0.dtd"/);
  assert.match(xml, /<itunes:type>serial<\/itunes:type>/);
  assert.match(xml, /<itunes:block>Yes<\/itunes:block>/);
  assert.equal((xml.match(/<item>/g) || []).length, 4);
  assert.match(xml, /<enclosure url="https:\/\/ejemplo.github.io\/repo\/TOKEN1234567890abcd\/2026-10-31\/00.mp3" length="1000" type="audio\/mpeg"\/>/);
  assert.match(xml, /<title>31\/10\/2026 · 03 · Sección 3<\/title>/);
  assert.match(xml, /<itunes:season>20261031<\/itunes:season>/);
  // pubDate estrictamente creciente con el número de episodio
  const dates = eps.map((e) => e.n).map((n) => {
    const block = xml.split('<item>').find((b) => b.includes(`-${String(n).padStart(2, '0')}</guid>`));
    return Date.parse(block.match(/<pubDate>(.*?)<\/pubDate>/)[1]);
  });
  for (let k = 1; k < dates.length; k++) assert.ok(dates[k] > dates[k - 1]);
  assert.equal(hhmmss(3725), '01:02:05');
});

test('feed: escapa caracteres XML', () => {
  const xml = buildFeed(dayEpisodes('2026-10-31', [{ titulo: 'Economía & <Finanzas>', bytes: 1, seconds: 1 }]), BASE);
  assert.match(xml, /Economía &amp; &lt;Finanzas&gt;/);
});

test('retención: tras 8 días quedan solo los últimos 7', () => {
  let eps = [];
  for (let d = 0; d < 8; d++) eps = mergeEpisodes(eps, dayEpisodes(isoPlus('2026-10-24', d), segs(3)), 7);
  const dates = [...new Set(eps.map((e) => e.date))];
  assert.equal(dates.length, 7);
  assert.ok(!dates.includes('2026-10-24'));
  assert.ok(dates.includes('2026-10-31'));
});

test('anti-duplicado: republicar el mismo día reemplaza, no duplica', () => {
  let eps = mergeEpisodes([], dayEpisodes('2026-10-31', segs(5)));
  eps = mergeEpisodes(eps, dayEpisodes('2026-10-31', segs(3)));
  assert.equal(eps.length, 3);
});

test('sin el secreto PODCAST_PATH_TOKEN no publica y devuelve el motivo', async () => {
  const r = await publishPodcast({ ok: true, segments: [] }, '2026-10-31', { pathToken: '' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /PODCAST_PATH_TOKEN/);
});

test('URL base de GitHub Pages', () => {
  assert.equal(pagesBaseUrl('JJBulnes1985/gmail-news-digest', 'abc'), 'https://jjbulnes1985.github.io/gmail-news-digest/abc');
});

test('correo: nota de podcast actualizado y de podcast no actualizado', () => {
  assert.match(podcastHtml({ ok: true, episodes: 6, feedUrl: `${BASE}/feed.xml` }), /Podcast actualizado con 6 episodios/);
  assert.match(podcastHtml({ ok: false, reason: 'error de red' }), /Podcast no actualizado hoy: error de red/);
  assert.equal(podcastHtml(null), '');
});

test('publicación en gh-pages: un commit, retención y sin MP3 huérfanos (repositorio local)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-test-'));
  const remote = path.join(tmp, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  const mk = (iso, n) => Array.from({ length: n }, (_, k) => {
    const p = path.join(tmp, `${iso}-${k}.mp3`); fs.writeFileSync(p, Buffer.alloc(100 + k));
    return { titulo: `S${k}`, detalle: [], path: p, bytes: 100 + k, seconds: 10 };
  });
  for (let d = 0; d < 8; d++) {
    const iso = isoPlus('2026-10-24', d);
    const r = await publishPodcast({ ok: true, segments: mk(iso, 3) }, iso, { pathToken: TOKEN, remote, baseUrl: BASE });
    assert.equal(r.ok, true, r.reason);
  }
  const work = path.join(tmp, 'check');
  execFileSync('git', ['clone', '-q', '--branch', 'gh-pages', remote, work]);
  assert.equal(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: work }).toString().trim(), '1');
  const days = fs.readdirSync(path.join(work, TOKEN)).filter((n) => /^\d{4}-/.test(n)).sort();
  assert.equal(days.length, 7);
  assert.equal(days[0], '2026-10-25');
  const xml = fs.readFileSync(path.join(work, TOKEN, 'feed.xml'), 'utf-8');
  assert.equal((xml.match(/<item>/g) || []).length, 21);
  for (const m of xml.matchAll(/url="[^"]*\/(\d{4}-\d{2}-\d{2}\/\d{2}\.mp3)" length="(\d+)"/g)) {
    assert.equal(fs.statSync(path.join(work, TOKEN, m[1])).size, Number(m[2]));
  }
  assert.ok(fs.existsSync(path.join(work, '.nojekyll')));
  assert.match(fs.readFileSync(path.join(work, 'robots.txt'), 'utf-8'), /Disallow: \//);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('publicación fallida (remoto inexistente) no lanza y devuelve motivo', async () => {
  const r = await publishPodcast({ ok: true, segments: [{ titulo: 'x', path: __filename, bytes: 1, seconds: 1 }] }, '2026-10-31',
    { pathToken: TOKEN, remote: '/ruta/que/no/existe.git', baseUrl: BASE });
  assert.equal(r.ok, false);
  assert.ok(r.reason.length > 0);
});
