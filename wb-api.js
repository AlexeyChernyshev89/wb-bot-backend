// wb-api.js — интеграция с официальным WB Marketplace API
// Документация: https://dev.wildberries.ru
// Базовый хост: marketplace-api.wildberries.ru
// Авторизация: Authorization: Bearer <token>
// Лимит: 300 запросов/минуту для категории Marketplace

const axios  = require('axios');
const dns    = require('dns');
const https  = require('https');

// Принудительный IPv4 для WB API — Railway EU использует IPv6 по умолчанию,
// но WB API (marketplace-api.wildberries.ru) не принимает IPv6.
function _ipv4Lookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, family: 4 }, callback);
}
const WB_AGENT = new https.Agent({ lookup: _ipv4Lookup, keepAlive: false });
console.log('[wb-api] IPv4-only HTTPS agent initialized');

const WB_MARKETPLACE_API = 'https://marketplace-api.wildberries.ru';
const WB_CONTENT_API     = 'https://content-api.wildberries.ru';
const WB_STATISTICS_API  = 'https://statistics-api.wildberries.ru';
// Новый Analytics API (ENOTFOUND с Railway EU — используем через Windows-прокси)
const WB_ANALYTICS_API   = 'https://seller-analytics-api.wildberries.ru';

// Windows-прокси URL (ngrok / Cloudflare Tunnel)
// Все вызовы к analytics-api.wildberries.ru идут через него
function getProxyUrl() {
  return process.env.YANDEX_FN_URL || '';
}

/**
 * Базовый HTTP-клиент для WB API с обработкой ошибок.
 */
async function apiRequest(method, baseUrl, path, token, data = null, params = null) {
  try {
    const response = await axios({
      method,
      url: `${baseUrl}${path}`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data,
      params,
      timeout: 15000,
      httpsAgent: WB_AGENT,
    });
    return response.data;
  } catch (error) {
    const status  = error.response?.status;
    const detail  = error.response?.data?.detail || error.response?.data?.message || error.message;
    console.error(`❌ WB API [${method} ${path}] ${status}:`, detail);
    const err = new Error(detail || 'Ошибка WB API');
    err.status = status;
    err.wbDetail = detail;
    throw err;
  }
}

// ─── Склады ───────────────────────────────────────────────────────────────────

/**
 * Получить список складов продавца.
 * GET /api/v3/warehouses
 */
async function getWarehouses(token) {
  return apiRequest('GET', WB_MARKETPLACE_API, '/api/v3/warehouses', token);
}

// ─── Остатки ──────────────────────────────────────────────────────────────────

/**
 * Получить остатки товаров на складе продавца по списку SKU.
 * POST /api/v3/stocks/{warehouseId}
 */
async function getStocks(token, warehouseId, skus) {
  if (!Array.isArray(skus) || skus.length === 0) {
    throw new Error('Список SKU не может быть пустым');
  }
  if (skus.length <= 1000) {
    return apiRequest('POST', WB_MARKETPLACE_API, `/api/v3/stocks/${warehouseId}`, token, { skus });
  }
  const results = { stocks: [] };
  for (let i = 0; i < skus.length; i += 1000) {
    const batch = skus.slice(i, i + 1000);
    const res = await apiRequest('POST', WB_MARKETPLACE_API, `/api/v3/stocks/${warehouseId}`, token, { skus: batch });
    results.stocks.push(...(res.stocks || []));
  }
  return results;
}

async function updateStocks(token, warehouseId, stocks) {
  if (!Array.isArray(stocks) || stocks.length === 0) throw new Error('Список остатков не может быть пустым');
  if (stocks.length <= 1000) return apiRequest('PUT', WB_MARKETPLACE_API, `/api/v3/stocks/${warehouseId}`, token, { stocks });
  for (let i = 0; i < stocks.length; i += 1000) {
    await apiRequest('PUT', WB_MARKETPLACE_API, `/api/v3/stocks/${warehouseId}`, token, { stocks: stocks.slice(i, i + 1000) });
  }
  return { success: true };
}

async function deleteStocks(token, warehouseId, skus) {
  return apiRequest('DELETE', WB_MARKETPLACE_API, `/api/v3/stocks/${warehouseId}`, token, { skus });
}

