// wb-api.js — интеграция с официальным WB Marketplace API
// Документация: https://dev.wildberries.ru
// Базовый хост: marketplace-api.wildberries.ru
// Авторизация: Authorization: Bearer <token>
// Лимит: 300 запросов/минуту для категории Marketplace

const axios = require('axios');

const WB_MARKETPLACE_API = 'https://marketplace-api.wildberries.ru';
const WB_CONTENT_API     = 'https://content-api.wildberries.ru';

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
  try {
    const response = await apiRequest('POST', WB_CONTENT_API, '/content/v2/get/cards/list', token, {
      settings: {
        cursor: { limit: 10 },
        filter: { nmIDs: [parseInt(nmId)], withPhoto: -1 }
      }
    });
    const card = response?.cards?.[0];
    if (!card) return null;
    const skus = extractSkusFromCards([card]);
    const name = card.title || card.subjectName || `Артикул ${nmId}`;
    return { nmId: parseInt(nmId), name, skus };
  } catch(err) {
    console.error('getArticleByNmId error:', err.message);
    return null;
  }
}

/**
 * Получить склады с ненулевыми остатками для данного артикула.
 * Возвращает: [{ id, name, amount }]
 */
async function getArticleStocks(token, nmId) {
  const article = await getArticleByNmId(token, nmId);
  if (!article || !article.skus.length) return { article: null, warehouses: [] };

  const warehouses = await getWarehouses(token);
  const result = [];

  // Проверяем склады параллельно (батчами по 5 чтобы не превысить rate limit)
  const batchSize = 5;
  for (let i = 0; i < warehouses.length; i += batchSize) {
    const batch = warehouses.slice(i, i + batchSize);
    await Promise.all(batch.map(async wh => {
      try {
        const stocks = await getStocks(token, wh.id, article.skus);
        const total = (stocks.stocks || []).reduce((s, x) => s + (x.amount || 0), 0);
        if (total > 0) result.push({ id: wh.id, name: wh.name, amount: total });
      } catch {}
    }));
  }

  result.sort((a, b) => b.amount - a.amount);
  return { article, warehouses: result };
}

module.exports = {
  getWarehouses, getStocks, updateStocks, deleteStocks,
  getCardsList, getAllCards, extractSkusFromCards,
  getArticleByNmId, getArticleStocks
};
