// wb-api.js — интеграция с официальным WB Marketplace API
// Документация: https://dev.wildberries.ru
// Базовый хост: marketplace-api.wildberries.ru
// Авторизация: Authorization: Bearer <token>
// Лимит: 300 запросов/минуту для категории Marketplace

const axios = require('axios');

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
      timeout: 15000
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
async function getFboStocksRaw(token) {
  // dateFrom=2019-01-01 — получаем полный актуальный снимок остатков
  return apiRequest('GET', WB_STATISTICS_API,
    '/api/v1/supplier/stocks?dateFrom=2019-01-01', token);
}

/**
 * Получить склады с ненулевыми FBO остатками для конкретного артикула.
 * Возвращает: { article: { nmId, name }, warehouses: [{ name, amount }] }
 *
 * Стратегия:
 * 1. Statistics API — точные FBO остатки по складам WB (требует категорию Statistics в токене)
 * 2. Fallback: Marketplace API /api/v3/stocks (FBS, склады продавца) — если Statistics недоступен
 */
async function getArticleStocks(token, nmId) {
  const target = parseInt(nmId);

  // Получаем название товара (Content API)
  const article = await getArticleByNmId(token, nmId);

  // === Попытка 1: Statistics API (FBO — склады Wildberries) ===
  try {
    const allStocks = await getFboStocksRaw(token);
    const rows = Array.isArray(allStocks) ? allStocks : [];

    console.log(`[stocks] Statistics API: total rows=${rows.length}`);

    const byWarehouse = {};
    for (const item of rows) {
      if (item.nmId !== target) continue;
      const qty = item.quantity || 0;   // доступно к продаже
      if (qty <= 0) continue;
      const wh = item.warehouseName;
      byWarehouse[wh] = (byWarehouse[wh] || 0) + qty;
    }

    const warehouses = Object.entries(byWarehouse)
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount);

    console.log(`[stocks] nmId=${nmId} found in ${warehouses.length} warehouses`);

    const articleInfo = article || { nmId: target, name: `Артикул ${nmId}`, skus: [] };
    return { article: articleInfo, warehouses, source: 'statistics' };

  } catch (statErr) {
    console.warn(`[stocks] Statistics API failed (${statErr.status || statErr.message}). Trying Marketplace API fallback...`);

    // === Fallback: Marketplace API (FBS — собственные склады продавца) ===
    if (!article || !article.skus.length) {
      // Если нет ни Statistics, ни Content — возвращаем пустоту с понятной ошибкой
      const err = new Error(
        statErr.status === 401 || statErr.status === 403
          ? 'Нет доступа к Statistics API. Добавьте категорию «Статистика» в токен WB.'
          : 'Не удалось получить остатки. Проверьте права токена.'
      );
      err.hint = 'statistics_token_required';
      throw err;
    }

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

module.exports = {
  getWarehouses, getStocks, updateStocks, deleteStocks,
  getCardsList, getAllCards, extractSkusFromCards,
  getArticleByNmId, getArticleStocks, getFboStocksRaw
};