// ─── Карточки товаров ─────────────────────────────────────────────────────────

async function getCardsList(token, cursor = null, limit = 100) {
  const body = {
    settings: {
      cursor: cursor ? { updatedAt: cursor.updatedAt, nmID: cursor.nmID } : {},
      filter: { withPhoto: -1 },
    },
  };
  return apiRequest('POST', WB_CONTENT_API, '/content/v2/get/cards/list', token, body);
}

async function getAllCards(token) {
  const allCards = [];
  let cursor = null;
  while (true) {
    const response = await getCardsList(token, cursor, 100);
    const cards = response?.cards || [];
    allCards.push(...cards);
    if (!response?.cursor || cards.length < 100) break;
    cursor = response.cursor;
  }
  return allCards;
}

function extractSkusFromCards(cards) {
  const skus = [];
  for (const card of cards) {
    for (const size of (card.sizes || [])) {
      for (const sku of (size.skus || [])) {
        if (sku) skus.push(sku);
      }
    }
  }
  return [...new Set(skus)];
}

async function getArticleByNmId(token, nmId) {
  const target = parseInt(nmId);
  const filters = [
    { nmIDs: [target], withPhoto: -1 },
    { textSearch: String(nmId), withPhoto: -1 },
  ];

  for (const filter of filters) {
    try {
      const response = await apiRequest('POST', WB_CONTENT_API, '/content/v2/get/cards/list', token, {
        settings: { cursor: { limit: 100 }, filter },
      });
      const cards = response?.cards || [];
      console.log(`[article search] filter=${JSON.stringify(filter)} cards=${cards.length}`);
      const card = cards.find(c => c.nmID === target);
      if (card) {
        const skus = extractSkusFromCards([card]);
        const name = card.title || card.subjectName || `Артикул ${nmId}`;
        console.log(`[article search] found: nmID=${card.nmID} name="${name}" skus=${skus.length}`);
        return { nmId: target, name, skus };
      }
    } catch (err) {
      console.error(`[article search] filter attempt failed:`, err.message);
    }
  }

  console.warn(`[article search] nmId ${nmId} not found in seller catalog`);
  return null;
}

// ─── Кеш FBO остатков ────────────────────────────────────────────────────────
// Новый Analytics API лимит: 1 запрос / 20 секунд → кеш 10 минут более чем достаточно
const _fboCache = { data: null, ts: 0, key: '' };
const FBO_CACHE_TTL = 10 * 60 * 1000; // 10 минут
let _fboInflight = null;

/**
 * Вызов нового Analytics API через Windows-прокси (/wb-call).
 * analytics-api.wildberries.ru недоступен с Railway EU (DNS ENOTFOUND),
 * но доступен с Windows IP через ngrok/Cloudflare Tunnel.
 */
async function analyticsViaProxy(token, body) {
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) {
    throw new Error('YANDEX_FN_URL не задан — Windows-прокси недоступен');
  }
  const res = await axios.post(
    `${proxyUrl}/wb-call`,
    {
      url:      `${WB_ANALYTICS_API}/api/analytics/v1/stocks-report/wb-warehouses`,
      method:   'POST',
      token,
      body,
      authType: 'bearer',   // Analytics API принимает только Authorization: Bearer
    },
    {
      timeout: 30000,
      validateStatus: () => true,
      // ngrok free-план показывает HTML-предупреждение без этого заголовка
      headers: { 'ngrok-skip-browser-warning': 'true', 'User-Agent': 'wb-bot-backend' },
    }
  );

  // Если ngrok вернул HTML (502/предупреждение) — res.data будет строкой
  if (typeof res.data === 'string' && res.data.includes('<!DOCTYPE html>')) {
    const err = new Error('Прокси недоступен (ngrok вернул HTML вместо JSON — проверьте что proxy.js запущен на Windows)');
    err.status = 502;
    throw err;
  }

  // /wb-call возвращает { status: N, data: <wb_response> }
  const wbStatus = res.data?.status ?? res.status;
  const wbBody   = res.data?.data   ?? res.data;
  console.log(`[FBO stocks] Analytics via proxy → HTTP ${wbStatus} | ${JSON.stringify(wbBody).substring(0, 80)}`);

  if (wbStatus !== 200) {
    const err = new Error(`Analytics proxy HTTP ${wbStatus}: ${JSON.stringify(wbBody).substring(0, 100)}`);
    err.status = wbStatus;
    throw err;
  }

  // Новый Analytics API: { data: { items: [ {nmId, warehouseName, quantity, ...} ] } }
  // Возможные структуры: data.items, data.data, data.stocks, или массив напрямую
  const items =
    wbBody?.data?.items ||
    wbBody?.items ||
    wbBody?.data?.data ||
    wbBody?.data ||
    wbBody?.stocks ||
    (Array.isArray(wbBody) ? wbBody : []);
  return Array.isArray(items) ? items : [];
}

