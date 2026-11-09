'use strict';
// finance-api.js — 내 금융상품 한눈에: 계좌·시중 상품·주식 보유·배당·매도 (work-graph.json의 배열 다섯 개)
// dashboard-api.js가 라우트를 넘긴다. 계산(이자·세금)은 화면(dashboard.html FIN)에서 하고, 여기서는
//  - 항목 추가·수정·삭제 (POST /api/fin)
//  - 시중 금리(금융감독원 '금융상품 한눈에' 오픈 API — 인증키가 있을 때)와 주가·환율(Yahoo Finance) 가져오기 (POST /api/fin/refresh)
//  - 하루 한 번 자동 갱신, 만기 알림 날짜가 되면 Requests에 알림
// 을 맡는다. 설정·마지막 갱신·보낸 알림은 .ana/finance.json(사람의 데이터가 아니라 운영 기록).

const fs = require('node:fs');
const crypto = require('node:crypto');

const LISTS = {
  accounts: { prefix: 'acc', fields: { kind: ['deposit', 'savings', 'parking', 'cma'], bank: 60, name: 120, amount: 'num', rate: 'num', compound: ['simple', 'monthly'],
    start: 'date', maturity: 'date', tax: ['normal', 'preferential', 'exempt'], alerts: 'days', product: 40, memo: 500 } },
  products: { prefix: 'prd', fields: { kind: ['deposit', 'savings', 'parking', 'cma'], bank: 60, name: 120, months: 'num', rate: 'num', maxRate: 'num', source: ['fss', 'manual'], code: 60, at: 40 } },
  holdings: { prefix: 'hld', fields: { market: ['KR', 'US'], symbol: 30, name: 120, qty: 'num', avg: 'num', price: 'num', currency: 6, fx: 'num', priceAt: 40 } },
  dividends: { prefix: 'div', fields: { holding: 40, date: 'date', amount: 'num', memo: 200 } },
  sales: { prefix: 'sal', fields: { holding: 40, date: 'date', qty: 'num', buy: 'num', sell: 'num', memo: 200 } },
};
const KIND_KO = { deposit: '정기예금', savings: '적금', parking: '파킹통장', cma: 'CMA' };
const DEFAULT_ALERTS = [30, 7, 0];

