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
// Кастомный lookup: всегда возвращает IPv4 адрес.
function _ipv4Lookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, family: 4 }, callback);
}
const WB_AGENT = new https.Agent({ lookup: _ipv4Lookup, keepAlive: false });
console.log('[wb-api] IPv4-only HTTPS agent initialized');

const WB_MARKETPLACE_API = 'https://marketplace-api.wildberries.ru';
const WB_CONTENT_API     = 'https://content-api.wildberries.ru';
const WB_STATISTICS_API  = 'https://statistics-api.wildberries.ru';

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
        'Content-Type': 'application/json'
      },
      data,
      params,
      timeout: 15000,
      httpsAgent: WB_AGENT,   // принудительный IPv4 — WB API не принимает IPv6
    });
    return response.data;
  } catch (error) {
    const status  = error.response?.status;
    const detail  = error.response?.data?.detail || error.response?.data?.message || error.message;
    console.error(`❌ WB API [${method} ${path}] ${status}:`, detail);

    // Пробрасываем структурированную ошибку
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
 * Категория токена: Marketplace
 * @returns {Array} массив объектов склада { id, name, officeId, ... }
 */
async function getWarehouses(token) {
  return apiRequest('GET', WB_MARKETPLACE_API, '/api/v3/warehouses', token);
}

// ─── Остатки ──────────────────────────────────────────────────────────────────

/**
 * Получить остатки товаров на складе продавца по списку SKU (баркодов).
 * POST /api/v3/stocks/{warehouseId}
 * Категория токена: Marketplace
 * @param {string} token
 * @param {number} warehouseId — ID склада продавца (из getWarehouses)
 * @param {string[]} skus — массив баркодов (до 1000 штук за запрос)
 * @returns {{ stocks: Array<{ sku: string, amount: number }> }}
 */
async function getStocks(token, warehouseId, skus) {
  if (!Array.isArray(skus) || skus.length === 0) {
    throw new Error('Список SKU не может быть пустым');
  }
  // API принимает до 1000 SKU за раз — при необходимости разбиваем на батчи
  if (skus.length <= 1000) {
    return apiRequest('POST', WB_MARKETPLACE_API, `/api/v3/stocks/${warehouseId}`, token, { skus });
  }

  // Батчевая обработка
  const results = { stocks: [] };
  for (let i = 0; i < skus.length; i += 1000) {
    const batch = skus.slice(i, i + 1000);
    const res = await apiRequest('POST', WB_MARKETPLACE_API, `/api/v3/stocks/${warehouseId}`, token, { skus: batch });
    results.stocks.push(...(res.stocks || []));
  }
  return results;
}

/**
 * Обновить остатки товаров на складе продавца.
 * PUT /api/v3/stocks/{warehouseId}
 * Категория токена: Marketplace
 * @param {string} token
 * @param {number} warehouseId
 * @param {Array<{ sku: string, amount: number }>} stocks
 */
async function updateStocks(token, warehouseId, stocks) {
  if (!Array.isArray(stocks) || stocks.length === 0) {
    throw new Error('Список остатков не может быть пустым');
  }
  // API принимает до 1000 записей за раз
  if (stocks.length <= 1000) {
    return apiRequest('PUT', WB_MARKETPLACE_API, `/api/v3/stocks/${warehouseId}`, token, { stocks });
  }

  for (let i = 0; i < stocks.length; i += 1000) {
    const batch = stocks.slice(i, i + 1000);
    await apiRequest('PUT', WB_MARKETPLACE_API, `/api/v3/stocks/${warehouseId}`, token, { stocks: batch });
  }
  return { success: true };
}

/**
 * Удалить остатки (обнулить) по списку SKU на складе.
 * DELETE /api/v3/stocks/{warehouseId}
 * Категория токена: Marketplace
 */
async function deleteStocks(token, warehouseId, skus) {
  return apiRequest('DELETE', WB_MARKETPLACE_API, `/api/v3/stocks/${warehouseId}`, token, { skus });
}

// ─── Карточки товаров ─────────────────────────────────────────────────────────

/**
 * Получить список карточек товаров (nmId, vendorCode, баркоды).
 * POST /content/v2/get/cards/list
 * Категория токена: Content
 * Используется для получения всех баркодов товаров продавца.
 * @param {string} token
 * @param {string|null} cursor — курсор для пагинации (null для первой страницы)
 * @param {number} limit — количество карточек (макс. 100)
 */
async function getCardsList(token, cursor = null, limit = 100) {
  const body = {
    settings: {
      cursor: cursor ? { updatedAt: cursor.updatedAt, nmID: cursor.nmID } : {},
      filter: { withPhoto: -1 }
    }
  };
  return apiRequest('POST', WB_CONTENT_API, '/content/v2/get/cards/list', token, body);
}

/**
 * Получить ВСЕ карточки товаров продавца (обходит пагинацию автоматически).
 * Возвращает массив карточек с баркодами.
 */
async function getAllCards(token) {
  const allCards = [];
  let cursor = null;

  while (true) {
    const response = await getCardsList(token, cursor, 100);
    const cards = response?.cards || [];
    allCards.push(...cards);

    // Проверяем есть ли ещё страницы
    if (!response?.cursor || cards.length < 100) break;
    cursor = response.cursor;
  }

  return allCards;
}

/**
 * Извлечь все баркоды из списка карточек.
 * @param {Array} cards — результат getAllCards()
 * @returns {string[]} массив баркодов
 */
function extractSkusFromCards(cards) {
  const skus = [];
  for (const card of cards) {
    for (const size of (card.sizes || [])) {
      for (const sku of (size.skus || [])) {
        if (sku) skus.push(sku);
      }
    }
  }
  return [...new Set(skus)]; // дедупликация
}


/**
 * Получить название и баркоды товара по nmId (артикул WB).
 * POST /content/v2/get/cards/list с фильтром по nmID
 */
async function getArticleByNmId(token, nmId) {
  const target = parseInt(nmId);

  // Перебираем варианты фильтров WB Content API:
  // 1. nmIDs — официальный параметр для фильтрации по nmID (если поддерживается)
  // 2. textSearch — поиск по тексту, ищет по артикулу среди карточек продавца
  const filters = [
    { nmIDs: [target], withPhoto: -1 },
    { textSearch: String(nmId), withPhoto: -1 },
  ];

  for (const filter of filters) {
    try {
      const response = await apiRequest('POST', WB_CONTENT_API, '/content/v2/get/cards/list', token, {
        settings: { cursor: { limit: 100 }, filter }
      });

      const cards = response?.cards || [];
      console.log(`[article search] filter=${JSON.stringify(filter)} cards=${cards.length}`);

      // ВАЖНО: проверяем точное совпадение nmID, не берём первую попавшуюся карточку
      const card = cards.find(c => c.nmID === target);
      if (card) {
        const skus = extractSkusFromCards([card]);
        const name = card.title || card.subjectName || `Артикул ${nmId}`;
        console.log(`[article search] found: nmID=${card.nmID} name="${name}" skus=${skus.length}`);
        return { nmId: target, name, skus };
      }
    } catch(err) {
      console.error(`[article search] filter attempt failed:`, err.message);
    }
  }

  console.warn(`[article search] nmId ${nmId} not found in seller catalog`);
  return null;
}

/**
 * Получить FBO остатки товара по всем складам WB через Statistics API.
 * GET /api/v1/supplier/stocks — возвращает остатки на складах WB (FBO).
 *
 * ВАЖНО: токен должен иметь категорию «Статистика» (Statistics).
 * Поля ответа: warehouseName, nmId, quantity (доступно к продаже),
 *              quantityFull (полный остаток включая в пути), inWayToClient, inWayFromClient.
 */
// ─── Кеш FBO остатков (избегаем rate limit Statistics API 1 req/min) ─────────
const _fboCache = { data: null, ts: 0, key: '' };
const FBO_CACHE_TTL = 10 * 60 * 1000; // 10 минут — Statistics API лимит 1 req/min
let _fboInflight = null; // Дедупликация: если запрос уже летит — ждём его

async function getFboStocksRaw(token, nmIds = null, sessionToken = null, sessionCookies = null) {
  const WB_ANALYTICS_API = 'https://analytics-api.wildberries.ru';
  const cacheKey = token ? token.substring(0, 20) : '';
  const now = Date.now();

  // Возвращаем кеш если он свежий (< 90 сек)
  if (_fboCache.data && _fboCache.key === cacheKey && now - _fboCache.ts < FBO_CACHE_TTL) {
    const rows = _fboCache.data;
    console.log(`[FBO stocks] Cache hit: ${rows.length} строк`);
    return nmIds ? rows.filter(r => nmIds.includes(r.nmId)) : rows;
  }

  // Если уже есть запрос в полёте — ждём его результата (дедупликация)
  if (_fboInflight) {
    console.log(`[FBO stocks] Waiting for inflight request...`);
    const rows = await _fboInflight;
    return nmIds ? rows.filter(r => nmIds.includes(r.nmId)) : rows;
  }

  const analyticsBody = { pagination: { limit: 250000, offset: 0 } };
  if (nmIds && nmIds.length > 0) analyticsBody.filter = { nmIDs: nmIds };

  // Запускаем запрос и сохраняем в inflight для дедупликации
  _fboInflight = (async () => {
    try {
      // === Попытка 1: Analytics API напрямую ===
      try {
        const response = await apiRequest('POST', WB_ANALYTICS_API,
          '/api/analytics/v1/stocks-report/wb-warehouses', token, analyticsBody);
        const rows = response?.data || response?.stocks || [];
        console.log(`[FBO stocks] Analytics API direct: ${rows.length} строк`);
        _fboCache.data = rows; _fboCache.ts = Date.now(); _fboCache.key = cacheKey;
        return rows;
      } catch (analyticsErr) {
        if (analyticsErr.message && analyticsErr.message.includes('ENOTFOUND')) {
          console.warn(`[FBO stocks] Analytics API ENOTFOUND → Statistics API...`);
        } else {
          console.warn(`[FBO stocks] Analytics API (${analyticsErr.message}), → Statistics API...`);
        }
      }

      // === Попытка 2: Statistics API ===
      let statsErr429 = false;
      try {
        const data = await apiRequest('GET', WB_STATISTICS_API,
          '/api/v1/supplier/stocks?dateFrom=2019-01-01', token);
        const rows = Array.isArray(data) ? data : [];
        console.log(`[FBO stocks] Statistics fallback: ${rows.length} строк`);
        _fboCache.data = rows; _fboCache.ts = Date.now(); _fboCache.key = cacheKey;
        return rows;
      } catch (statErr) {
        statsErr429 = statErr.status === 429 || (statErr.message || '').includes('429');
        if (!statsErr429) {
          throw new Error('Нет доступа к остаткам. Добавьте категории «Аналитика» и «Статистика» в токен WB.');
        }
        console.warn(`[FBO stocks] Statistics 429 → trying via session JWT...`);
      }

      // === Попытка 3: Statistics API через session JWT ===
      if (statsErr429 && sessionToken) {
        try {
          const res = await axios.get(
            `${WB_STATISTICS_API}/api/v1/supplier/stocks?dateFrom=2019-01-01`,
            { headers: { 'Authorizev3': sessionToken, 'Accept': 'application/json' },
              validateStatus: () => true, timeout: 15000 }
          );
          if (res.status === 200 && Array.isArray(res.data)) {
            const rows = res.data;
            console.log(`[FBO stocks] Statistics via session JWT: ${rows.length} строк`);
            _fboCache.data = rows; _fboCache.ts = Date.now(); _fboCache.key = cacheKey;
            return rows;
          }
          console.warn(`[FBO stocks] Statistics session JWT → ${res.status}`);
        } catch(e) {
          console.warn(`[FBO stocks] Statistics session JWT error: ${e.message}`);
        }
      }

      console.error(`[FBO stocks] Все источники недоступны (Statistics 429)`);
      throw new Error('Statistics API временно недоступен (rate limit). Попробуйте позже.');
    } finally {
      _fboInflight = null;
    }
  })();

  const rows = await _fboInflight;
  return nmIds ? rows.filter(r => nmIds.includes(r.nmId)) : rows;
}

/**
 * Получить список уникальных WB FBO складов из Statistics API.
 * Возвращает массив названий складов WB (не собственные склады продавца).
 */
async function getWbFboWarehouseNames(token) {
  try {
    const allStocks = await getFboStocksRaw(token);
    const rows = Array.isArray(allStocks) ? allStocks : [];
    // Фильтруем системные строки (в пути, возвраты) — берём только реальные склады
    const excluded = ['в пути', 'in transit', 'возврат', 'return', 'к клиенту', 'от клиента'];
    const names = new Set();
    for (const item of rows) {
      const wh = (item.warehouseName || '').trim();
      if (!wh) continue;
      const isSystem = excluded.some(ex => wh.toLowerCase().includes(ex));
      if (!isSystem) names.add(wh);
    }
    return [...names].sort((a, b) => a.localeCompare(b, 'ru'));
  } catch(err) {
    console.warn('[getWbFboWarehouseNames] Statistics API error:', err.message);
    return [];
  }
}

/**
 * Получить склады с ненулевыми FBO остатками для конкретного артикула.
 * Возвращает: { article: { nmId, name }, warehouses: [{ name, amount }] }
 *
 * Стратегия:
 * 1. Statistics API — точные FBO остатки по складам WB (требует категорию Statistics в токене)
 * 2. Fallback: Marketplace API /api/v3/stocks (FBS, склады продавца) — если Statistics недоступен
 */
async function getArticleStocks(token, nmId, sessionToken, sessionCookies = null) {
  const target = parseInt(nmId);
  const article = await getArticleByNmId(token, nmId);

  // === Попытка 1: Transfer API (seller-supply) — самый точный источник ===
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
        const articleInfo = article || { nmId: target, name: `Артикул ${nmId}`, skus: [] };
        return { article: articleInfo, warehouses, source: 'transfer_api' };
      }
      console.log(`[stocks] Transfer API: nmId=${nmId} не найден в transfer/list`);
    } catch(e) {
      console.warn('[stocks] Transfer API failed:', e.message);
    }
  }

  // === Попытка 2: Statistics API (FBO) ===
  try {
    const allStocks = await getFboStocksRaw(token, [target], sessionToken, sessionCookies);
    const rows = Array.isArray(allStocks) ? allStocks : [];
    console.log(`[stocks] Statistics API: total rows=${rows.length}`);
    const byWarehouse = {};
    for (const item of rows) {
      if (item.nmId !== target) continue;
      // quantity = доступно к заказу (физически на складе)
      // quantityFull включает товар "в пути" — даёт ложные остатки на других складах
      const qty = item.quantity || 0;
      if (qty <= 0) continue;
      const wh = item.warehouseName;
      if (!wh) continue;
      byWarehouse[wh] = (byWarehouse[wh] || 0) + qty;
    }
    const warehouses = Object.entries(byWarehouse)
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount);
    console.log(`[stocks] Statistics API: nmId=${nmId} в ${warehouses.length} складах`);
    const articleInfo = article || { nmId: target, name: `Артикул ${nmId}`, skus: [] };
    return { article: articleInfo, warehouses, source: 'statistics' };
  } catch (statErr) {
    console.warn(`[stocks] Statistics API failed: ${statErr.message}`);
    if (!article || !article.skus.length) {
      const err = new Error(
        statErr.status === 401 || statErr.status === 403
          ? 'Нет доступа к Statistics API. Добавьте категорию «Статистика» в токен WB.'
          : 'Не удалось получить остатки. Проверьте права токена.'
      );
      err.hint = 'statistics_token_required';
      throw err;
    }
    // === Fallback: Marketplace API (FBS) ===
    const allWarehouses = await getWarehouses(token);
    const result = [];
    const batchSize = 5;
    for (let i = 0; i < allWarehouses.length; i += batchSize) {
      const batch = allWarehouses.slice(i, i + batchSize);
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

const WB_SELLER_SUPPLY = 'https://seller-supply.wildberries.ru';
const TRANSFER_PATH    = '/ns/goods-return/supply-manager/api/v1/transfer';

/**
 * Базовый POST к внутреннему API seller-supply.wildberries.ru
 */
async function sellerSupplyPost(sessionToken, endpoint, body = {}, sessionCookies = null) {
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
      console.log('[seller-supply] using cookies:', sessionCookies.substring(0, 60));
    }
    const res = await axios.post(
      `${WB_SELLER_SUPPLY}${TRANSFER_PATH}${endpoint}`,
      body,
      { headers, timeout: 15000 }
    );
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data;
    console.error(`[seller-supply] ${endpoint} → ${status}:`, JSON.stringify(detail));
    const e = new Error(
      detail?.message || detail?.error || detail?.detail || `Ошибка seller-supply API ${status}`
    );
    e.status = status;
    e.wbDetail = detail;
    if (status === 401 || status === 403) e.sessionExpired = true;
    throw e;
  }
}

/**
 * Получить список складов с доступными лимитами для артикула.
 * POST /transfer/AvailableLimits
 * Возвращает: массив складов с полями officeId, officeName, available (bool), qty
 */
async function getTransferAvailableLimits(sessionToken, nmId, sessionCookies = null) {
  return sellerSupplyPost(sessionToken, '/AvailableLimits', { nmId: Number(nmId) }, sessionCookies);
}

/**
 * Создать запрос на FBO-перемещение товара между складами WB.
 * POST /transfer
 * @param {string} sessionToken - Authorizev3 JWT из ЛК продавца
 * @param {number} nmId         - Артикул WB (nmId)
 * @param {number} fromOfficeId - ID склада-источника (из AvailableLimits)
 * @param {number} toOfficeId   - ID склада-назначения
 * @param {number} amount       - Количество единиц
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
  getTransferAvailableLimits, createWbTransfer, getWbTransferList
};