/**
 * Прямой вызов Analytics API (на случай если Railway когда-нибудь починит DNS).
 */
async function analyticsDirectly(token, body) {
  const response = await apiRequest('POST', WB_ANALYTICS_API,
    '/api/analytics/v1/stocks-report/wb-warehouses', token, body);
  const items =
    response?.data?.items ||
    response?.items ||
    response?.data?.data ||
    response?.data ||
    response?.stocks ||
    (Array.isArray(response) ? response : []);
  return Array.isArray(items) ? items : [];
}

/**
 * Нормализует строки Statistics API в единый формат.
 * Statistics возвращает: { nmId, warehouseName, quantity, quantityFull, ... }
 * Analytics возвращает:  { nmId, warehouseName, quantity, warehouseId, ... }
 * Формат совпадает — нормализация минимальная.
 */
function normalizeStocksRow(row) {
  return {
    nmId:          row.nmId          || row.nmID          || 0,
    warehouseName: row.warehouseName || row.officeName     || '',
    warehouseId:   row.warehouseId   || row.warehouseID   || null,
    quantity:      row.quantity      ?? row.qty            ?? 0,
    quantityFull:  row.quantityFull  ?? row.quantityTotal  ?? 0,
  };
}

/**
 * Получить FBO-остатки по всем складам WB.
 *
 * Порядок источников (от лучшего к худшему):
 *   1. Новый Analytics API через Windows-прокси — лимит 1/20с, 250 000 строк
 *   2. Новый Analytics API напрямую — на случай если Railway починит DNS
 *   3. Statistics API (старый) — умирает 23.06.2026, лимит 1/мин
 *   4. Statistics API через session JWT — когда публичный токен заблокирован 429
 *
 * Кеш 10 минут + дедупликация inflight-запросов.
 */
