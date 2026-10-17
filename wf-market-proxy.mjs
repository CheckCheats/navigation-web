#!/usr/bin/env node
// Warframe Market 本地价格代理 + 导航页静态服务（零依赖，Node 20+）
//
// 为什么需要它：api.warframe.market 只给 warframe.market 自家 Origin 发 CORS 头，
// 浏览器从 file:// 或本地静态页直接 fetch 会被跨域拦截。这里在本机转发一次，
// 顺便把挂单压成导航页小窗口要用的字段。
//
// 用法：
//   node wf-market-proxy.mjs
//   浏览器打开 http://127.0.0.1:8898/
// 端口可用环境变量 PORT 覆盖，默认 8898。

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT || 8898);
const HOST = process.env.HOST || '127.0.0.1';
const API_BASE = 'https://api.warframe.market/v2';
const ORDER_TTL_MS = 25 * 1000;
const OFFICIAL_WS = 'https://api.warframe.com/cdn/worldState.php';
const WS_TTL_MS = 30 * 1000;
const WF_WEEKLY_ANCHOR = Date.UTC(2026, 9, 12, 0, 0, 0);
const WF_VALLIS_ANCHOR = Date.parse('2026-02-04T19:46:48Z');
const WF_ZARIMAN_ANCHOR = 1655182800000;
const WF_STEEL_ANCHOR = Date.parse('2020-11-16T00:00:00Z');
const WF_STEEL_ROTATION = [
  'Umbra Forma 蓝图', '50,000 赤毒', '组合枪裂罅 Mod', '3x Forma',
  'Zaw 裂罅 Mod', '30,000 内融核心', '步枪裂罅 Mod', '霰弹枪裂罅 Mod',
];
const WF_ARCHON_SHARDS = {
  SORTIE_BOSS_BOREAL: '琥珀',
  SORTIE_BOSS_AMAR: '蔚蓝',
  SORTIE_BOSS_NIRA: '深红',
};
const WF_BOUNTY_ORDER = [
  { key: 'C', label: 'C 突变原聚合物' },
  { key: 'A', label: 'A 电磁力场装置' },
  { key: 'B', label: 'B 爆燃喷射器' },
];
let wsCache = { ts: 0, data: null };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const ordersCache = new Map();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function fetchUpstream(pathname) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(API_BASE + pathname, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        Language: 'zh-hans',
        Platform: 'pc',
        'User-Agent': 'dh-nav-wf-market/1.0',
      },
    });
    if (!res.ok) throw new Error(`上游 HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeOrders(slug, raw) {
  const list = Array.isArray(raw?.data) ? raw.data : [];
  const sells = [];
  const buys = [];

  for (const order of list) {
    if (!order || order.visible === false) continue;
    if (order.type !== 'sell' && order.type !== 'buy') continue;
    const user = order.user || {};
    const platform = String(user.platform || 'pc').toLowerCase();
    if (platform !== 'pc') continue;

    const entry = {
      price: Number(order.platinum) || 0,
      qty: Number(order.quantity) || 1,
      perTrade: Number(order.perTrade) || 1,
      rank: Number(order.rank) || 0,
      status: String(user.status || 'offline').toLowerCase(),
      user: String(user.ingameName || user.slug || '?'),
      updated: order.updatedAt || null,
    };
    if (order.type === 'sell') sells.push(entry);
    else buys.push(entry);
  }

  sells.sort((a, b) => a.price - b.price || b.qty - a.qty || a.user.localeCompare(b.user));
  buys.sort((a, b) => b.price - a.price || b.qty - a.qty || a.user.localeCompare(b.user));

  const onlineSells = sells.filter(o => o.status !== 'offline');
  const onlineBuys = buys.filter(o => o.status !== 'offline');

  return {
    ok: true,
    slug,
    updatedAt: new Date().toISOString(),
    stats: {
      sellCount: sells.length,
      buyCount: buys.length,
      sellCountOnline: onlineSells.length,
      buyCountOnline: onlineBuys.length,
      minSell: sells.length ? sells[0].price : null,
      maxBuy: buys.length ? buys[0].price : null,
      minSellOnline: onlineSells.length ? onlineSells[0].price : null,
      maxBuyOnline: onlineBuys.length ? onlineBuys[0].price : null,
    },
    sells,
    buys,
  };
}

async function getOrders(slug, force) {
  const key = `orders:${slug}`;
  const hit = ordersCache.get(key);
  if (!force && hit && Date.now() - hit.ts < ORDER_TTL_MS) return hit.data;
  const raw = await fetchUpstream(`/orders/item/${encodeURIComponent(slug)}`);
  const data = normalizeOrders(slug, raw);
  ordersCache.set(key, { ts: Date.now(), data });
  if (ordersCache.size > 50) ordersCache.delete(ordersCache.keys().next().value);
  return data;
}

function msDate(node) {
  return Number(node?.$date?.$numberLong || 0);
}

function nextWeeklyResetMs(now = Date.now()) {
  const d = new Date(now);
  const day = d.getUTCDay();
  let add = (1 - day + 7) % 7;
  if (add === 0) add = 7;
  return Math.max(0, Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add) - now);
}

async function fetchOfficialWorldstate() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(OFFICIAL_WS, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'dh-nav-wf-market/1.0',
      },
    });
    if (!res.ok) throw new Error(`上游 HTTP ${res.status}`);
    const text = await res.text();
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function buildWorldstate(raw, now = Date.now()) {
  const syndicates = Array.isArray(raw?.SyndicateMissions) ? raw.SyndicateMissions : [];
  const cetusSyn = syndicates.find((s) => s.Tag === 'CetusSyndicate');
  if (!cetusSyn) throw new Error('CetusSyndicate missing');

  const activation = msDate(cetusSyn.Activation);
  const expiry = msDate(cetusSyn.Expiry);
  const timeToEnd = Math.max(0, expiry - now);
  const isDay = timeToEnd > 3000 * 1000;
  const cetusExpiry = isDay ? expiry - 3000 * 1000 : expiry;
  const cetusRemain = Math.max(0, cetusExpiry - now);

  const cetus = {
    state: isDay ? 'day' : 'night',
    label: isDay ? '白天' : '夜晚',
    remain: cetusRemain,
    expiryMs: cetusExpiry,
    icon: isDay ? 'day' : 'night',
    iconState: isDay ? 'day' : 'night',
  };

  const cambion = {
    state: isDay ? 'fass' : 'vome',
    label: isDay ? '法丝 Fass' : '沃姆 Vome',
    remain: cetusRemain,
    expiryMs: cetusExpiry,
    icon: isDay ? 'fass' : 'vome',
    iconState: isDay ? 'fass' : 'vome',
  };

  const vallisLoop = 1600000;
  const vallisCold = 1200000;
  const vallisSince = ((now - WF_VALLIS_ANCHOR) % vallisLoop + vallisLoop) % vallisLoop;
  const vallisToNext = vallisLoop - vallisSince;
  const isWarm = vallisToNext > vallisCold;
  const vallisRemain = isWarm ? vallisToNext - vallisCold : vallisToNext;
  const vallis = {
    state: isWarm ? 'warm' : 'cold',
    label: isWarm ? '温暖' : '寒冷',
    remain: vallisRemain,
    expiryMs: now + vallisRemain,
    icon: isWarm ? 'warm' : 'cold',
    iconState: isWarm ? 'warm' : 'cold',
  };

  const zarimanEnd = expiry - 5000;
  const zarimanRemain = Math.max(0, zarimanEnd - now);
  const zarimanElapsed = (((zarimanEnd - WF_ZARIMAN_ANCHOR) % 18000000) + 18000000) % 18000000;
  const isCorpus = 18000000 - zarimanElapsed > 9000000;
  const zariman = {
    state: isCorpus ? 'corpus' : 'grineer',
    label: isCorpus ? 'Corpus 控制' : 'Grineer 控制',
    remain: zarimanRemain,
    expiryMs: zarimanEnd,
    icon: isCorpus ? 'corpus' : 'grineer',
    iconState: isCorpus ? 'corpus' : 'grineer',
  };

  const duviriCycle = 36000;
  const duviriState = 7200;
  const moods = ['sorrow', 'fear', 'joy', 'anger', 'envy'];
  const moodZh = { sorrow: '悲伤', fear: '恐惧', joy: '喜悦', anger: '愤怒', envy: '嫉妒' };
  const duviriDelta = ((Math.floor(now / 1000) - 52) % duviriCycle + duviriCycle) % duviriCycle;
  const duviriIdx = Math.floor(duviriDelta / duviriState) % moods.length;
  const duviriRemain = (duviriState - (duviriDelta % duviriState)) * 1000;
  const duviri = {
    state: moods[duviriIdx],
    label: moodZh[moods[duviriIdx]] || moods[duviriIdx],
    remain: duviriRemain,
    expiryMs: now + duviriRemain,
    icon: 'mood',
    iconState: 'mood',
  };

  const bountyCycle = 9000000;
  const bountySince = ((now - activation) % bountyCycle + bountyCycle) % bountyCycle;
  const bountyIdx = Math.floor((now - activation) / bountyCycle);
  const bountyItem = WF_BOUNTY_ORDER[((bountyIdx % 3) + 3) % 3];
  const bounty = {
    state: 'bounty',
    label: bountyItem.label,
    remain: timeToEnd,
    expiryMs: expiry,
    icon: 'bounty',
    iconState: 'bounty',
    key: bountyItem.key,
  };

  const steelSince = (now - WF_STEEL_ANCHOR) / 1000;
  const steelIdx = Math.floor((steelSince % 4838400) / 604800);

  const lite = Array.isArray(raw?.LiteSorties) ? raw.LiteSorties[0] : null;
  const bossRaw = String(lite?.Boss || '');
  const archon = {
    boss: bossRaw.replace('SORTIE_BOSS_', '') || '—',
    shard: WF_ARCHON_SHARDS[bossRaw] || '—',
    resetMs: lite?.Expiry ? Math.max(0, msDate(lite.Expiry) - now) : nextWeeklyResetMs(now),
  };

  const weeks = Math.floor((now - WF_WEEKLY_ANCHOR) / 604800000);
  const circuitWeek = ((weeks + 6) % 9 + 9) % 9 + 1;
  const schedule = Array.isArray(raw?.EndlessXpSchedule) ? raw.EndlessXpSchedule[0] : null;
  const hardChoices = (schedule?.CategoryChoices || []).find((c) => c.Category === 'EXC_HARD');

  return {
    ok: true,
    source: 'official',
    updatedAt: new Date(now).toISOString(),
    cycles: { cetus, vallis, cambion, zariman, duviri },
    bounty,
    steelPath: {
      index: steelIdx,
      reward: WF_STEEL_ROTATION[steelIdx] || '—',
      resetMs: nextWeeklyResetMs(now),
    },
    archon,
    circuit: {
      week: circuitWeek,
      items: Array.isArray(hardChoices?.Choices) ? hardChoices.Choices : [],
      resetMs: nextWeeklyResetMs(now),
    },
  };
}

async function getWorldstate(force) {
  if (!force && wsCache.data && Date.now() - wsCache.ts < WS_TTL_MS) return wsCache.data;
  const raw = await fetchOfficialWorldstate();
  const data = buildWorldstate(raw);
  wsCache = { ts: Date.now(), data };
  return data;
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (!rel) rel = 'index.html';
  if (rel.split('/').some(seg => seg.startsWith('.'))) {
    return sendJson(res, 404, { ok: false, error: 'not found' });
  }
  const target = resolve(join(ROOT, rel));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  } catch {
    sendJson(res, 404, { ok: false, error: 'not found' });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET,HEAD,OPTIONS');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  }

  try {
    if (url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'wf-market-proxy',
        port: PORT,
        cached: ordersCache.size,
      });
    }

    if (url.pathname === '/api/wf/worldstate') {
      return sendJson(res, 200, await getWorldstate(url.searchParams.get('force') === '1'));
    }

    if (url.pathname === '/api/wf/orders') {
      const slug = String(url.searchParams.get('slug') || '').trim();
      if (!/^[a-z0-9_-]{1,120}$/i.test(slug)) {
        return sendJson(res, 400, { ok: false, error: 'invalid slug' });
      }
      return sendJson(res, 200, await getOrders(slug, url.searchParams.get('force') === '1'));
    }

    if (url.pathname.startsWith('/api/')) {
      return sendJson(res, 404, { ok: false, error: 'unknown api' });
    }

    return serveStatic(req, res, url.pathname);
  } catch (err) {
    return sendJson(res, 502, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

server.requestTimeout = 20000;
server.on('error', async (err) => {
  if (err.code !== 'EADDRINUSE') {
    console.error('[wf-market] 启动失败：', err);
    process.exit(1);
  }
  try {
    const res = await fetch(`http://${HOST}:${PORT}/api/health`);
    const json = await res.json();
    if (json && json.service === 'wf-market-proxy') {
      console.log(`[wf-market] 已有实例在运行：http://${HOST}:${PORT}/`);
      process.exit(0);
    }
  } catch {}
  console.error(`[wf-market] 端口 ${PORT} 被其他程序占用。换端口：set PORT=8897 && node wf-market-proxy.mjs`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[wf-market] 价格代理已启动：http://${HOST}:${PORT}/`);
  console.log(`[wf-market] 导航页：http://${HOST}:${PORT}/  接口：/api/wf/orders?slug=arcane_barrier`);
});
