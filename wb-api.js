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
  let article = null;
  if (token) {
    try { article = await getArticleByNmId(token, nmId); }
    catch (e) { console.warn('[stocks] getArticleByNmId failed (нет токена/категории):', e.message); }
  }

  // === Попытка 1: Transfer API (seller-supply) ===
  if (sessionToken) {
    try {
      // sellerSupplyPost уже возвращает result; transfer/list требует nmIDs
      const resp = await getTransferStockByWarehouse(sessionToken, target, sessionCookies);
      const chrts = Array.isArray(resp) ? resp : [];
      if (chrts.length > 0) {
        const byWarehouse = {};
        for (const c of chrts) {
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
      console.log(`[stocks] Transfer API: nmId=${nmId} нет остатков в transfer/list`);
    } catch (e) {
      console.warn('[stocks] Transfer API failed:', e.message);
    }
  }

  // === Попытка 2: FBO через новый Analytics API (или Statistics fallback) ===
  if (!token) {
    // Без Analytics-токена FBO-фоллбэк недоступен — возвращаем что есть (обычно transfer_api покрывает).
    return { article: article || { nmId: target, name: `Артикул ${nmId}`, skus: [] }, warehouses: [], source: 'no_token' };
  }
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
// Supplier ID продавца. У КАЖДОГО пользователя свой — извлекаем из его
// собственных кук (wb-seller-lk JWT, поле Z-Sid) или из самого Authorizev3.
// НЕ используем глобальный ENV — это сломало бы мультипользовательность.
function getSupplierId(sessionCookies, sessionToken) {
  // 1. Если x-supplier-id уже есть в куках пользователя — берём оттуда
  if (sessionCookies) {
    const m = sessionCookies.match(/x-supplier-id=([0-9a-f-]{36})/i);
    if (m) return m[1];

    // 2. Извлекаем из wb-seller-lk JWT (поле Z-Sid) — он у каждого свой
    const lkMatch = sessionCookies.match(/wb-seller-lk=([^;]+)/);
    if (lkMatch) {
      try {
        const parts = lkMatch[1].split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
          if (payload?.data?.['Z-Sid']) return payload.data['Z-Sid'];
        }
      } catch {}
    }
  }

  // 3. Пытаемся достать из Authorizev3 JWT (некоторые версии содержат supplier_id)
  if (sessionToken) {
    try {
      const parts = sessionToken.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        const sid = payload?.supplier_id || payload?.sid || payload?.['Z-Sid'];
        if (sid) return sid;
      }
    } catch {}
  }

  return null;
}