async function getFboStocksRaw(token, nmIds = null, sessionToken = null, sessionCookies = null) {
  const cacheKey = token ? token.substring(0, 20) : '';
  const now = Date.now();

  // Возвращаем кеш если свежий
  if (_fboCache.data && _fboCache.key === cacheKey && now - _fboCache.ts < FBO_CACHE_TTL) {
    const rows = _fboCache.data;
    console.log(`[FBO stocks] Cache hit: ${rows.length} строк`);
    return nmIds ? rows.filter(r => nmIds.includes(r.nmId)) : rows;
  }

  // Ждём если запрос уже летит (дедупликация)
  if (_fboInflight) {
    console.log(`[FBO stocks] Waiting for inflight request...`);
    const rows = await _fboInflight;
    return nmIds ? rows.filter(r => nmIds.includes(r.nmId)) : rows;
  }

  const analyticsBody = { pagination: { limit: 250000, offset: 0 } };
  if (nmIds && nmIds.length > 0) analyticsBody.filter = { nmIDs: nmIds };

  _fboInflight = (async () => {
    try {

      // ── Источник 1: Analytics API через Windows-прокси ──────────────────────
      try {
        const rows = await analyticsViaProxy(token, analyticsBody);
        const normalized = rows.map(normalizeStocksRow);
        console.log(`[FBO stocks] ✅ Analytics API (proxy): ${normalized.length} строк`);
        _fboCache.data = normalized; _fboCache.ts = Date.now(); _fboCache.key = cacheKey;
        return normalized;
      } catch (proxyErr) {
        console.warn(`[FBO stocks] Analytics proxy failed: ${proxyErr.message} → trying direct...`);
      }

      // ── Источник 2: Analytics API напрямую (Railway DNS может починить) ─────
      try {
        const rows = await analyticsDirectly(token, analyticsBody);
        const normalized = rows.map(normalizeStocksRow);
        console.log(`[FBO stocks] ✅ Analytics API (direct): ${normalized.length} строк`);
        _fboCache.data = normalized; _fboCache.ts = Date.now(); _fboCache.key = cacheKey;
        return normalized;
      } catch (directErr) {
        if (directErr.message && directErr.message.includes('ENOTFOUND')) {
          console.warn(`[FBO stocks] Analytics direct ENOTFOUND → Statistics API...`);
        } else {
          console.warn(`[FBO stocks] Analytics direct failed (${directErr.message}) → Statistics API...`);
        }
      }

      // ── Источник 3: Statistics API (устаревший, умирает 23.06.2026) ─────────
      let statsErr429 = false;
      try {
        const data = await apiRequest('GET', WB_STATISTICS_API,
          '/api/v1/supplier/stocks?dateFrom=2019-01-01', token);
        const rows = (Array.isArray(data) ? data : []).map(normalizeStocksRow);
        console.log(`[FBO stocks] ✅ Statistics API: ${rows.length} строк`);
        _fboCache.data = rows; _fboCache.ts = Date.now(); _fboCache.key = cacheKey;
        return rows;
      } catch (statErr) {
        statsErr429 = statErr.status === 429 || (statErr.message || '').includes('429');
        if (!statsErr429) {
          // Не 429 — значит нет прав или другая критическая ошибка
          throw new Error('Нет доступа к остаткам. Добавьте категорию «Аналитика» в токен WB.');
        }
        console.warn(`[FBO stocks] Statistics 429 → trying via session JWT...`);
      }

      // ── Источник 4: Statistics API через сессионный JWT ──────────────────────
      if (statsErr429 && sessionToken && sessionToken.startsWith('eyJhbGciOiJSUzI1NiIs')) {
        try {
          const res = await axios.get(
            `${WB_STATISTICS_API}/api/v1/supplier/stocks?dateFrom=2019-01-01`,
            {
              headers: { 'Authorizev3': sessionToken, 'Accept': 'application/json' },
              validateStatus: () => true,
              timeout: 15000,
            }
          );
          if (res.status === 200 && Array.isArray(res.data)) {
            const rows = res.data.map(normalizeStocksRow);
            console.log(`[FBO stocks] ✅ Statistics via session JWT: ${rows.length} строк`);
            _fboCache.data = rows; _fboCache.ts = Date.now(); _fboCache.key = cacheKey;
            return rows;
          }
          console.warn(`[FBO stocks] Statistics session JWT → ${res.status}`);
        } catch (e) {
          console.warn(`[FBO stocks] Statistics session JWT error: ${e.message}`);
        }
      }

      // ── Все источники недоступны — возвращаем кеш если есть ─────────────────
      if (_fboCache.data && _fboCache.key === cacheKey) {
        console.warn(`[FBO stocks] Все источники недоступны → возвращаем устаревший кеш (${Math.round((Date.now() - _fboCache.ts) / 60000)} мин)`);
        return _fboCache.data;
      }

      console.error(`[FBO stocks] Все источники недоступны, кеша нет`);
      throw new Error('Остатки временно недоступны. Попробуйте позже.');

    } finally {
      _fboInflight = null;
    }
  })();

  const rows = await _fboInflight;
  return nmIds ? rows.filter(r => nmIds.includes(r.nmId)) : rows;
}

/**
 * Получить список уникальных WB FBO складов.
 */
async function getWbFboWarehouseNames(token, sessionToken = null, sessionCookies = null) {
  try {
    const allStocks = await getFboStocksRaw(token, null, sessionToken, sessionCookies);
    const rows = Array.isArray(allStocks) ? allStocks : [];
    const excluded = ['в пути', 'in transit', 'возврат', 'return', 'к клиенту', 'от клиента'];
    const names = new Set();
    for (const item of rows) {
      const wh = (item.warehouseName || '').trim();
      if (!wh) continue;
      const isSystem = excluded.some(ex => wh.toLowerCase().includes(ex));
      if (!isSystem) names.add(wh);
    }
    return [...names].sort((a, b) => a.localeCompare(b, 'ru'));
  } catch (err) {
    console.warn('[getWbFboWarehouseNames] error:', err.message);
    return [];
  }
}

