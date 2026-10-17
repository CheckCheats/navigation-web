// Warframe PE · Cloudflare Worker 免费版
//
// 作用：
//   1. 从 GitHub raw 托管导航页静态文件（index.html / JS / JSON）
//   2. 代理 Warframe Market 挂单（/api/wf/orders）
//   3. 代理官方 worldstate（/api/wf/worldstate）
//
// 免费版额度：100,000 请求/天，单次 10ms CPU。个人使用足够。
// 部署：Cloudflare Dashboard → Workers & Pages → Create → Worker
//       粘贴本文件 → Deploy → 打开 https://<名字>.<子域>.workers.dev/
//
// 如果仓库不是 CheckCheats/navigation-web，改下面的 REPO / BRANCH。

const REPO = 'CheckCheats/navigation-web';
const BRANCH = 'main';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
const MARKET_API = 'https://api.warframe.market/v2';
const OFFICIAL_WS = 'https://api.warframe.com/cdn/worldState.php';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type,accept',
  'Access-Control-Max-Age': '86400',
};

const MIME = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  cmd: 'text/plain; charset=utf-8',
};

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

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS,
      ...extra,
    },
  });
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

  const onlineSells = sells.filter((o) => o.status !== 'offline');
  const onlineBuys = buys.filter((o) => o.status !== 'offline');

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

async function withCache(request, ctx, force, producer) {
  const cache = caches.default;
  const cacheUrl = new URL(request.url);
  cacheUrl.searchParams.delete('force');
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  if (!force) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const response = await producer();
  if (response.ok && ctx && ctx.waitUntil) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}

async function serveStatic(request, url) {
  let path = url.pathname;
  if (path === '/' || path === '') path = '/index.html';
  if (path.includes('..')) {
    return new Response('forbidden', { status: 403 });
  }
  const ext = (path.split('.').pop() || '').toLowerCase();
  const upstream = await fetch(`${RAW_BASE}${path}`, {
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!upstream.ok) {
    return new Response('not found', { status: upstream.status });
  }
  const headers = new Headers();
  headers.set('content-type', MIME[ext] || upstream.headers.get('content-type') || 'application/octet-stream');
  headers.set('cache-control', 'public, max-age=300');
  return new Response(upstream.body, { status: upstream.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ ok: false, error: 'method not allowed' }, 405);
    }

    try {
      if (url.pathname === '/api/health') {
        return json({ ok: true, service: 'warframe-pe-worker', time: new Date().toISOString() });
      }

      if (url.pathname === '/api/wf/orders') {
        const slug = String(url.searchParams.get('slug') || '').trim();
        if (!/^[a-z0-9_-]{1,120}$/i.test(slug)) {
          return json({ ok: false, error: 'invalid slug' }, 400);
        }
        const force = url.searchParams.get('force') === '1';
        return await withCache(request, ctx, force, async () => {
          const upstream = await fetch(`${MARKET_API}/orders/item/${encodeURIComponent(slug)}`, {
            headers: {
              Accept: 'application/json',
              Language: 'zh-hans',
              Platform: 'pc',
              'User-Agent': 'warframe-pe-worker/1.0',
            },
            cf: { cacheTtl: 20, cacheEverything: true },
          });
          if (!upstream.ok) throw new Error(`市场上游 HTTP ${upstream.status}`);
          const raw = await upstream.json();
          return json(normalizeOrders(slug, raw), 200, { 'cache-control': 'public, max-age=25' });
        });
      }

      if (url.pathname === '/api/wf/worldstate') {
        const force = url.searchParams.get('force') === '1';
        return await withCache(request, ctx, force, async () => {
          const upstream = await fetch(OFFICIAL_WS, {
            headers: {
              Accept: 'application/json',
              'User-Agent': 'warframe-pe-worker/1.0',
            },
            cf: { cacheTtl: 20, cacheEverything: true },
          });
          if (!upstream.ok) throw new Error(`worldstate 上游 HTTP ${upstream.status}`);
          const text = await upstream.text();
          const raw = JSON.parse(text);
          return json(buildWorldstate(raw), 200, { 'cache-control': 'public, max-age=30' });
        });
      }

      if (url.pathname.startsWith('/api/')) {
        return json({ ok: false, error: 'unknown api' }, 404);
      }

      return await serveStatic(request, url);
    } catch (err) {
      return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502);
    }
  },
};