async function sellerSupplyPost(sessionToken, endpoint, body = {}, sessionCookies = null) {
  // Проверяем что токен — настоящий RS256 JWT, а не кука
  if (!sessionToken || !sessionToken.startsWith('eyJhbGciOiJSUzI1NiIs')) {
    const e = new Error('Сессия истекла. Авторизуйтесь снова через SMS в Mini App.');
    e.status = 401;
    e.sessionExpired = true;
    throw e;
  }

  // Гарантируем наличие x-supplier-id в куках — без него seller-supply даёт 401.
  // Берём ID из кук/токена ИМЕННО ЭТОГО пользователя (мультипользовательность).
  let cookies = sessionCookies || '';
  if (!cookies.includes('x-supplier-id=')) {
    const supplierId = getSupplierId(cookies, sessionToken);
    if (supplierId) {
      cookies += `${cookies ? '; ' : ''}x-supplier-id=${supplierId}; x-supplier-id-external=${supplierId}`;
      console.log(`[seller-supply] ✅ x-supplier-id извлечён из данных пользователя: ${supplierId.substring(0, 12)}...`);
    } else {
      console.warn('[seller-supply] ⚠️  x-supplier-id не найден в куках/токене пользователя — нужна повторная SMS авторизация (прокси должен захватить wb-seller-lk)');
    }
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
    if (cookies) {
      headers['Cookie'] = cookies;
      const hasSupplier = cookies.includes('x-supplier-id');
      const hasZzatw    = cookies.includes('__zzatw-wb');
      console.log(`[seller-supply] using cookies (len=${cookies.length}, x-supplier-id=${hasSupplier}, __zzatw-wb=${hasZzatw}):`, cookies.substring(0, 80));
    }

    // WB seller-supply использует JSON-RPC 2.0, а не обычный REST.
    // Оборачиваем тело в RPC-конверт: { jsonrpc, id, params }
    const rpcId = `json-rpc_${Math.floor(Math.random() * 100000)}`;
    const rpcBody = { jsonrpc: '2.0', id: rpcId };
    if (body && Object.keys(body).length > 0) {
      rpcBody.params = body;
    }

    const res = await axios.post(
      `${WB_SELLER_SUPPLY}${TRANSFER_PATH}${endpoint}`,
      rpcBody,
      { headers, timeout: 15000, validateStatus: () => true }
    );
    const bodyStr = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    // Для /create логируем ПОЛНЫЙ ответ — критично для подтверждения реального перемещения
    const logLen = (endpoint === '/create' || endpoint === '/order') ? 600 : 150;
    console.log(`[seller-supply] ${endpoint} → HTTP ${res.status} | body: ${bodyStr.substring(0, logLen)}`);

    if (res.status === 401 || res.status === 403) {
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

    // JSON-RPC ошибка приходит в поле error
    if (res.data && typeof res.data === 'object' && res.data.error) {
      const rpcErr = res.data.error;
      const e = new Error(rpcErr.message || rpcErr.data?.msg || `JSON-RPC error ${rpcErr.code}`);
      e.status = res.status || 400;
      e.wbDetail = rpcErr.message || rpcErr.data?.msg;
      e.rpcError = rpcErr;
      e.isRpcError = true;
      // Распознаём ошибку капчи
      if (rpcErr.code === -32002 || /капч|captcha/i.test(rpcErr.message || '')) {
        e.captchaRequired = true;
      }
      throw e;
    }

    // Возвращаем result из JSON-RPC ответа (или весь body если структура иная)
    return res.data?.result ?? res.data;
  } catch (err) {
    if (err.sessionExpired || err.isRpcError) throw err; // не перезаписываем распознанные ошибки
    const status = err.response?.status;
    const detail = err.response?.data;
    console.error(`[seller-supply] ${endpoint} → ${status}:`, JSON.stringify(detail));
    const e = new Error(detail?.message || detail?.error || detail?.detail || `Ошибка seller-supply API ${status}`);
    e.status = status;
    e.wbDetail = detail?.message || detail?.error;
    if (status === 401 || status === 403) e.sessionExpired = true;
    throw e;
  }
}

/**
 * Получить доступные квоты по всем складам.
 * POST /transfer/AvailableLimits  (без параметров)
 * Ответ: result.data.quotas[] — { officeID, officeName, srcQuota, dstQuota }
 *   srcQuota > 0 — можно ЗАБРАТЬ товар с этого склада
 *   dstQuota > 0 — можно ПРИНЯТЬ товар на этот склад
 */
async function getTransferAvailableLimits(sessionToken, nmId, sessionCookies = null) {
  const result = await sellerSupplyPost(sessionToken, '/AvailableLimits', {}, sessionCookies);
  // Нормализуем к массиву квот
  return result?.data?.quotas || result?.quotas || [];
}

/**
 * Получить остатки артикула по складам (откуда можно перемещать).
 * POST /transfer/list  с { nmIDs: [nmId] }
 * Ответ: result.transfers[].chrts[] — { warehouseID, warehouseName, count, dstWarehouseIDs[] }
 */
async function getTransferStockByWarehouse(sessionToken, nmId, sessionCookies = null) {
  const result = await sellerSupplyPost(sessionToken, '/list', { nmIDs: [Number(nmId)] }, sessionCookies);
  const transfers = result?.transfers || [];
  const item = transfers.find(t => t.nmID === Number(nmId)) || transfers[0];
  return item?.chrts || [];
}

/**
 * Создать FBO-перемещение.
 * WB требует captcha-токен для /transfer/order, который генерируется только
 * в браузере. Поэтому вызываем через Windows-прокси /transfer-order, где
 * Puppeteer выполняет запрос из контекста страницы (браузер сам проходит капчу).
 * Формат: { transfers: [ { nmID, srcOfficeID, items: [ { dstOfficeID, chrtID, count } ] } ] }
 */
async function createWbTransfer(sessionToken, { nmId, chrtId, fromOfficeId, toOfficeId, amount }, sessionCookies = null) {
  const transfers = [{
    nmID:        Number(nmId),
    srcOfficeID: Number(fromOfficeId),
    items: [
      {
        dstOfficeID: Number(toOfficeId),
        chrtID:      Number(chrtId),
        count:       Number(amount),
      },
    ],
  }];

  // Шаг 1: получаем antibot captcha-токен ПРОГРАММНО (без браузера)
  const captchaToken = await getAntibotToken('TRANSFER_REMAINS_ORDER', sessionCookies);
  if (!captchaToken) {
    const e = new Error('Не удалось получить antibot captcha-токен');
    e.status = 409;          // повторяем
    e.captchaRequired = true;
    throw e;
  }

  // Шаг 2: создаём перемещение напрямую с captcha-токеном
  const supplierId = getSupplierId(sessionCookies, sessionToken);
  const headers = {
    Authorizev3:            sessionToken,
    'Content-Type':         'application/json',
    Accept:                 '*/*',
    Origin:                 'https://seller.wildberries.ru',
    Referer:                'https://seller.wildberries.ru/',
    'User-Agent':           'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    'X-Wb-Captcha-Token':   captchaToken,
    'X-Wb-Captcha-Latency': '700',
    'Root-Version':         'v1.98.0',
  };
  if (sessionCookies) headers['Cookie'] = sessionCookies;
  if (supplierId)     headers['X-Supplier-Id'] = supplierId;

  const body = {
    jsonrpc: '2.0',
    id: `json-rpc_${Math.floor(Math.random()*100000)}`,
    params: { transfers },
  };

  let res;
  try {
    res = await axios.post(
      `${WB_SELLER_SUPPLY}${TRANSFER_PATH}/order`,
      body,
      { headers, timeout: 20000, validateStatus: () => true }
    );
  } catch (err) {
    const e = new Error(`Ошибка сети при создании перемещения: ${err.message}`);
    e.status = 503;
    throw e;
  }

  const bodyStr = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  console.log(`[createWbTransfer] /order HTTP ${res.status} | ${bodyStr.substring(0, 200)}`);

  // JSON-RPC ошибка (включая капчу)
  if (res.data && typeof res.data === 'object' && res.data.error) {
    const rpcErr = res.data.error;
    const e = new Error(rpcErr.message || rpcErr.data?.msg || `WB error ${rpcErr.code}`);
    e.wbDetail = rpcErr.message;
    if (rpcErr.code === -32002 || /капч|captcha/i.test(rpcErr.message || '')) {
      e.captchaRequired = true;
      e.status = 409;        // капча — повторяем
    } else {
      e.status = 400;
    }
    throw e;
  }

  const result = res.data?.result ?? res.data;
  const hasFile = result && (result.file || result.mime);
  const isEmpty = result == null
    || (typeof result === 'object' && Object.keys(result).length === 0)
    || result === '';
  if (isEmpty) {
    const e = new Error('WB вернул пустой ответ на /transfer/order — перемещение НЕ подтверждено.');
    e.status = 502;
    e.emptyCreate = true;
    throw e;
  }

  console.log(`[createWbTransfer] ✅ ${hasFile ? 'получена накладная (file)' : 'успех'}`);
  return result;
}

/**
 * Список текущих активных перемещений артикула.
 * POST /transfer/list  с { nmIDs: [nmId] }
 */
async function getWbTransferList(sessionToken, nmId = null, sessionCookies = null) {
  const params = nmId ? { nmIDs: [Number(nmId)] } : {};
  return sellerSupplyPost(sessionToken, '/list', params, sessionCookies);
}

/**
 * Проверяет подключена ли у продавца платная опция
 * «Перераспределение остатков между складами» (redistributionSellerGoodsOneWarehouse).
 * Без неё перемещения невозможны.
 * Возвращает { active: boolean, status: string, expiredAt: string|null }
 */
async function checkRedistributionOption(sessionToken, sessionCookies = null) {
  if (!sessionToken || !sessionToken.startsWith('eyJhbGciOiJSUzI1NiIs')) {
    return { active: false, status: 'no_session', error: 'Нужна SMS авторизация' };
  }
  try {
    const headers = {
      Authorizev3:    sessionToken,
      'Content-Type': 'application/json',
      Accept:         '*/*',
      Origin:         'https://seller.wildberries.ru',
      Referer:        'https://seller.wildberries.ru/tariff-constructor',
      'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    };
    if (sessionCookies) headers['Cookie'] = sessionCookies;

    const res = await axios.post(
      'https://seller.wildberries.ru/ns/configurator-options/seller-tariffs/options/list',
      { jsonrpc: '2.0', id: `json-rpc_${Math.floor(Math.random()*100000)}` },
      { headers, timeout: 15000, validateStatus: () => true }
    );

    const bodyStr = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    console.log(`[redistribution-option] HTTP ${res.status} | body: ${bodyStr.substring(0, 200)}`);

    const options = res.data?.result?.options || res.data?.options || [];
    const opt = options.find(o => o.publicSlug === 'redistributionSellerGoodsOneWarehouse');
    if (!opt) {
      // Если список опций пустой или endpoint вернул не то — НЕ блокируем (unknown),
      // чтобы ложно не запрещать создание заявок
      console.warn(`[redistribution-option] опция не найдена среди ${options.length} опций (HTTP ${res.status})`);
      return { active: null, status: 'not_found', error: 'Опция не найдена в ответе' };
    }
    const active = opt.status === 'activated';
    console.log(`[redistribution-option] status=${opt.status} active=${active}`);
    return {
      active,
      status: opt.status,
      expiredAt: opt.activatedData?.expiredAt || null,
    };
  } catch (e) {
    console.warn('[redistribution-option] check failed:', e.message);
    // При ошибке не блокируем — возвращаем unknown
    return { active: null, status: 'check_failed', error: e.message };
  }
}

/**
 * Обновляет сессию WB через /auth/token, используя текущий (возможно скоро
 * истекающий) Authorizev3 + куки. Возвращает свежий токен — БЕЗ SMS и браузера.
 * Это делает SMS-вход одноразовым: пока запрос проходит, сессия живёт вечно.
 *
 * Endpoint: POST /ns/suppliers-auth/suppliers-portal-core/auth/token
 * Тело: { jsonrpc:"2.0", id:"...", params:{} }
 * Ответ: result.data.token (новый), exp, userID
 *
 * Возвращает { token, exp } или null если обновить не удалось (нужен SMS).
 */
async function refreshWbSession(currentToken, sessionCookies) {
  if (!currentToken) return null;
  try {
    const headers = {
      Authorizev3:    currentToken,
      'Content-Type': 'application/json',
      Accept:         '*/*',
      Origin:         'https://seller.wildberries.ru',
      Referer:        'https://seller.wildberries.ru/',
      'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    };
    if (sessionCookies) headers['Cookie'] = sessionCookies;

    const res = await axios.post(
      'https://seller.wildberries.ru/ns/suppliers-auth/suppliers-portal-core/auth/token',
      { jsonrpc: '2.0', id: `json-rpc_${Math.floor(Math.random()*100000)}`, params: {} },
      { headers, timeout: 15000, validateStatus: () => true }
    );

    const bodyStr = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    console.log(`[refresh-session] HTTP ${res.status} | ${bodyStr.substring(0, 150)}`);

    if (res.status === 200 && res.data?.result?.data?.token) {
      const data = res.data.result.data;
      console.log(`[refresh-session] ✅ токен обновлён, exp=${data.exp}`);
      return { token: data.token, exp: data.exp, userID: data.userID };
    }
    // 401/403 — сессия совсем истекла, нужен SMS
    if (res.status === 401 || res.status === 403) {
      console.warn('[refresh-session] ⚠️ сессия истекла полностью — нужен повторный SMS-вход');
      return null;
    }
    return null;
  } catch (e) {
    console.warn('[refresh-session] ошибка:', e.message);
    return null;
  }
}

/**
 * Получает supplier id пользователя по его сессии (Authorizev3).
 * Endpoint: POST /ns/suppliers/suppliers-portal-core/suppliers (метод getUserSuppliers)
 * Ответ: result.suppliers[].id — UUID продавца.
 * Это мультипользовательское решение: каждый юзер получает СВОЙ supplier id.
 * Возвращает supplierId (UUID) или null.
 */
async function fetchSupplierId(sessionToken, sessionCookies = null) {
  if (!sessionToken || !sessionToken.startsWith('eyJhbGciOiJSUzI1NiIs')) return null;
  try {
    const headers = {
      Authorizev3:    sessionToken,
      'Content-Type': 'application/json',
      Accept:         '*/*',
      Origin:         'https://seller.wildberries.ru',
      Referer:        'https://seller.wildberries.ru/',
      'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    };
    if (sessionCookies) headers['Cookie'] = sessionCookies;

    const res = await axios.post(
      'https://seller.wildberries.ru/ns/suppliers/suppliers-portal-core/suppliers',
      { method: 'getUserSuppliers', params: {}, id: `json-rpc_${Math.floor(Math.random()*100000)}`, jsonrpc: '2.0' },
      { headers, timeout: 15000, validateStatus: () => true }
    );

    const bodyStr = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    console.log(`[fetch-supplier-id] HTTP ${res.status} | ${bodyStr.substring(0, 120)}`);

    // Ответ может быть объектом или массивом (batch JSON-RPC)
    let suppliers = null;
    if (Array.isArray(res.data)) {
      const item = res.data.find(x => x?.result?.suppliers);
      suppliers = item?.result?.suppliers;
    } else {
      suppliers = res.data?.result?.suppliers;
    }
    if (suppliers && suppliers.length > 0 && suppliers[0].id) {
      console.log(`[fetch-supplier-id] ✅ supplier id: ${suppliers[0].id}`);
      return suppliers[0].id;
    }
    console.warn('[fetch-supplier-id] supplier id не найден в ответе');
    return null;
  } catch (e) {
    console.warn('[fetch-supplier-id] ошибка:', e.message);
    return null;
  }
}

/**
 * Программно проходит antibot-капчу WB БЕЗ браузера (масштабируется).
 * Механизм (расшифрован из реальных запросов):
 *  1. POST create-one-time-token {action} → 498 + challenge.payload
 *  2. challenge.payload содержит зашифрованный challenge; solution = payload + hash
 *     ВАЖНО: hash пустой ({"hash":""}) — капча мягкая, fingerprint не проверяется
 *  3. POST снова с solution → secureToken
 * Возвращает secureToken для заголовка X-Wb-Captcha-Token, или null.
 */
const ANTIBOT_FINGERPRINT = require('./antibot-fingerprint');

// Ожидаемая версия antibot-скрипта. Если WB сменит версию — наш статичный fingerprint
// и/или алгоритм могут устареть. Мониторим это в getAntibotToken и оповещаем.
const EXPECTED_ANTIBOT_SCRIPT = '/statics/fingerprint_v1.0.26.js';
const EXPECTED_SDK_VERSION     = 'js-front-desktop/3.0.8';

// Колбэк-оповещение об изменении antibot (регистрируется из server.js).
let _antibotAlertCb = null;
let _lastAlertedScript = null;   // чтобы не спамить одинаковыми алертами
function onAntibotChange(cb) { _antibotAlertCb = cb; }
function _alertAntibotChange(info) {
  console.warn(`[antibot] ⚠️ ИЗМЕНЕНИЕ ANTIBOT: ${JSON.stringify(info)}`);
  if (_antibotAlertCb && _lastAlertedScript !== info.scriptPath) {
    _lastAlertedScript = info.scriptPath;
    try { _antibotAlertCb(info); } catch (e) { console.warn('[antibot] alert cb error:', e.message); }
  }
}

/**
 * Извлекает challenge id из challenge.payload.
 * payload = <мусор>base64(base64(JSON)).<подпись>. JSON содержит {id, ip, timestamp}.
 */
function parseChallenge(payload) {
  try {
    const idx = payload.indexOf('ZXlK');     // base64 от 'eyJ'
    if (idx < 0) return null;
    let inner = payload.slice(idx).split('.')[0];
    inner += '='.repeat((4 - (inner.length % 4)) % 4);
    let lvl1 = Buffer.from(inner, 'base64').toString('utf8');
    lvl1 += '='.repeat((4 - (lvl1.length % 4)) % 4);
    const lvl2 = Buffer.from(lvl1, 'base64').toString('utf8');
    const m = lvl2.match(/"id":"([0-9a-f-]{36})"/);
    const ipM = lvl2.match(/"ip":"([0-9.]+)"/);
    return { id: m ? m[1] : null, ip: ipM ? ipM[1] : null };
  } catch { return null; }
}

/**
 * Собирает solution.payload по алгоритму WB (расшифрован из реального запроса):
 *   solution.payload = base64( hexCsv( XOR( JSON(fingerprint), challengeId ) ) )
 * Ключ XOR — это challenge id. hash пустой — WB не проверяет содержимое fingerprint.
 */
function buildSolutionPayload(challengeId, fingerprint) {
  const json = JSON.stringify(fingerprint);
  const key = Buffer.from(challengeId, 'utf8');
  const src = Buffer.from(json, 'utf8');
  const xored = Buffer.alloc(src.length);
  for (let i = 0; i < src.length; i++) xored[i] = src[i] ^ key[i % key.length];
  // hex через запятую (формат WB, без завершающей запятой)
  const hexCsv = Array.from(xored).map(b => b.toString(16)).join(',');
  return Buffer.from(hexCsv, 'utf8').toString('base64');
}

async function getAntibotToken(action, sessionCookies = null) {
  const ANTIBOT = 'https://antibot.wildberries.ru/api/v1/create-one-time-token';
  // Статичные заголовки SDK (из реальных запросов)
  const headers = {
    'Content-Type':            'application/json',
    Accept:                    '*/*',
    Origin:                    'https://seller.wildberries.ru',
    Referer:                   'https://seller.wildberries.ru/',
    'User-Agent':              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    'X-Wb-Antibot-Sdk-Version':'js-front-desktop/3.0.8',
    'X-Wb-Antibot-Key':        '6633e2ada32248b7b0de6828bd1eb271',
  };
  if (sessionCookies) headers['Cookie'] = sessionCookies;

  try {
    // Шаг 1: запрос challenge
    const r1 = await axios.post(ANTIBOT, { action }, { headers, timeout: 15000, validateStatus: () => true });
    console.log(`[antibot] step1 HTTP ${r1.status}`);

    if (r1.status === 200 && r1.data?.secureToken) {
      return r1.data.secureToken; // токен выдан сразу
    }
    if (r1.status !== 498 || !r1.data?.challenge) {
      console.warn(`[antibot] неожиданный ответ: ${JSON.stringify(r1.data).substring(0,150)}`);
      return null;
    }

    const challenge = r1.data.challenge;

    // Мониторинг версии antibot-скрипта. Если WB сменил версию — наш fingerprint/алгоритм
    // может устареть. Оповещаем (но всё равно пробуем — алгоритм XOR обычно переживает смену версии).
    if (challenge.scriptPath && challenge.scriptPath !== EXPECTED_ANTIBOT_SCRIPT) {
      _alertAntibotChange({
        type: 'script_version_changed',
        scriptPath: challenge.scriptPath,
        expected: EXPECTED_ANTIBOT_SCRIPT,
        note: 'WB сменил fingerprint-скрипт. Проверьте, проходит ли капча; при сбоях обновите antibot-fingerprint.js.',
      });
    }

    // Извлекаем challenge id (ключ XOR)
    const parsed = parseChallenge(challenge.payload);
    if (!parsed || !parsed.id) {
      console.warn('[antibot] не удалось извлечь challenge id');
      _alertAntibotChange({
        type: 'challenge_parse_failed',
        scriptPath: challenge.scriptPath,
        note: 'Не удалось распарсить challenge — формат payload мог измениться. Нужна проверка алгоритма.',
      });
      return null;
    }
    console.log(`[antibot] challenge id: ${parsed.id}`);

    // Собираем fingerprint: берём эталон, обновляем динамичные поля
    const fp = JSON.parse(JSON.stringify(ANTIBOT_FINGERPRINT));

    // Шаг 2: формируем solution.payload по алгоритму WB
    const solutionPayload = buildSolutionPayload(parsed.id, fp);
    const solution = { payload: solutionPayload };

    // Шаг 3: повторный запрос с solution
    const r2 = await axios.post(
      ANTIBOT,
      { action, challenge, solution },
      { headers, timeout: 15000, validateStatus: () => true }
    );
    console.log(`[antibot] step2 HTTP ${r2.status} | ${JSON.stringify(r2.data).substring(0,120)}`);

    if (r2.status === 200 && r2.data?.secureToken) {
      console.log('[antibot] ✅ secureToken получен');
      return r2.data.secureToken;
    }
    // step2 не вернул токен — возможно алгоритм/fingerprint устарел (WB сменил проверку).
    console.warn('[antibot] secureToken не получен');
    _alertAntibotChange({
      type: 'solution_rejected',
      status: r2.status,
      scriptPath: challenge.scriptPath,
      note: 'WB отверг solution. Вероятно изменился алгоритм fingerprint или его проверка. Нужно обновить antibot-fingerprint.js / алгоритм.',
    });
    return null;
  } catch (e) {
    console.warn('[antibot] ошибка:', e.message);
    return null;
  }
}

module.exports = {
  getWarehouses, getStocks, updateStocks, deleteStocks,
  getCardsList, getAllCards, extractSkusFromCards,
  getArticleByNmId, getArticleStocks, getFboStocksRaw, getWbFboWarehouseNames,
  getTransferAvailableLimits, getTransferStockByWarehouse, createWbTransfer, getWbTransferList,
  checkRedistributionOption,
  refreshWbSession,
  fetchSupplierId,
  getAntibotToken,
  onAntibotChange,
};