/**
 * Получить склады с ненулевыми FBO-остатками для конкретного артикула.
 * Возвращает: { article: { nmId, name }, warehouses: [{ name, amount }], source }
 */
async function getArticleStocks(token, nmId, sessionToken, sessionCookies = null) {
  const target = parseInt(nmId);
  const article = await getArticleByNmId(token, nmId);

  // === Попытка 1: Transfer API (seller-supply) ===
  if (sessionToken) {
    try {
      const resp = await sellerSupplyPost(sessionToken, '/list', {}, sessionCookies);
      const transfers = resp?.result?.transfers || [];
      const item = transfers.find(t => t.nmID === target);
      if (item && item.chrts) {
        const byWarehouse = {};
        for (const c of item.chrts) {
          const name = c.warehouseName || `Склад ${c.warehouseID}`;
          byWarehouse[name] = (byWarehouse[name] || 0) + (c.count || 0);
        }
        const warehouses = Object.entries(byWarehouse)
          .map(([name, amount]) => ({ name, amount }))
          .filter(w => w.amount > 0)
          .sort((a, b) => b.amount - a.amount);
        console.log(`[stocks] Transfer API: nmId=${nmId} в ${warehouses.length} складах`);
        return { article: article || { nmId: target, name: `Артикул ${nmId}`, skus: [] }, warehouses, source: 'transfer_api' };
      }
      console.log(`[stocks] Transfer API: nmId=${nmId} не найден в transfer/list`);
    } catch (e) {
      console.warn('[stocks] Transfer API failed:', e.message);
    }
  }

  // === Попытка 2: FBO через новый Analytics API (или Statistics fallback) ===
  try {
    const allStocks = await getFboStocksRaw(token, [target], sessionToken, sessionCookies);
    const rows = Array.isArray(allStocks) ? allStocks : [];
    console.log(`[stocks] FBO API: total rows=${rows.length}`);
    const byWarehouse = {};
    for (const item of rows) {
      if (item.nmId !== target) continue;
      const qty = item.quantity || 0;
      if (qty <= 0) continue;
      const wh = item.warehouseName;
      if (!wh) continue;
      byWarehouse[wh] = (byWarehouse[wh] || 0) + qty;
    }
    const warehouses = Object.entries(byWarehouse)
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount);
    console.log(`[stocks] FBO API: nmId=${nmId} в ${warehouses.length} складах`);
    return {
      article: article || { nmId: target, name: `Артикул ${nmId}`, skus: [] },
      warehouses,
      source: 'analytics',
    };
  } catch (fboErr) {
    console.warn(`[stocks] FBO API failed: ${fboErr.message}`);
    if (!article || !article.skus.length) {
      const err = new Error(
        fboErr.status === 401 || fboErr.status === 403
          ? 'Нет доступа к Analytics API. Добавьте категорию «Аналитика» в токен WB.'
          : 'Не удалось получить остатки. Проверьте права токена.'
      );
      err.hint = 'analytics_token_required';
      throw err;
    }

    // === Fallback: Marketplace API FBS ===
    const allWarehouses = await getWarehouses(token);
    const result = [];
    for (let i = 0; i < allWarehouses.length; i += 5) {
      const batch = allWarehouses.slice(i, i + 5);
      await Promise.all(batch.map(async wh => {
        try {
          const stocks = await getStocks(token, wh.id, article.skus);
          const total = (stocks.stocks || []).reduce((s, x) => s + (x.amount || 0), 0);
          if (total > 0) result.push({ id: wh.id, name: wh.name, amount: total });
        } catch {}
      }));
    }
    result.sort((a, b) => b.amount - a.amount);
    return { article, warehouses: result, source: 'marketplace_fallback' };
  }
}

// ─── seller-supply (внутренний WB API) ───────────────────────────────────────

const WB_SELLER_SUPPLY = 'https://seller-supply.wildberries.ru';
const TRANSFER_PATH    = '/ns/goods-return/supply-manager/api/v1/transfer';