function clean(list, src, base) {
  const out = { ...(base || {}) };
  for (const [k, t] of Object.entries(LISTS[list].fields)) {
    if (!(k in src)) continue;
    const v = src[k];
    if (v === null || v === '') { delete out[k]; continue; }
    if (Array.isArray(t)) { if (t.includes(v)) out[k] = v; else throw new Error(`${k} must be ${t.join('|')}`); }
    else if (t === 'num') { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${k} must be a number`); out[k] = n; }
    else if (t === 'date') { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new Error(`${k} must be YYYY-MM-DD`); out[k] = String(v); }
    else if (t === 'days') { const a = (Array.isArray(v) ? v : String(v).split(/[,\s]+/)).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 365); out[k] = [...new Set(a)].sort((x, y) => y - x); }
    else out[k] = String(v).slice(0, t);
  }
  return out;
}

const today = (d = new Date()) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);   // 한국 시간 기준 날짜
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400e3);
const monthsOf = (a) => (a.start && a.maturity ? Math.max(1, Math.round(daysBetween(a.start, a.maturity) / 30.4)) : 0);

// 만기가 다가온 계좌에 권할 상품: 같은 갈래(예금/적금), 기간이 비슷하고(±3개월) 금리가 더 높은 것 중 가장 높은 것
function betterProduct(a, products) {
  const m = monthsOf(a);
  const rate = (p) => Number(p.rate) || 0;
  return (products || []).filter((p) => p.kind === a.kind && rate(p) > (Number(a.rate) || 0) && (!m || !p.months || Math.abs(p.months - m) <= 3))
    .sort((x, y) => rate(y) - rate(x))[0] || null;
}

async function getJson(url, ms = 15000) {
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (ANA)' }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function yahooPrice(symbol) {
  const j = await getJson(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`);
  const m = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
  if (!m || !Number.isFinite(m.regularMarketPrice)) throw new Error('no price');
  return { price: m.regularMarketPrice, currency: m.currency || '' };
}
// 국내 종목은 6자리 코드면 코스피(.KS) 다음 코스닥(.KQ)
async function quote(h) {
  const s = String(h.symbol || '').trim().toUpperCase();
  if (!s) throw new Error('no symbol');
  if (h.market === 'KR' && /^\d{6}$/.test(s)) { try { return await yahooPrice(s + '.KS'); } catch { return yahooPrice(s + '.KQ'); } }
  return yahooPrice(s);
}
// 금융감독원 금융상품 한눈에 — 은행(020000)·저축은행(030300)의 정기예금·적금
async function fssProducts(key) {
  const out = [];
  for (const [api, kind] of [['depositProductsSearch', 'deposit'], ['savingProductsSearch', 'savings']]) {
    for (const grp of ['020000', '030300']) {
      const j = await getJson(`https://finlife.fss.or.kr/finlifeapi/${api}.json?auth=${encodeURIComponent(key)}&topFinGrpNo=${grp}&pageNo=1`, 20000);
      const r = j && j.result;
      if (!r || (r.err_cd && r.err_cd !== '000')) throw new Error((r && r.err_msg) || 'bad response');
      const base = new Map((r.baseList || []).map((b) => [b.fin_prdt_cd, b]));
      for (const o of r.optionList || []) {
        const b = base.get(o.fin_prdt_cd); if (!b) continue;
        if (kind === 'savings' && o.rsrv_type_nm && !/정액/.test(o.rsrv_type_nm)) continue;   // 적금은 정액적립식만(자유적립식은 계산이 다르다)
        out.push({ kind, bank: b.kor_co_nm, name: b.fin_prdt_nm, months: Number(o.save_trm) || 0, rate: Number(o.intr_rate) || 0, maxRate: Number(o.intr_rate2) || 0,
          code: `${o.fin_prdt_cd}-${o.save_trm}-${o.intr_rate_type || ''}`, compound: o.intr_rate_type === 'M' ? 'monthly' : 'simple' });
      }
    }
  }
  return out;
}

function createFinance({ loadData, saveData, loadRequests, saveRequests, metaFile, audit, plainFields, curWs }) {
  const newId = (p) => p + '-' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const loadMeta = () => { try { return JSON.parse(fs.readFileSync(metaFile, 'utf8')) || {}; } catch { return {}; } };
  const saveMeta = (m) => { try { fs.writeFileSync(metaFile + '.tmp', JSON.stringify(m, null, 2)); fs.renameSync(metaFile + '.tmp', metaFile); } catch {} };
  let broadcast = () => {};
  let refreshing = null;

  function commit(s) { s.version = (s.version || 1) + 1; saveData(s); broadcast({ kind: 'data', version: s.version }); return s.version; }

  async function refresh(by) {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const meta = loadMeta(), log = {};
      const s = loadData();
      // 주가·환율
      const fx = { KRW: 1 };
      let ok = 0, bad = [];
      for (const h of s.holdings) {
        try {
          const q = await quote(h);
          const cur = (q.currency || h.currency || (h.market === 'KR' ? 'KRW' : 'USD')).toUpperCase();
          if (!(cur in fx)) fx[cur] = (await yahooPrice(`${cur}KRW=X`)).price;
          h.price = q.price; h.currency = cur; h.fx = fx[cur]; h.priceAt = new Date().toISOString(); ok++;
        } catch (e) { bad.push(`${h.symbol}: ${e.message}`); }
      }
      log.prices = s.holdings.length ? `${ok}/${s.holdings.length} 종목${bad.length ? ' — 실패: ' + bad.join(', ') : ''}` : '보유 종목 없음';
      // 시중 금리
      const key = process.env.FSS_API_KEY || meta.fssKey || '';
      if (!key) log.rates = '인증키 없음 — 직접 입력한 상품만';
      else {
        try {
          const got = await fssProducts(key), at = new Date().toISOString();
          const manual = s.products.filter((p) => p.source !== 'fss');
          const old = new Map(s.products.filter((p) => p.source === 'fss').map((p) => [p.code, p]));
          s.products = manual.concat(got.map((p) => ({ id: (old.get(p.code) || {}).id || newId('prd'), ...p, source: 'fss', at })));
          log.rates = `${got.length}개 상품`;
        } catch (e) { log.rates = `실패: ${e.message}`; }
      }
      commit(s);
      meta.lastRefresh = today(); meta.lastAt = new Date().toISOString(); meta.log = log; saveMeta(meta);
      audit(by || 'ana', 'fin.refresh', `${log.prices} · ${log.rates}`.slice(0, 120));
      return { ok: true, at: meta.lastAt, log };
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  // 만기 알림: 알림 날짜(만기 N일 전)에 들어선 계좌마다 한 번씩 Requests에 올린다(놓친 날이 있어도 가장 가까운 것 하나만)
  function checkAlerts() {
    let s; try { s = loadData(); } catch { return 0; }
    const meta = loadMeta(), sent = meta.alerts || {}, t = today();
    const rq = loadRequests(); let n = 0;
    for (const a of s.accounts) {
      if (!a.maturity || a.kind === 'parking' || a.kind === 'cma') continue;
      const d = daysBetween(t, a.maturity); if (d < 0) continue;
      const due = (a.alerts || DEFAULT_ALERTS).filter((x) => d <= x).sort((x, y) => x - y)[0];
      if (due === undefined) continue;
      const k = `${a.id}:${a.maturity}:${due}`; if (sent[k]) continue;
      sent[k] = t;
      const best = betterProduct(a, s.products);
      const label = `${a.bank || ''} ${a.name || KIND_KO[a.kind] || ''}`.trim();
      const title = d === 0 ? `오늘 만기: ${label}` : `만기 ${d}일 전: ${label}`;
      const r = { id: rq.next++, kind: 'action', title, desc: '', options: ['재예치함', '해지함', '나중에'], ref: a.id, ws: curWs(), status: 'open', answer: '', at: new Date().toISOString(),
        ...plainFields({ why: `${label}이(가) ${a.maturity}에 만기예요 (연 ${a.rate}%).`,
          ask: best ? `만기 후 어디에 둘지 정해 주세요. 지금 더 높은 상품: ${best.bank} ${best.name} 연 ${best.rate}%${best.months ? ` (${best.months}개월)` : ''}.` : '만기 후 어디에 둘지 정해 주세요.',
          effect: '정하신 대로 계좌 정보를 고쳐 둘게요(바꾸기 전에 확인받아요).', ifNot: '만기 후에는 보통 낮은 만기 후 이율이 붙어요.' }) };
      rq.requests.push(r); n++;
    }
    meta.alerts = sent; saveMeta(meta);
    if (n) { rq.version = (rq.version || 1) + 1; saveRequests(rq); broadcast({ kind: 'requests', version: rq.version }); }
    return n;
  }

  function tick() {
    try { if (loadMeta().lastRefresh !== today()) refresh('ana').catch(() => {}); } catch {}
    try { checkAlerts(); } catch {}
  }
  function start() { setTimeout(tick, 5000).unref(); setInterval(tick, 3600e3).unref(); }

  async function route(req, res, p, ctx) {
    const { csrfOk, jsonBody, sendJson, actor } = ctx;
    if (ctx.broadcast) broadcast = ctx.broadcast;
    if (p === '/api/fin/meta' && req.method === 'GET') {
      const m = loadMeta();
      return sendJson(res, 200, { lastAt: m.lastAt || '', log: m.log || {}, hasKey: !!(process.env.FSS_API_KEY || m.fssKey) }), true;
    }
    if (!p.startsWith('/api/fin') || req.method !== 'POST') return false;
    if (!csrfOk(req)) return sendJson(res, 403, { error: 'forbidden (origin/content-type)' }), true;
    const body = await jsonBody(req, res); if (!body) return true;
    if (p === '/api/fin/refresh') { try { return sendJson(res, 200, await refresh(actor(req))), true; } catch (e) { return sendJson(res, 500, { error: e.message }), true; } }
    if (p === '/api/fin/settings') {
      const m = loadMeta();
      if (typeof body.fssKey === 'string') m.fssKey = body.fssKey.trim().slice(0, 100);
      saveMeta(m); return sendJson(res, 200, { ok: true, hasKey: !!m.fssKey }), true;
    }
    if (p !== '/api/fin') return sendJson(res, 404, { error: 'not found' }), true;
    const list = body.list;
    if (!LISTS[list]) return sendJson(res, 400, { error: `list must be ${Object.keys(LISTS).join('|')}` }), true;
    let s; try { s = loadData(); } catch (e) { return sendJson(res, 500, { error: 'state file corrupt', detail: e.message }), true; }
    const arr = s[list];
    let id;
    try {
      if (body.action === 'add') {
        const x = clean(list, body.item || {}); x.id = newId(LISTS[list].prefix); if (list === 'products' && !x.source) x.source = 'manual';
        arr.push(x); id = x.id;
      } else if (body.action === 'update') {
        const i = arr.findIndex((x) => x.id === body.id); if (i < 0) return sendJson(res, 404, { error: 'not found' }), true;
        arr[i] = clean(list, body.item || {}, arr[i]); id = body.id;
      } else if (body.action === 'remove') {
        const i = arr.findIndex((x) => x.id === body.id); if (i < 0) return sendJson(res, 404, { error: 'not found' }), true;
        arr.splice(i, 1); id = body.id;
        if (list === 'holdings') { s.dividends = s.dividends.filter((x) => x.holding !== id); s.sales = s.sales.filter((x) => x.holding !== id); }
      } else return sendJson(res, 400, { error: 'action must be add|update|remove' }), true;
    } catch (e) { return sendJson(res, 400, { error: e.message }), true; }
    audit(actor(req), `fin.${list}.${body.action}`, id);
    const version = commit(s);
    if (list === 'accounts') try { checkAlerts(); } catch {}
    return sendJson(res, 200, { ok: true, id, version }), true;
  }

  return { route, start, refresh, checkAlerts };
}

module.exports = { createFinance, betterProduct, LISTS, today, daysBetween };