/**
 * Базовый POST к внутреннему API seller-supply.wildberries.ru
 */
async function sellerSupplyPost(sessionToken, endpoint, body = {}, sessionCookies = null) {
  // Проверяем что токен — настоящий RS256 JWT, а не кука
  if (!sessionToken || !sessionToken.startsWith('eyJhbGciOiJSUzI1NiIs')) {
    const e = new Error('Сессия истекла. Авторизуйтесь снова через SMS в Mini App.');
    e.status = 401;
    e.sessionExpired = true;
    throw e;
  }

  try {
    const headers = {
      Authorizev3:      sessionToken,
      'Content-Type':   'application/json',
      Accept:           '*/*',
      Origin:           'https://seller.wildberries.ru',
      Referer:          'https://seller.wildberries.ru/stock-control',
      'User-Agent':     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language':'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    };
    if (sessionCookies) {
      headers['Cookie'] = sessionCookies;
      const hasSupplier = sessionCookies.includes('x-supplier-id');
      const hasZzatw    = sessionCookies.includes('__zzatw-wb');
      console.log(`[seller-supply] using cookies (len=${sessionCookies.length}, x-supplier-id=${hasSupplier}, __zzatw-wb=${hasZzatw}):`, sessionCookies.substring(0, 80));
      if (!hasSupplier) {
        console.warn('[seller-supply] ⚠️  x-supplier-id отсутствует в куках — seller-supply вернёт 401. Нужна повторная SMS авторизация.');
      }
    }
    const res = await axios.post(
      `${WB_SELLER_SUPPLY}${TRANSFER_PATH}${endpoint}`,
      body,
      { headers, timeout: 15000, validateStatus: () => true }
    );
    const bodyStr = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    console.log(`[seller-supply] ${endpoint} → HTTP ${res.status} | body: ${bodyStr.substring(0, 120)}`);

    if (res.status === 401 || res.status === 403) {
      // WB возвращает "incorrect supplier id" когда Authorizev3 — кука, а не JWT
      const wbMsg = typeof res.data === 'string' ? res.data : (res.data?.message || res.data?.error || '');
      const e = new Error(
        wbMsg.includes('incorrect supplier id')
          ? 'Сессия истекла (incorrect supplier id). Авторизуйтесь снова через SMS.'
          : `Сессия истекла (${res.status}). Авторизуйтесь снова через SMS.`
      );
      e.status = 401;
      e.sessionExpired = true;
      throw e;
    }
    return res.data;
  } catch (err) {
    if (err.sessionExpired) throw err;
    const status = err.response?.status;
    const detail = err.response?.data;
    console.error(`[seller-supply] ${endpoint} → ${status}:`, JSON.stringify(detail));
    const e = new Error(detail?.message || detail?.error || detail?.detail || `Ошибка seller-supply API ${status}`);
    e.status = status;
    e.wbDetail = detail;
    if (status === 401 || status === 403) e.sessionExpired = true;
    throw e;
  }
}

/**
 * Получить список складов с доступными лимитами для артикула.
 * POST /transfer/AvailableLimits
 */
async function getTransferAvailableLimits(sessionToken, nmId, sessionCookies = null) {
  return sellerSupplyPost(sessionToken, '/AvailableLimits', { nmId: Number(nmId) }, sessionCookies);
}

/**
 * Создать FBO-перемещение.
 * POST /transfer
 */
async function createWbTransfer(sessionToken, { nmId, fromOfficeId, toOfficeId, amount }) {
  return sellerSupplyPost(sessionToken, '', {
    nmId:         Number(nmId),
    fromOfficeId: Number(fromOfficeId),
    toOfficeId:   Number(toOfficeId),
    amount:       Number(amount),
  });
}

/**
 * Список текущих активных перемещений.
 * POST /transfer/list
 */
async function getWbTransferList(sessionToken) {
  return sellerSupplyPost(sessionToken, '/list', {});
}

module.exports = {
  getWarehouses, getStocks, updateStocks, deleteStocks,
  getCardsList, getAllCards, extractSkusFromCards,
  getArticleByNmId, getArticleStocks, getFboStocksRaw, getWbFboWarehouseNames,
  getTransferAvailableLimits, createWbTransfer, getWbTransferList,
};
