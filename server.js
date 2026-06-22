// server.js — WB Supply Helper Backend
// Авторизация продавца: Bearer API-токен из ЛК Wildberries
// Telegram Mini App: валидация initData через @telegram-apps/init-data-node

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const { Client } = require('pg');
const crypto = require('crypto');
// @telegram-apps/init-data-node заменён на прямую реализацию алгоритма Telegram
const { validateWbToken, decodeWbToken, requestSmsCode, confirmSmsCode } = require('./wb-auth');
const { getWarehouses, getStocks, updateStocks, getAllCards, extractSkusFromCards, getArticleStocks, getWbFboWarehouseNames, getTransferAvailableLimits, getTransferStockByWarehouse, createWbTransfer, getWbTransferList, checkRedistributionOption, refreshWbSession, fetchSupplierId } = require('./wb-api');
const axios = require('axios');
const path = require('path');
const fs   = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// ─── Тестовый режим ───────────────────────────────────────────────────────────
// true  — отключает проверку подписи Telegram, telegramId = 12345 (для отладки из браузера)
// false — включает строгую валидацию Telegram initData (для продакшена)
const TEST_MODE = process.env.TEST_MODE === 'true' || false;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── База данных ──────────────────────────────────────────────────────────────
const db = new Client({ connectionString: process.env.DATABASE_URL });

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL,
      phone       VARCHAR(20),
      name        VARCHAR(255),
      username    VARCHAR(255),
      wb_token    TEXT,
      wb_token_info      JSONB,
      wb_session_token   TEXT,
      wb_session_updated TIMESTAMP,
      created_at  TIMESTAMP DEFAULT NOW(),
      updated_at  TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS wb_session_token   TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS wb_session_updated TIMESTAMP;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMP DEFAULT NOW();
    ALTER TABLE users ADD COLUMN IF NOT EXISTS username           VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS wb_session_cookies TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS wb_supplier_id     VARCHAR(64);

    CREATE TABLE IF NOT EXISTS sms_requests (
      telegram_id  BIGINT PRIMARY KEY,
      phone        VARCHAR(20),
      request_token TEXT,
      created_at   TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS transfer_requests (
      id             SERIAL PRIMARY KEY,
      user_id        BIGINT NOT NULL,
      from_warehouse VARCHAR(255) NOT NULL,
      to_warehouse   VARCHAR(255) NOT NULL,
      sku            VARCHAR(100) NOT NULL,
      amount         INTEGER NOT NULL CHECK (amount > 0),
      status         VARCHAR(50) DEFAULT 'pending',
      retry_count    INTEGER DEFAULT 0,
      next_retry_at  TIMESTAMP,
      error_message  TEXT,
      created_at     TIMESTAMP DEFAULT NOW(),
      updated_at     TIMESTAMP DEFAULT NOW()
    );
    -- Добавляем колонки если таблица уже существует (миграция)
    ALTER TABLE transfer_requests ADD COLUMN IF NOT EXISTS retry_count    INTEGER DEFAULT 0;
    ALTER TABLE transfer_requests ADD COLUMN IF NOT EXISTS next_retry_at  TIMESTAMP;
    ALTER TABLE transfer_requests ADD COLUMN IF NOT EXISTS error_message  TEXT;
    ALTER TABLE transfer_requests ADD COLUMN IF NOT EXISTS product_name   TEXT;
    ALTER TABLE transfer_requests ADD COLUMN IF NOT EXISTS moved          INTEGER DEFAULT 0;

    CREATE TABLE IF NOT EXISTS payments (
      id           SERIAL PRIMARY KEY,
      user_id      BIGINT NOT NULL,
      amount       NUMERIC(10, 2),
      units        INTEGER,
      status       VARCHAR(50),
      yookassa_id  VARCHAR(255) UNIQUE,
      created_at   TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ Таблицы БД проверены/созданы');
}

// Флаг готовности БД — маршруты возвращают 503 пока БД не поднялась
let dbReady = false;

async function connectDB(attempt = 1) {
  try {
    await db.connect();
    console.log('✅ PostgreSQL подключён');
    await initDB();
    dbReady = true;
  } catch (err) {
    const delay = Math.min(attempt * 2000, 30000); // макс 30 сек между попытками
    console.error(`❌ Ошибка подключения к БД (попытка ${attempt}):`, err.message);
    console.log(`🔄 Повтор через ${delay / 1000} сек...`);
    setTimeout(() => connectDB(attempt + 1), delay);
  }
}

// Middleware: проверяем готовность БД перед каждым API-запросом
function requireDB(req, res, next) {
  if (!dbReady) {
    return res.status(503).json({ error: 'База данных недоступна, сервер запускается. Попробуйте через несколько секунд.' });
  }
  next();
}

connectDB();

// ─── Telegram Auth Middleware ─────────────────────────────────────────────────
// Валидация Telegram Mini App initData по официальному алгоритму:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function validateTelegramInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  if (!receivedHash) throw new Error('hash отсутствует в initData');

  // Удаляем hash из параметров перед проверкой
  params.delete('hash');

  // Сортируем параметры и формируем строку проверки
  const checkString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  // Секретный ключ: HMAC-SHA256 от токена бота с ключом "WebAppData"
  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken.trim())
    .digest();

  // Ожидаемый хэш
  const expectedHash = crypto
    .createHmac('sha256', secretKey)
    .update(checkString)
    .digest('hex');

  if (expectedHash !== receivedHash) {
    throw new Error('Hash is invalid');
  }
}

async function telegramAuth(req, res, next) {
  if (TEST_MODE) {
    req.telegramId = 12345;
    req.telegramUser = { id: 12345, first_name: 'Test', username: 'testuser' };
    return next();
  }

  const authHeader = req.headers.authorization || '';

  const spaceIdx = authHeader.indexOf(' ');
  if (spaceIdx === -1) {
    return res.status(401).json({ error: 'Требуется авторизация через Telegram Mini App' });
  }

  const authType = authHeader.substring(0, spaceIdx);
  const authData = authHeader.substring(spaceIdx + 1);

  if (authType !== 'tma' || !authData) {
    return res.status(401).json({ error: 'Требуется авторизация через Telegram Mini App' });
  }

  if (!BOT_TOKEN) {
    console.error('[TG Auth] TELEGRAM_BOT_TOKEN не задан!');
    return res.status(500).json({ error: 'Ошибка конфигурации сервера' });
  }

  console.log('[TG Auth] initData length:', authData.length, '| token ok:', !!BOT_TOKEN);

  try {
    validateTelegramInitData(authData, BOT_TOKEN);

    const params  = new URLSearchParams(authData);
    const userRaw = params.get('user');
    if (!userRaw) {
      console.error('[TG Auth] Поле user отсутствует в initData');
      return res.status(400).json({ error: 'Нет данных пользователя Telegram' });
    }

    const user = JSON.parse(userRaw);
    if (!user?.id) {
      console.error('[TG Auth] user.id отсутствует:', user);
      return res.status(400).json({ error: 'Нет данных пользователя Telegram' });
    }

    console.log('[TG Auth] ✅ userId:', user.id, '|', user.username || user.first_name);
    req.telegramId   = user.id;
    req.telegramUser = user;
    next();
  } catch (error) {
    console.error('[TG Auth] ❌', error.message);
    console.error('[TG Auth] initData snippet:', authData.substring(0, 120));
    return res.status(403).json({ error: 'Недействительные данные Telegram: ' + error.message });
  }
}

// ─── Вспомогательные функции ─────────────────────────────────────────────────
async function getUserSessionToken(telegramId) {
  const r = await db.query('SELECT wb_session_token, wb_token, wb_session_cookies, wb_session_updated, wb_supplier_id FROM users WHERE telegram_id=$1', [telegramId]);
  const row = r.rows[0];
  let token   = row?.wb_session_token || null;
  let cookies = row?.wb_session_cookies || null;
  let supplierId = row?.wb_supplier_id || null;

  // Если supplier id ещё не сохранён — получаем его сейчас и сохраняем
  if (token && token.startsWith('eyJhbGciOiJSUzI1NiIs') && !supplierId) {
    try {
      supplierId = await fetchSupplierId(token, cookies);
      if (supplierId) {
        await db.query('UPDATE users SET wb_supplier_id=$1 WHERE telegram_id=$2', [supplierId, telegramId]);
        console.log(`[session] supplier id получен и сохранён: ${supplierId}`);
      }
    } catch {}
  }

  // Подставляем supplier id в куки (seller-supply требует x-supplier-id)
  if (supplierId && cookies && !cookies.includes('x-supplier-id=')) {
    cookies += `; x-supplier-id=${supplierId}; x-supplier-id-external=${supplierId}`;
  }

  // Авто-обновление сессии: если токен скоро истекает — обновляем через /auth/token
  // (без SMS). Это делает SMS-вход одноразовым для пользователя.
  if (token && token.startsWith('eyJhbGciOiJSUzI1NiIs')) {
    let needRefresh = false;
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      // iat есть, exp может не быть — обновляем если прошло > 2 часов с выпуска
      const ageSec = Math.floor(Date.now() / 1000) - (payload.iat || 0);
      if (payload.exp) {
        // обновляем за 5 мин до истечения
        needRefresh = (payload.exp - Math.floor(Date.now() / 1000)) < 300;
      } else {
        needRefresh = ageSec > 2 * 3600;
      }
    } catch { needRefresh = false; }

    if (needRefresh) {
      console.log(`[session] токен пользователя ${telegramId} устарел — обновляю через /auth/token`);
      const refreshed = await refreshWbSession(token, cookies);
      if (refreshed?.token) {
        // ВАЖНО: /auth/token возвращает wb-seller-lk (EdDSA) токен, а не Authorizev3.
        // Обновляем wb-seller-lk в куках, основной Authorizev3 остаётся (его освежает
        // браузерная сессия). Сохраняем новый токен и время.
        // Обновляем wb-seller-lk куку новым значением
        if (cookies) {
          if (/wb-seller-lk=/.test(cookies)) {
            cookies = cookies.replace(/wb-seller-lk=[^;]+/, `wb-seller-lk=${refreshed.token}`);
          } else {
            cookies += `; wb-seller-lk=${refreshed.token}`;
          }
        }
        await db.query(
          'UPDATE users SET wb_session_cookies=$1, wb_session_updated=NOW() WHERE telegram_id=$2',
          [cookies, telegramId]
        );
        console.log(`[session] ✅ сессия пользователя ${telegramId} обновлена без SMS`);
      } else {
        console.warn(`[session] ⚠️ не удалось обновить сессию ${telegramId} — может потребоваться SMS`);
      }
    }
  }

  return {
    token: token || row?.wb_token || null,
    cookies: cookies
  };
}

// ─── Вспомогательная функция: получить wb_token пользователя ─────────────────
async function getUserToken(telegramId) {
  const result = await db.query(
    'SELECT wb_token FROM users WHERE telegram_id = $1',
    [telegramId]
  );
  return result.rows[0]?.wb_token || null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES — авторизация по API-токену WB
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /auth/set-token
 * Принимает API-токен WB, проверяет его валидность реальным запросом к WB API,
 * затем сохраняет в БД. Токен генерируется продавцом в ЛК:
 * Профиль → Настройки → Доступ к API → Создать токен (категория: Marketplace)
 */
app.post('/auth/set-token', telegramAuth, requireDB, async (req, res) => {
  const { token } = req.body;
  if (!token || token.trim().length < 10) {
    return res.status(400).json({ error: 'Введите API-токен Wildberries' });
  }

  const cleanToken = token.trim();

  // Проверяем токен реальным запросом к WB API
  const validation = await validateWbToken(cleanToken);
  if (!validation.success) {
    return res.status(400).json({ error: validation.error });
  }

  // Декодируем JWT для сохранения мета-информации (срок действия, категории)
  const tokenInfo = decodeWbToken(cleanToken);

  try {
    await db.query(
      `INSERT INTO users (telegram_id, wb_token, wb_token_info, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (telegram_id)
       DO UPDATE SET wb_token = $2, wb_token_info = $3, updated_at = NOW()`,
      [req.telegramId, cleanToken, tokenInfo ? JSON.stringify(tokenInfo) : null]
    );

    const expiresAt = tokenInfo?.exp
      ? new Date(tokenInfo.exp * 1000).toLocaleDateString('ru-RU')
      : null;

    res.json({
      success: true,
      message: 'API-токен сохранён и проверен',
      expires_at: expiresAt
    });
  } catch (err) {
    console.error('Ошибка сохранения токена в БД:', err);
    res.status(500).json({ error: 'Ошибка сохранения токена' });
  }
});

/**
 * GET /auth/status
 * Возвращает статус авторизации и мета-информацию о токене.
 */
app.get('/auth/status', telegramAuth, requireDB, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT wb_token, wb_token_info, wb_session_token, wb_session_updated, updated_at
       FROM users WHERE telegram_id = $1`,
      [req.telegramId]
    );
    const row = result.rows[0];

    const hasSession  = !!(row?.wb_session_token);
    const hasApiToken = !!(row?.wb_token);

    // Не авторизован совсем
    if (!hasSession && !hasApiToken) {
      return res.json({ authorized: false });
    }

    // Есть API-токен но нет сессии — требуем SMS
    if (!hasSession && hasApiToken) {
      return res.json({ authorized: false, requires_sms: true });
    }

    // Данные по API токену
    const tokenInfo = row.wb_token_info;
    const apiTokenExpiry = tokenInfo?.exp
      ? new Date(tokenInfo.exp * 1000).toLocaleDateString('ru-RU')
      : null;
    const apiTokenExpired = tokenInfo?.exp ? Date.now() / 1000 > tokenInfo.exp : false;

    // Данные по сессионному токену
    const sessionAgeHours = row.wb_session_updated
      ? Math.round((Date.now() - new Date(row.wb_session_updated)) / 3_600_000)
      : null;

    res.json({
      authorized:         true,
      has_session:        hasSession,
      session_age_hours:  sessionAgeHours,
      has_api_token:      hasApiToken,
      api_token_expires:  apiTokenExpiry,
      api_token_expired:  apiTokenExpired,
      connected_at:       row.updated_at
    });
  } catch (err) {
    console.error('Ошибка проверки статуса:', err);
    res.status(500).json({ error: 'Ошибка проверки статуса' });
  }
});

/**
 * DELETE /auth/token
 * Отключить WB-аккаунт (удалить токен).
 */
app.delete('/auth/token', telegramAuth, requireDB, async (req, res) => {
  try {
    await db.query(
      'UPDATE users SET wb_token = NULL, wb_token_info = NULL, updated_at = NOW() WHERE telegram_id = $1',
      [req.telegramId]
    );
    res.json({ success: true, message: 'Токен удалён' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления токена' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// WB API ROUTES — склады и остатки
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /transfers/warehouses
 * Список складов продавца.
 * WB API: GET /api/v3/warehouses
 */
app.get('/transfers/warehouses', telegramAuth, requireDB, async (req, res) => {
  try {
    const token = await getUserToken(req.telegramId);
    if (!token) return res.status(401).json({ error: 'Сначала подключите Wildberries API-токен' });

    const warehouses = await getWarehouses(token);
    res.json(warehouses);
  } catch (err) {
    const status = err.status || 500;
    res.status(status < 500 ? status : 500).json({
      error: err.wbDetail || 'Ошибка получения складов'
    });
  }
});

/**
 * POST /transfers/stocks/:warehouseId
 * Остатки товаров на конкретном складе.
 * WB API: POST /api/v3/stocks/{warehouseId}  body: { skus: [...] }
 *
 * Если skus не переданы — автоматически получает все баркоды из карточек (требует токен с Content).
 */
app.post('/transfers/stocks/:warehouseId', telegramAuth, requireDB, async (req, res) => {
  const { warehouseId } = req.params;
  let { skus } = req.body;

  try {
    const token = await getUserToken(req.telegramId);
    if (!token) return res.status(401).json({ error: 'Сначала подключите Wildberries API-токен' });

    // Если SKU не переданы — пробуем получить из карточек товаров
    if (!skus || skus.length === 0) {
      try {
        const cards = await getAllCards(token);
        skus = extractSkusFromCards(cards);
      } catch {
        return res.status(400).json({ error: 'Укажите список SKU или выдайте токену права на категорию Content' });
      }
    }

    if (skus.length === 0) {
      return res.json({ stocks: [] });
    }

    const stocks = await getStocks(token, warehouseId, skus);
    res.json(stocks);
  } catch (err) {
    const status = err.status || 500;
    res.status(status < 500 ? status : 500).json({
      error: err.wbDetail || 'Ошибка получения остатков'
    });
  }
});

/**
 * GET /transfers/stocks/:warehouseId  (совместимость со старым фронтендом)
 * skus передаются через query-параметр: ?skus=sku1,sku2
 */
app.get('/transfers/stocks/:warehouseId', telegramAuth, requireDB, async (req, res) => {
  const { warehouseId } = req.params;
  const skusParam = req.query.skus;
  const skus = skusParam ? skusParam.split(',').map(s => s.trim()).filter(Boolean) : [];

  try {
    const token = await getUserToken(req.telegramId);
    if (!token) return res.status(401).json({ error: 'Сначала подключите Wildberries API-токен' });
    if (skus.length === 0) return res.status(400).json({ error: 'Укажите список SKU (?skus=sku1,sku2)' });

    const stocks = await getStocks(token, warehouseId, skus);
    res.json(stocks);
  } catch (err) {
    const status = err.status || 500;
    res.status(status < 500 ? status : 500).json({
      error: err.wbDetail || 'Ошибка получения остатков'
    });
  }
});

/**
 * PUT /transfers/stocks/:warehouseId
 * Обновить остатки на складе.
 * WB API: PUT /api/v3/stocks/{warehouseId}  body: { stocks: [{ sku, amount }] }
 */
app.put('/transfers/stocks/:warehouseId', telegramAuth, requireDB, async (req, res) => {
  const { warehouseId } = req.params;
  const { stocks } = req.body;

  if (!Array.isArray(stocks) || stocks.length === 0) {
    return res.status(400).json({ error: 'Передайте массив stocks: [{ sku, amount }]' });
  }

  try {
    const token = await getUserToken(req.telegramId);
    if (!token) return res.status(401).json({ error: 'Сначала подключите Wildberries API-токен' });

    await updateStocks(token, warehouseId, stocks);
    res.json({ success: true });
  } catch (err) {
    const status = err.status || 500;
    res.status(status < 500 ? status : 500).json({
      error: err.wbDetail || 'Ошибка обновления остатков'
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSFER REQUESTS — запросы на перемещение (локальная БД)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /transfers/create
 * Создать запрос на перемещение товара между складами.
 */
app.post('/transfers/create', telegramAuth, requireDB, async (req, res) => {
  const { from_warehouse, to_warehouse, sku, amount, product_name } = req.body;

  if (!from_warehouse || !to_warehouse || !sku || !amount) {
    return res.status(400).json({ error: 'Заполните все поля: from_warehouse, to_warehouse, sku, amount' });
  }
  if (parseInt(amount, 10) <= 0) {
    return res.status(400).json({ error: 'Количество должно быть больше 0' });
  }
  if (from_warehouse === to_warehouse) {
    return res.status(400).json({ error: 'Склады отправителя и получателя должны отличаться' });
  }

  try {
    const result = await db.query(
      `INSERT INTO transfer_requests (user_id, from_warehouse, to_warehouse, sku, amount, status, product_name)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6) RETURNING *`,
      [req.telegramId, from_warehouse, to_warehouse, sku, parseInt(amount, 10), product_name || null]
    );
    res.json({ success: true, request: result.rows[0] });
  } catch (err) {
    console.error('Ошибка создания запроса:', err);
    res.status(500).json({ error: 'Ошибка создания запроса' });
  }
});

/**
 * GET /transfers/list
 * Список запросов на перемещение текущего пользователя.
 */
app.get('/transfers/list', telegramAuth, requireDB, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, user_id, from_warehouse, to_warehouse, sku, amount, status, retry_count, error_message, next_retry_at, created_at, updated_at FROM transfer_requests WHERE user_id = $1 ORDER BY created_at DESC',
      [req.telegramId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки списка' });
  }
});


/**
 * PATCH /transfers/:id
 * Обновить количество в запросе
 */
app.patch('/transfers/:id', telegramAuth, requireDB, async (req, res) => {
  const { id } = req.params;
  const { amount } = req.body;
  if (!amount || parseInt(amount) < 1) return res.status(400).json({ error: 'Некорректное количество' });
  try {
    const r = await db.query(
      `UPDATE transfer_requests SET amount=$1, updated_at=NOW()
       WHERE id=$2 AND user_id=$3 AND status='pending' RETURNING *`,
      [parseInt(amount), id, req.telegramId]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Запрос не найден' });
    res.json({ success: true, request: r.rows[0] });
  } catch(err) { res.status(500).json({ error: 'Ошибка обновления' }); }
});



// ═══════════════════════════════════════════════════════════════════════════════
// SMS АВТОРИЗАЦИЯ — получение Authorizev3 через ЛК продавца WB
// ═══════════════════════════════════════════════════════════════════════════════


/**
 * POST /auth/save-sms-state
 * Сохраняет requestToken из клиентского SMS-запроса.
 * Клиент делает запрос к WB напрямую (Railway не может резолвить .ru),
 * получает requestToken и сохраняет его здесь для шага 2.
 */
app.post('/auth/save-sms-state', telegramAuth, requireDB, async (req, res) => {
  const { phone, requestToken } = req.body;
  if (!phone || !requestToken) return res.status(400).json({ error: 'phone и requestToken обязательны' });
  try {
    await db.query(
      `INSERT INTO sms_requests (telegram_id, phone, request_token, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (telegram_id) DO UPDATE
         SET phone=$2, request_token=$3, created_at=NOW()`,
      [req.telegramId, phone, requestToken]
    );
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DEBUG: тест seller-supply.wildberries.ru с Bearer токеном ───────────
app.get('/debug-supply-test', async (req, res) => {
  try {
    const axios = require('axios');
    const https = require('https');
    const dns   = require('dns');
    function ipv4(h, o, cb) { dns.lookup(h, { ...o, family: 4 }, cb); }
    const agent = new https.Agent({ lookup: ipv4, keepAlive: false });

    const token = process.env.WB_API_KEY || '';
    if (!token) return res.status(400).json({ error: 'WB_API_KEY не задан в Railway Variables' });

    const BASE = 'https://seller-supply.wildberries.ru';
    const hdrs = (extra = {}) => ({
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      'Origin':        'https://seller.wildberries.ru',
      'Referer':       'https://seller.wildberries.ru/stock-control',
      ...extra,
    });
    const post = (url, data) => axios.post(url, data,
      { headers: hdrs(), httpsAgent: agent, timeout: 10000, validateStatus: s => s < 600 });

    const results = {};
    let jid = 1;
    const rpc = (method, params = {}) => ({
      jsonrpc: '2.0', id: `json-rpc_${jid++}`, method, params
    });

    // ── Тест 1: AvailableLimits (квоты складов) ──────────────────────────
    try {
      // Пробуем пути которые реально используются в браузере
      const r = await post(
        `${BASE}/ns/goods-return/supply-manager/api/v1/transfer/AvailableLimits`,
        {}
      );
      results.availableLimits = { status: r.status, sample: JSON.stringify(r.data).substring(0, 200) };
    } catch(e) { results.availableLimits = { error: e.message }; }

    // ── Тест 2: transfer/list (список доступных перемещений) ─────────────
    try {
      const r = await post(
        `${BASE}/ns/goods-return/supply-manager/api/v1/transfer/list`,
        {}
      );
      results.transferList = { status: r.status, sample: JSON.stringify(r.data).substring(0, 200) };
    } catch(e) { results.transferList = { error: e.message }; }

    // ── Тест 3: Альтернативный путь ──────────────────────────────────────
    try {
      const r = await post(
        `${BASE}/ns/transfer/supply-manager/api/v1/transfer/AvailableLimits`,
        {}
      );
      results.altPath = { status: r.status, sample: JSON.stringify(r.data).substring(0, 200) };
    } catch(e) { results.altPath = { error: e.message }; }

    console.log('[debug-supply-test] results:', JSON.stringify(results).substring(0, 400));
    res.json(results);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── SETUP: сохранить authorizev3 токен в БД без Telegram-авторизации ────
// Используется один раз для настройки. Защищён секретным ключом.
app.post('/auth/setup-token', requireDB, async (req, res) => {
  const { secret, telegram_id, token } = req.body || {};

  // Простая защита — секрет задаётся в Railway Variables как SETUP_SECRET
  const SETUP_SECRET = process.env.SETUP_SECRET || 'wb-setup-2024';
  if (secret !== SETUP_SECRET) {
    return res.status(403).json({ error: 'Неверный секрет. Задайте SETUP_SECRET в Railway Variables.' });
  }
  if (!telegram_id || !token) {
    return res.status(400).json({ error: 'Нужны: secret, telegram_id, token' });
  }

  try {
    // Создаём/обновляем пользователя с сессионным токеном
    await db.query(
      `INSERT INTO users (telegram_id, wb_session_token, wb_session_updated)
       VALUES ($1, $2, NOW())
       ON CONFLICT (telegram_id) DO UPDATE
       SET wb_session_token = $2, wb_session_updated = NOW()`,
      [telegram_id.toString(), token]
    );
    console.log('[setup-token] Token saved for telegram_id:', telegram_id);
    res.json({ success: true, message: 'Токен сохранён для пользователя ' + telegram_id });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ─── DEBUG: тест antibot с разными заголовками ─────────────────────────────
app.post('/debug-antibot', async (req, res) => {
  const axios = require('axios');
  const https  = require('https');
  const dns    = require('dns');
  function ipv4(h, o, cb) { dns.lookup(h, { ...o, family: 4 }, cb); }
  const agent = new https.Agent({ lookup: ipv4, keepAlive: false });

  const results = {};

  // Вариант 1: без Origin/Referer (как нативное приложение)
  try {
    const r1 = await axios.post(
      'https://antibot.wildberries.ru/api/v1/create-one-time-token',
      { payload: '' },
      { headers: { 'Content-Type': 'application/json', 'User-Agent': 'WBPartner/2.0 (Android)' },
        httpsAgent: agent, timeout: 8000, validateStatus: s => s < 600 }
    );
    results.no_origin = { status: r1.status, data: JSON.stringify(r1.data).substring(0, 100) };
  } catch(e) { results.no_origin = { error: e.message }; }

  // Вариант 2: мобильное приложение WB
  try {
    const r2 = await axios.post(
      'https://antibot.wildberries.ru/api/v1/create-one-time-token',
      { payload: '' },
      { headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'okhttp/4.12.0',
          'x-app-name': 'seller',
          'x-app-version': '2.0',
        },
        httpsAgent: agent, timeout: 8000, validateStatus: s => s < 600 }
    );
    results.mobile_app = { status: r2.status, data: JSON.stringify(r2.data).substring(0, 100) };
  } catch(e) { results.mobile_app = { error: e.message }; }

  // Вариант 3: с Origin seller-auth
  try {
    const r3 = await axios.post(
      'https://antibot.wildberries.ru/api/v1/create-one-time-token',
      { payload: '' },
      { headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0',
          'Origin': 'https://seller-auth.wildberries.ru',
          'Referer': 'https://seller-auth.wildberries.ru/ru/',
        },
        httpsAgent: agent, timeout: 8000, validateStatus: s => s < 600 }
    );
    results.seller_auth_origin = { status: r3.status, data: JSON.stringify(r3.data).substring(0, 100) };
  } catch(e) { results.seller_auth_origin = { error: e.message }; }

  // Вариант 4: получаем cfidsw-wb из seller-services
  try {
    const uuid = require('crypto').randomUUID();
    const r4 = await axios.post(
      `https://seller-services.wildberries.ru/sec/api/fl?u=${uuid}&cfidsw-wb=`,
      {},
      { headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0',
          'Origin': 'https://seller.wildberries.ru',
        },
        httpsAgent: agent, timeout: 8000, validateStatus: s => s < 600 }
    );
    const cookies = (r4.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
    results.seller_services = { status: r4.status, cookies, data: JSON.stringify(r4.data).substring(0, 80) };
  } catch(e) { results.seller_services = { error: e.message }; }

  console.log('[debug-antibot]', JSON.stringify(results, null, 2));
  res.json(results);
});


/**
 * POST /auth/antibot-challenge
 * Сервер запрашивает challenge у WB antibot (без CORS ограничений браузера).
 * Возвращает challenge клиенту для сбора fingerprint.
 */
app.post('/auth/antibot-challenge', telegramAuth, async (req, res) => {
  try {
    const axios = require('axios');
    const https = require('https');
    const dns   = require('dns');

    function ipv4Lookup(h, o, cb) { dns.lookup(h, { ...o, family: 4 }, cb); }
    const agent = new https.Agent({ lookup: ipv4Lookup, keepAlive: false });

    const r = await axios.post(
      'https://antibot.wildberries.ru/api/v1/create-one-time-token',
      { payload: '' },
      {
        headers: {
          'Content-Type':   'application/json',
          'Accept':         'application/json',
          'User-Agent':     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Origin':         'https://seller.wildberries.ru',
          'Referer':        'https://seller.wildberries.ru/',
        },
        httpsAgent: agent,
        timeout: 10000,
        validateStatus: s => s < 600,
      }
    );

    console.log('[antibot-challenge] status:', r.status, JSON.stringify(r.data).substring(0, 100));

    if (r.status === 498) {
      // 498 = challenge нужен — отдаём challenge клиенту
      return res.json({ status: 498, challenge: r.data.challenge || r.data });
    }
    if (r.status === 200) {
      // Уже получили token без challenge
      return res.json({ status: 200, token: r.data.token || r.data.one_time_token || '' });
    }
    res.status(r.status).json({ error: 'antibot returned ' + r.status, data: r.data });
  } catch(err) {
    console.error('[antibot-challenge] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /auth/request-sms-v2
 * Отправляет SMS через seller-auth.wildberries.ru/auth/v2/code/wb-captcha
 * captcha_token="" — WB принимает пустой токен (подтверждено DevTools: 200 OK)
 * antibot пропускается — он требует WB-cookies которых у нас нет
 */
app.post('/auth/request-sms-v2', telegramAuth, requireDB, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });

  try {
    const axios = require('axios');
    const https = require('https');
    const dns   = require('dns');

    function ipv4Lookup(h, o, cb) { dns.lookup(h, { ...o, family: 4 }, cb); }
    const agent = new https.Agent({ lookup: ipv4Lookup, keepAlive: false });

    const headers = {
      'Content-Type':  'application/json',
      'Accept':        'application/json, text/plain, */*',
      'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Origin':        'https://seller-auth.wildberries.ru',
      'Referer':       'https://seller-auth.wildberries.ru/ru/',
      'Accept-Language': 'ru-RU,ru;q=0.9',
    };

    // Используем Yandex Cloud Function (российский IP) если задан YANDEX_FN_URL
    const YANDEX_FN = process.env.YANDEX_FN_URL || '';
    if (YANDEX_FN) {
      console.log('[request-sms-v2] Using Yandex Function:', YANDEX_FN);
      try {
        const fnRes = await axios.post(YANDEX_FN,
          { phone },
          { timeout: 90000, validateStatus: s => s < 600 }
        );
        const sticker = fnRes.data?.data?.payload?.sticker || null;
        console.log('[request-sms-v2] Yandex fn result:', fnRes.data?.status, fnRes.data?.success, 'sticker:', sticker?.substring(0,8));
        if (fnRes.data?.success) {
          const reqToken = sticker ? `sticker:${sticker}` : `phone:${phone}`;
          await db.query(
            `INSERT INTO sms_requests (telegram_id, phone, request_token, created_at)
             VALUES ($1, $2, $3, NOW()) ON CONFLICT (telegram_id)
             DO UPDATE SET phone=$2, request_token=$3, created_at=NOW()`,
            [req.telegramId, phone, reqToken]
          );
          return res.json({ success: true, message: 'SMS отправлен на ' + phone });
        }
        if (fnRes.data?.status === 498) {
          // Нужен fingerprint — вернём challenge клиенту (реализуем позже)
          console.log('[request-sms-v2] Yandex fn: need fingerprint challenge');
        }
        // Fallback — продолжаем ниже
      } catch(e) {
        console.warn('[request-sms-v2] Yandex fn error:', e.message, '— fallback');
      }
    }

    // Шаг 1: Получаем cfidsw-wb и другие cookie от WB login-страницы
    let wbCookieStr = '';
    try {
      const initPages = [
        'https://seller-auth.wildberries.ru/ru/',
        'https://seller.wildberries.ru/',
      ];
      for (const url of initPages) {
        const initR = await axios.get(url, {
          headers: { 'User-Agent': headers['User-Agent'], 'Accept': 'text/html,*/*', 'Accept-Language': 'ru-RU,ru;q=0.9' },
          httpsAgent: agent, timeout: 8000, maxRedirects: 3, validateStatus: s => s < 600,
        });
        const cookies = (initR.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
        if (cookies.includes('cfidsw') || cookies.includes('wbx-validation')) {
          wbCookieStr = cookies;
          console.log('[request-sms-v2] Got cookies from', url, ':', cookies.substring(0, 120));
          break;
        }
        if (cookies.length > 0 && !wbCookieStr) wbCookieStr = cookies;
      }
    } catch(e) { console.warn('[request-sms-v2] cookie fetch error:', e.message); }

    // Шаг 2: Пробуем antibot с полученными cookie
    let captchaToken = '';
    if (wbCookieStr) {
      try {
        const antibotHeaders = {
          ...headers,
          Cookie: wbCookieStr,
          Origin: 'https://seller-auth.wildberries.ru',
          Referer: 'https://seller-auth.wildberries.ru/ru/',
        };
        const abR = await axios.post(
          'https://antibot.wildberries.ru/api/v1/create-one-time-token',
          { payload: '' },
          { headers: antibotHeaders, httpsAgent: agent, timeout: 10000, validateStatus: s => s < 600 }
        );
        console.log('[request-sms-v2] antibot status:', abR.status, JSON.stringify(abR.data).substring(0, 100));
        if (abR.status === 200) {
          captchaToken = abR.data.token || abR.data.one_time_token || '';
          console.log('[request-sms-v2] Got captchaToken:', captchaToken.substring(0, 30));
        }
        // 498 = нужен fingerprint (мы пока пропускаем, браузер должен собрать)
      } catch(e) { console.warn('[request-sms-v2] antibot error:', e.message); }
    }

    // Шаг 3: Вызываем wb-captcha
    console.log('[request-sms-v2] Calling wb-captcha for phone:', phone, '| captchaToken:', captchaToken ? 'YES' : 'EMPTY');

    const smsR = await axios.post(
      'https://seller-auth.wildberries.ru/auth/v2/code/wb-captcha',
      { phone_number: phone, captcha_token: captchaToken },
      { headers: { ...headers, ...(wbCookieStr ? { Cookie: wbCookieStr } : {}) },
        httpsAgent: agent, timeout: 15000, validateStatus: s => s < 600 }
    );

    console.log('[request-sms-v2] wb-captcha status:', smsR.status,
                '| body:', JSON.stringify(smsR.data).substring(0, 150));

    if (smsR.status === 200 || smsR.status === 204) {
      await db.query(
        `INSERT INTO sms_requests (telegram_id, phone, request_token, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (telegram_id) DO UPDATE SET phone=$2, request_token=$3, created_at=NOW()`,
        [req.telegramId, phone, 'wbcaptcha:' + phone]
      );
      return res.json({ success: true, message: 'SMS отправлен на ' + phone });
    }

    // Если 401/403 — пробуем старый endpoint как fallback
    console.log('[request-sms-v2] wb-captcha failed, trying legacy endpoint...');
    const fallR = await axios.post(
      'https://seller.wildberries.ru/passport/api/v2/auth/login_by_phone',
      { phone, is_terms_and_conditions_accepted: true },
      { headers: { ...headers, Origin: 'https://seller.wildberries.ru', Referer: 'https://seller.wildberries.ru/' },
        httpsAgent: agent, timeout: 15000, validateStatus: s => s < 600 }
    );
    console.log('[request-sms-v2] legacy endpoint:', fallR.status);

    if (fallR.status === 200 || fallR.status === 204) {
      await db.query(
        `INSERT INTO sms_requests (telegram_id, phone, request_token, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (telegram_id) DO UPDATE SET phone=$2, request_token=$3, created_at=NOW()`,
        [req.telegramId, phone, 'legacy:' + phone]
      );
      return res.json({ success: true, message: 'SMS отправлен на ' + phone });
    }

    const errMsg = (smsR.data?.message || smsR.data?.error || 'WB вернул ' + smsR.status);
    res.status(400).json({ success: false, error: errMsg });

  } catch(err) {
    console.error('[request-sms-v2] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


/**
 * POST /auth/request-sms
 * Шаг 1: Запросить SMS-код на телефон продавца.
 */

// ─── DEBUG: тест SMS эндпоинта WB (убрать после отладки) ─────────────────────
app.post('/debug-sms', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const result = await requestSmsCode(phone);
    res.json({ result, env: { hasToken: !!BOT_TOKEN, testMode: TEST_MODE } });
  } catch(err) {
    res.status(500).json({ error: err.message, stack: err.stack?.split('\n').slice(0,5) });
  }
});

app.post('/auth/request-sms', telegramAuth, requireDB, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Введите номер телефона' });

  try {
    const cleanPhone = phone.replace(/[\s\-\(\)]/g, '');
    console.log('[auth/request-sms] Phone:', cleanPhone);

    // Используем Puppeteer прокси если задан YANDEX_FN_URL
    let result;
    const PROXY_URL = process.env.YANDEX_FN_URL || '';
    if (PROXY_URL) {
      try {
        console.log('[auth/request-sms] Using proxy:', PROXY_URL);
        const axios = require('axios');
        const proxyResp = await axios.post(
          PROXY_URL,
          { phone: cleanPhone },
          {
            timeout: 90000,
            validateStatus: () => true,
            headers: { 'ngrok-skip-browser-warning': 'true', 'User-Agent': 'wb-bot-backend' },
          }
        );
        const pd = proxyResp.data;

        // ngrok вернул HTML (502 / страница-предупреждение) — прокси не запущен
        if (typeof pd === 'string' && pd.includes('<!DOCTYPE html>')) {
          return res.status(503).json({
            success: false,
            error: 'Прокси на Windows не запущен. Запустите proxy.js (node C:\\wb-proxy\\proxy.js) и повторите.',
          });
        }
        if (proxyResp.status === 502 || proxyResp.status === 503) {
          return res.status(503).json({
            success: false,
            error: 'Прокси недоступен (HTTP ' + proxyResp.status + '). Проверьте что proxy.js запущен на Windows.',
          });
        }

        console.log('[auth/request-sms] Proxy result:', JSON.stringify(pd).substring(0, 200));
        const sticker = pd.data?.payload?.sticker || null;
        result = { success: pd.success === true, requestToken: sticker ? `sticker:${sticker}` : null, error: pd.success ? null : (pd.data?.error || pd.error || 'Ошибка прокси') };
      } catch(proxyErr) {
        console.warn('[auth/request-sms] Proxy error:', proxyErr.message);
        // НЕ делаем fallback на requestSmsCode — он даёт phone: путь без захвата x-supplier-id,
        // что приводит к "incorrect supplier id". Лучше честно сообщить об ошибке.
        return res.status(503).json({
          success: false,
          error: 'Прокси на Windows недоступен. Запустите proxy.js и ngrok, затем повторите запрос SMS.',
        });
      }
    } else {
      result = await requestSmsCode(cleanPhone);
    }
    console.log('[auth/request-sms] Result:', JSON.stringify(result).substring(0, 200));

    if (!result.success) {
      // Если Railway не может достучаться до WB — подсказываем открыть на мобильном
      const isNetworkError = result.error && (
        result.error.includes('ENOTFOUND') ||
        result.error.includes('ECONNREFUSED') ||
        result.error.includes('network') ||
        result.error.includes('Failed to fetch')
      );
      const userMsg = isNetworkError
        ? 'Сервер не может достучаться до WB. Пожалуйста, откройте приложение в мобильном Telegram (iOS/Android) — там авторизация работает напрямую.'
        : result.error;
      return res.status(400).json({ success: false, error: userMsg });
    }

    await db.query(
      `INSERT INTO sms_requests (telegram_id, phone, request_token, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (telegram_id) DO UPDATE
         SET phone=$2, request_token=$3, created_at=NOW()`,
      [req.telegramId, phone, result.requestToken || `phone:${phone}`]
    );

    res.json({ success: true, message: 'Код отправлен на ' + phone });
  } catch (err) {
    console.error('/auth/request-sms error:', err.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

/**
 * POST /auth/verify-sms
 * Шаг 2: Подтвердить SMS-код. Получает Authorizev3 сессионный токен.
 * Сохраняет его как wb_session_token — воркер использует его для перемещений.
 */
app.post('/auth/verify-sms', telegramAuth, requireDB, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Введите код из SMS' });

  try {
    const smsReq = await db.query(
      'SELECT phone, request_token FROM sms_requests WHERE telegram_id=$1',
      [req.telegramId]
    );
    if (!smsReq.rows.length) {
      return res.status(400).json({ error: 'Сначала запросите SMS-код' });
    }

    const { phone, request_token } = smsReq.rows[0];
    const result = await confirmSmsCode(phone, code, request_token);

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    // Валидируем что получили реальный RS256 JWT от Puppeteer прокси
    // (не null, не phone:+7..., не ES256 публичный токен)
    const isValidJWT = result.sessionToken &&
      result.sessionToken.startsWith('eyJhbGciOiJSUzI1NiIs') &&
      result.sessionToken.length > 100;

    if (!isValidJWT) {
      console.warn('[verify-sms] ❌ Invalid token type:', result.sessionToken ? result.sessionToken.substring(0,30) : 'NULL');
      return res.status(400).json({
        success: false,
        error: 'Не получилось получить JWT токен. Убедитесь что Windows прокси запущен (node C:\\wb-proxy\\proxy.js)'
      });
    }

    // Сохраняем сессионный токен (Authorizev3) в users
    console.log('[verify-sms] saving token for', req.telegramId,
      '| sessionToken:', result.sessionToken ? result.sessionToken.substring(0,30)+'...' : 'NULL',
      '| cookies:', result.cookies ? result.cookies.substring(0,50)+'...' : 'NULL');
    const saveRes = await db.query(
      `INSERT INTO users (telegram_id, wb_session_token, wb_session_cookies, wb_session_updated, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (telegram_id) DO UPDATE
         SET wb_session_token=$2, wb_session_cookies=$3, wb_session_updated=NOW(), updated_at=NOW()`,
      [req.telegramId, result.sessionToken, result.cookies || null]
    );
    console.log('[verify-sms] saved rows:', saveRes.rowCount);

    // Проверяем что реально записалось
    const checkRes = await db.query(
      'SELECT length(wb_session_token) as tlen, length(wb_session_cookies) as clen FROM users WHERE telegram_id=$1',
      [req.telegramId]
    );
    console.log('[verify-sms] DB check after save:', JSON.stringify(checkRes.rows[0]));

    // Получаем supplier id по сессии и сохраняем (для seller-supply API).
    // Это мультипользовательское решение: каждый юзер получает СВОЙ supplier id.
    try {
      const supplierId = await fetchSupplierId(result.sessionToken, result.cookies);
      if (supplierId) {
        await db.query('UPDATE users SET wb_supplier_id=$1 WHERE telegram_id=$2', [supplierId, req.telegramId]);
        console.log(`[verify-sms] ✅ supplier id сохранён: ${supplierId}`);
      } else {
        console.warn('[verify-sms] ⚠️ supplier id не получен — seller-supply может вернуть 401');
      }
    } catch (e) {
      console.warn('[verify-sms] ошибка получения supplier id:', e.message);
    }

    // Удаляем временный SMS-запрос
    await db.query('DELETE FROM sms_requests WHERE telegram_id=$1', [req.telegramId]);

    res.json({
      success: true,
      message: '✅ Авторизация в Wildberries успешна. Автобронь активирована!'
    });
  } catch (err) {
    console.error('/auth/verify-sms error:', err.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

/**
 * POST /auth/set-session-token
 * Сохраняет Authorizev3 сессионный токен из ЛК продавца.
 * Этот токен нужен для вызовов внутреннего seller-supply API WB.
 */
app.post('/auth/set-session-token', telegramAuth, requireDB, async (req, res) => {
  const { token } = req.body;
  if (!token || token.trim().length < 50) {
    return res.status(400).json({ error: 'Вставьте Authorizev3 токен (длинная строка из DevTools)' });
  }
  const clean = token.trim();
  try {
    // Проверяем токен реальным запросом к internal API
    const testRes = await getWbTransferList(clean).catch(e => {
      if (e.sessionExpired) throw Object.assign(new Error('Токен недействителен (401/403)'), { status: 401 });
      return null; // другие ошибки (нет данных) — не страшны
    });
    await db.query(
      `UPDATE users SET wb_session_token=$1, wb_session_updated=NOW(), updated_at=NOW() WHERE telegram_id=$2`,
      [clean, req.telegramId]
    );
    res.json({ success: true, message: 'Сессионный токен сохранён. Автоброн активирован.' });
  } catch (err) {
    console.error('set-session-token error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * GET /auth/session-status
 * Статус сессионного токена (установлен / давность)
 */
app.get('/auth/session-status', telegramAuth, requireDB, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT wb_session_token, wb_session_updated FROM users WHERE telegram_id=$1',
      [req.telegramId]
    );
    const row = r.rows[0];
    if (!row || !row.wb_session_token) {
      return res.json({ active: false });
    }
    const updatedAt = row.wb_session_updated;
    const ageHours  = updatedAt ? Math.round((Date.now() - new Date(updatedAt)) / 3_600_000) : null;
    res.json({ active: true, updated_at: updatedAt, age_hours: ageHours });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /transfers/check-option
 * Проверяет подключена ли платная опция «Перераспределение остатков между складами».
 * Без неё перемещения невозможны — фронтенд предупреждает пользователя.
 */
app.get('/transfers/check-option', telegramAuth, requireDB, async (req, res) => {
  try {
    const { token: sessionToken, cookies: sessionCookies } = await getUserSessionToken(req.telegramId);
    const result = await checkRedistributionOption(sessionToken, sessionCookies);
    res.json(result);
  } catch (err) {
    console.error('check-option error:', err.message);
    res.json({ active: null, status: 'error', error: err.message });
  }
});

/**
 * GET /transfers/wb-warehouses
 * Список складов WB куда можно ОТПРАВИТЬ товар (для поля «Куда отправить»).
 * Источник — AvailableLimits (quotas с dstQuota > 0), как в реальном ЛК WB.
 */
app.get('/transfers/wb-warehouses', telegramAuth, requireDB, async (req, res) => {
  try {
    const token = await getUserToken(req.telegramId);
    if (!token) return res.status(401).json({ error: 'Сначала подключите WB API-токен' });

    // Берём склады из квот — только те что реально принимают товар
    const { token: sessionToken, cookies: sessionCookies } = await getUserSessionToken(req.telegramId);
    if (sessionToken && sessionToken.startsWith('eyJhbGciOiJSUzI1NiIs')) {
      try {
        const quotas = await getTransferAvailableLimits(sessionToken, null, sessionCookies);
        // Только склады принимающие товар (dstQuota > 0), исключаем служебные
        const names = quotas
          .filter(q => (q.dstQuota || 0) > 0)
          .map(q => q.displayName || q.officeName)
          .filter(Boolean)
          .filter(n => !/остальные|питание/i.test(n))
          .sort((a, b) => a.localeCompare(b, 'ru'));
        const unique = [...new Set(names)];
        console.log(`[wb-warehouses] ${unique.length} складов с dstQuota>0`);
        return res.json({ warehouses: unique });
      } catch (e) {
        console.warn('[wb-warehouses] AvailableLimits failed:', e.message);
      }
    }

    // Fallback: старый способ (Analytics остатки), но фильтруем служебные записи
    const names = (await getWbFboWarehouseNames(token))
      .filter(n => !/остальные|питание/i.test(n));
    res.json({ warehouses: names });
  } catch(err) {
    console.error('wb-warehouses error:', err.message);
    res.json({ warehouses: [], error: err.message });
  }
});

/**
 * GET /transfers/article-stocks/:nmId
 * Поиск товара по артикулу WB + остатки по складам
 */
app.get('/transfers/article-stocks/:nmId', telegramAuth, requireDB, async (req, res) => {
  const { nmId } = req.params;
  if (!/^\d+$/.test(nmId)) return res.status(400).json({ error: 'Некорректный артикул' });
  try {
    const token = await getUserToken(req.telegramId);
    if (!token) return res.status(401).json({ error: 'Сначала подключите WB API-токен' });
    const { token: sessionToken, cookies: sessionCookies } = await getUserSessionToken(req.telegramId);
    const { article, warehouses, source } = await getArticleStocks(token, nmId, sessionToken, sessionCookies);
    if (!article) return res.status(404).json({
      error: 'Артикул не найден. Убедитесь что токен имеет категории Content и Статистика.'
    });
    console.log(`[article-stocks] nmId=${nmId} source=${source} warehouses=${warehouses.length}`);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.json({ nmId: article.nmId, name: article.name, warehouses });
  } catch(err) {
    console.error('article-stocks error:', err.message, err.hint || '');
    const hint = err.hint === 'statistics_token_required'
      ? ' Откройте настройки API-токена в ЛК WB и добавьте категорию «Статистика».'
      : '';
    res.status(err.status < 500 ? err.status || 500 : 500).json({
      error: (err.wbDetail || err.message) + hint
    });
  }
});

/**
 * DELETE /transfers/:id
 * Удалить запрос на перемещение (только свой, только в статусе pending).
 */
app.delete('/transfers/:id', telegramAuth, requireDB, async (req, res) => {
  const { id } = req.params;
  if (!Number.isInteger(Number(id))) {
    return res.status(400).json({ error: 'Некорректный ID' });
  }

  try {
    const result = await db.query(
      `DELETE FROM transfer_requests
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [id, req.telegramId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Запрос не найден или уже удалён' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENTS — заглушка (планируется ЮKassa)
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/payments/create', telegramAuth, (req, res) => {
  // TODO: интеграция с yookassa-sdk
  res.status(503).json({
    error: 'Платёжный сервис временно недоступен. Планируется интеграция с ЮKassa.'
  });
});

app.get('/payments/history', telegramAuth, requireDB, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC',
      [req.telegramId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки истории платежей' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// СЛУЖЕБНЫЕ МАРШРУТЫ
// ═══════════════════════════════════════════════════════════════════════════════


// ─── DEBUG: диагностика initData (убрать после отладки) ──────────────────────
app.post('/debug-auth', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const spaceIdx   = authHeader.indexOf(' ');
  const authData   = spaceIdx !== -1 ? authHeader.substring(spaceIdx + 1) : '';
  const params     = {};
  try {
    new URLSearchParams(authData).forEach((v, k) => {
      params[k] = k === 'hash' ? v : v.substring(0, 80);
    });
  } catch {}
  res.json({
    header_length:   authHeader.length,
    authdata_length: authData.length,
    has_hash:        authData.includes('hash='),
    params_found:    Object.keys(params),
    raw_snippet:     authData.substring(0, 100),
    bot_token_set:   !!BOT_TOKEN,
    bot_token_len:   BOT_TOKEN ? BOT_TOKEN.length : 0,
  });
});


// ─── Ручной запуск настройки бота (вызвать один раз после деплоя) ─────────────
app.get('/setup-bot', async (req, res) => {
  try {
    await setupBot();
    res.json({ success: true, message: 'Бот настроен. Проверьте логи Railway.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    db: dbReady ? 'connected' : 'connecting',
    test_mode: TEST_MODE,
    timestamp: new Date().toISOString()
  });
});

app.get('/check-files', (req, res) => {
  const rootFiles   = fs.readdirSync(__dirname);
  const publicPath  = path.join(__dirname, 'public');
  const publicFiles = fs.existsSync(publicPath)
    ? fs.readdirSync(publicPath).join(', ')
    : 'папка public не найдена';
  res.json({ rootFiles, publicFiles, test_mode: TEST_MODE });
});


// ═══════════════════════════════════════════════════════════════════════════════
// TELEGRAM BOT — webhook + кнопки Mini App
// ═══════════════════════════════════════════════════════════════════════════════

const APP_URL = (process.env.APP_URL || '').replace(/\/$/, ''); // убираем слэш в конце

/**
 * Webhook — принимает updates от Telegram
 * Telegram шлёт сюда все сообщения боту
 */
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Telegram требует быстрый 200 OK

  const update = req.body;
  if (!update) return;

  const message  = update.message;
  const callback = update.callback_query;

  try {
    if (message) {
      const chatId = message.chat.id;
      const text   = message.text || '';

      if (text.startsWith('/start')) {
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: '👋 Добро пожаловать в *WB Supply Helper*\n\nАвтоматизация перераспределения остатков товаров между складами Wildberries.',
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{
              text: '🛒 Открыть приложение',
              web_app: { url: APP_URL }   // ← тип web_app, не url!
            }]]
          }
        });
      }
    }
  } catch (err) {
    console.error('❌ Ошибка обработки webhook:', err.message);
  }
});

/**
 * Вспомогательная функция для вызова Telegram Bot API
 */
async function tgApi(method, data) {
  const res = await axios.post(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    data,
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
  );
  return res.data;
}

/**
 * Настройка бота при старте:
 * - регистрирует webhook URL
 * - устанавливает кнопку меню типа web_app для всех пользователей
 */
async function setupBot() {
  if (!BOT_TOKEN) {
    console.warn('⚠️  TELEGRAM_BOT_TOKEN не задан — бот не настроен');
    return;
  }
  if (!APP_URL) {
    console.warn('⚠️  APP_URL не задан — webhook и кнопка меню не настроены');
    return;
  }

  try {
    // 1. Регистрируем webhook
    const webhookUrl = `${APP_URL}/webhook`;
    const wh = await tgApi('setWebhook', {
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true
    });
    console.log('✅ Webhook установлен:', webhookUrl, '|', wh.description);

    // 2. Устанавливаем кнопку меню типа web_app (для всех чатов)
    const mb = await tgApi('setChatMenuButton', {
      menu_button: {
        type: 'web_app',
        text: 'Открыть приложение',
        web_app: { url: APP_URL }
      }
    });
    console.log('✅ Кнопка меню настроена:', mb.description || JSON.stringify(mb));

    // 3. Устанавливаем команды бота
    await tgApi('setMyCommands', {
      commands: [
        { command: 'start', description: 'Открыть WB Supply Helper' }
      ]
    });
    console.log('✅ Команды бота зарегистрированы');

  } catch (err) {
    console.error('❌ Ошибка настройки бота:', err.response?.data || err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ФОНОВЫЙ ВОРКЕР — автоматическое выполнение заявок на перемещение
// ═══════════════════════════════════════════════════════════════════════════════

const WORKER_INTERVAL    = 10_000;  // 10 сек между циклами
const API_DELAY          = 300;     // 300 мс между запросами к WB API (≤300 req/min)
const RETRY_409_DELAY    = 30_000;       // 30 сек — как у конкурентов (мониторинг слотов)
const RETRY_UNKNOWN_DELAY= 60_000;  // 60 сек повтор при неизвестной ошибке
const MAX_RETRY_COUNT    = 2880;    // 2880 × 30 сек = 24 часа

let workerRunning = false;
const userRateLimits = {};  // { telegramId → timestamp до которого нельзя делать запросы }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Главный цикл воркера. Запускается каждые WORKER_INTERVAL мс.
 * За один цикл обрабатывает по одной заявке на каждого пользователя.
 */
async function transferWorker() {
  if (!dbReady) return;
  if (workerRunning) { console.log('[worker] Предыдущий цикл ещё выполняется, пропускаем'); return; }
  workerRunning = true;

  try {
    // Берём pending-заявки с токенами пользователей
    const { rows } = await db.query(`
      SELECT tr.id, tr.user_id, tr.from_warehouse, tr.to_warehouse,
             tr.sku, tr.amount, tr.retry_count, tr.moved, tr.product_name,
             u.wb_token
      FROM   transfer_requests tr
      JOIN   users u ON u.telegram_id = tr.user_id
      WHERE  tr.status = 'pending'
        AND  u.wb_token IS NOT NULL
        AND  (tr.next_retry_at IS NULL OR tr.next_retry_at <= NOW())
      ORDER BY tr.created_at ASC
      LIMIT  100
    `);

    if (!rows.length) return;
    console.log(`[worker] Цикл: ${rows.length} заявок в очереди`);

    // Параллельная обработка всех заявок одновременно (как у конкурента)
    // Максимум 3 заявки на пользователя за цикл чтобы не перегружать
    const perUser = {};
    const toProcess = [];
    for (const req of rows) {
      perUser[req.user_id] = (perUser[req.user_id] || 0) + 1;
      if (perUser[req.user_id] > 3) continue;
      const rateUntil = userRateLimits[req.user_id];
      if (rateUntil && Date.now() < rateUntil) {
        console.log(`[worker] User ${req.user_id} rate-limited, пропускаем`);
        continue;
      }
      toProcess.push(req);
    }

    // Все параллельно — не ждём завершения одной чтобы начать другую
    await Promise.allSettled(toProcess.map(req => processRequest(req)));
  } catch (err) {
    console.error('[worker] Критическая ошибка цикла:', err.message);
  } finally {
    workerRunning = false;
  }
}

/**
 * Обрабатывает одну заявку на перемещение.
 */
async function processRequest(req) {
  console.log(`[worker] → #${req.id} | ${req.from_warehouse} → ${req.to_warehouse} | SKU ${req.sku} × ${req.amount} | попытка ${req.retry_count + 1}`);

  try {
    const result = await executeRedistribution(req.wb_token, req);

    const total = Number(req.amount);

    // Успех ТОЛЬКО при явном подтверждении перемещения от WB.
    // Если result пустой/без wasMoved — это НЕ успех (защита от ложных «выполнена»).
    if (!result || typeof result.wasMoved !== 'number' || result.wasMoved <= (req.moved || 0)) {
      // Перемещение не подтверждено — повторяем, НЕ уведомляем об успехе
      const nextRetry = new Date(Date.now() + RETRY_409_DELAY);
      const newCount  = req.retry_count + 1;
      await db.query(
        `UPDATE transfer_requests SET next_retry_at=\$1, retry_count=\$2, error_message=\$3 WHERE id=\$4`,
        [nextRetry, newCount, 'Перемещение не подтверждено WB, повтор', req.id]
      );
      console.log(`[worker] ⚠️ #${req.id} перемещение не подтверждено (result пустой) — повтор`);
      return;
    }

    const wasMoved = result.wasMoved;

    if (wasMoved >= total) {
      // ✅ Полностью перемещено
      await db.query(
        `UPDATE transfer_requests SET status='done', moved=\$2, error_message=NULL, updated_at=NOW() WHERE id=\$1`,
        [req.id, total]
      );
      await notifyUser(req.user_id, '✅ Заявка выполнена', req);
      console.log(`[worker] ✅ #${req.id} выполнена полностью (${total} ед)`);
    } else {
      // ⏳ Частично перемещено — сохраняем прогресс, продолжаем ловить квоту
      const justMoved = result.moved || 0;
      const nextRetry = new Date(Date.now() + RETRY_409_DELAY);
      await db.query(
        `UPDATE transfer_requests SET moved=\$2, next_retry_at=\$3, error_message=\$4, updated_at=NOW() WHERE id=\$1`,
        [req.id, wasMoved, nextRetry, `Перемещено ${wasMoved} из ${total}, ждём квоту на остаток`]
      );
      await notifyUser(
        req.user_id,
        `⏳ Перемещено ${justMoved} ед (всего ${wasMoved} из ${total}). Ждём квоту на оставшиеся ${total - wasMoved}.`,
        req
      );
      console.log(`[worker] ⏳ #${req.id} частично: ${wasMoved}/${total}, продолжаем`);
    }

  } catch (err) {
    const status   = err.status || 0;
    const wbDetail = err.wbDetail || err.message;

    if (status === 429) {
      // Rate limit — ждём X-Ratelimit-Retry секунд
      const waitSec = err.retryAfter || 60;
      userRateLimits[req.user_id] = Date.now() + waitSec * 1000;
      console.log(`[worker] ⏳ #${req.id} rate limit, ждём ${waitSec}с`);
      // Не увеличиваем retry_count при rate limit

    } else if (status === 409) {
      // Временное препятствие (нет квоты / мало остатка / склад не принимает) — повтор
      const nextRetry = new Date(Date.now() + RETRY_409_DELAY);
      const newCount  = req.retry_count + 1;
      if (newCount >= MAX_RETRY_COUNT) {
        await db.query(
          `UPDATE transfer_requests SET status='failed', error_message=\$1, updated_at=NOW() WHERE id=\$2`,
          [wbDetail || 'Перемещение недоступно 24+ часа подряд', req.id]
        );
        await notifyUser(req.user_id, `❌ Заявка отменена: ${wbDetail || 'условия не выполнились за 24 часа'}`, req);
      } else {
        await db.query(
          `UPDATE transfer_requests SET next_retry_at=\$1, retry_count=\$2, error_message=\$3 WHERE id=\$4`,
          [nextRetry, newCount, `409: ${wbDetail} (попытка ${newCount})`, req.id]
        );
        console.log(`[worker] ⚠️  #${req.id} повтор: ${wbDetail} → ${nextRetry.toISOString()}`);
      }

    } else if (status === 400) {
      // Ошибка данных — не повторяем, помечаем failed
      await db.query(
        `UPDATE transfer_requests SET status='failed', error_message=\$1, updated_at=NOW() WHERE id=\$2`,
        [wbDetail, req.id]
      );
      await notifyUser(req.user_id, `❌ Ошибка заявки: ${wbDetail}`, req);
      console.log(`[worker] ❌ #${req.id} ошибка данных: ${wbDetail}`);

    } else {
      // Временная ошибка — повторяем через минуту
      const nextRetry = new Date(Date.now() + RETRY_UNKNOWN_DELAY);
      const newCount  = req.retry_count + 1;
      await db.query(
        `UPDATE transfer_requests SET next_retry_at=\$1, retry_count=\$2, error_message=\$3 WHERE id=\$4`,
        [nextRetry, newCount, `${status || 'err'}: ${wbDetail}`, req.id]
      );
      console.error(`[worker] ⚠️  #${req.id} ошибка ${status}: ${wbDetail}, повтор через 60с`);
    }
  }
}

/**
 * Выполняет FBO-перемещение через внутренний seller-supply API WB.
 * Использует Authorizev3 сессионный токен (имитация браузерной сессии).
 *
 * Стратегия:
 * 1. Берём сессионный токен пользователя из БД
 * 2. Вызываем AvailableLimits — проверяем есть ли квота на складе
 * 3. Если квота есть — вызываем POST /transfer для создания перемещения
 * 4. Если сессионный токен не задан — ошибка с инструкцией
 */
async function executeRedistribution(wbToken, req) {
  // Получаем сессионный токен пользователя
  const { token: sessionToken, cookies: sessionCookies } = await getUserSessionToken(req.user_id);

  if (!sessionToken) {
    const e = new Error(
      'Сессионный токен не задан. Авторизуйтесь в Mini App через SMS'
    );
    e.status = 400;
    throw e;
  }

  // Проверяем что токен - RS256 сессионный JWT (не публичный ES256)
  // Публичный токен начинается с eyJhbGciOiJFUzI1NiIs, сессионный - eyJhbGciOiJSUzI1NiIs
  if (sessionToken.startsWith('eyJhbGciOiJFUzI1NiIs')) {
    const e = new Error(
      'Нужна повторная SMS авторизация — сессионный токен не найден'
    );
    e.status = 400;
    throw e;
  }

  const normalize = s => (s || '').toLowerCase().replace(/[^а-яёa-z0-9]/gi, '');

  // Шаг 1: Получаем остатки артикула по складам (откуда можно забрать).
  // transfer/list возвращает chrts[] с warehouseID, warehouseName, count, dstWarehouseIDs[]
  let chrts;
  try {
    chrts = await getTransferStockByWarehouse(sessionToken, req.sku, sessionCookies);
    console.log(`[worker] transfer/list: ${chrts.length} складов с остатком для nmId=${req.sku}`);
  } catch (err) {
    if (err.sessionExpired) {
      const e = new Error('Сессионный токен истёк. Авторизуйтесь снова через SMS в Mini App.');
      e.status = 400;
      throw e;
    }
    throw err;
  }

  if (!chrts || chrts.length === 0) {
    const e = new Error(`Нет остатков артикула ${req.sku} ни на одном складе для перемещения`);
    e.status = 409;
    throw e;
  }

  // Ищем склад-ИСТОЧНИК по названию среди складов где есть остаток
  const srcWh = chrts.find(c =>
    normalize(c.warehouseName).includes(normalize(req.from_warehouse)) ||
    normalize(req.from_warehouse).includes(normalize(c.warehouseName))
  );

  if (!srcWh) {
    const available = chrts.map(c => `${c.warehouseName}(${c.count})`).join(', ');
    const e = new Error(`На складе «${req.from_warehouse}» нет остатков артикула. Доступны: ${available}`);
    e.status = 409;
    throw e;
  }

  const srcOfficeId = srcWh.warehouseID;
  const chrtId      = srcWh.chrtID;
  console.log(`[worker] источник: ${srcWh.warehouseName} (officeID=${srcOfficeId}, остаток=${srcWh.count}, chrtID=${chrtId})`);

  // Проверяем что на складе хватает остатка
  if (srcWh.count < Number(req.amount)) {
    const e = new Error(`На складе «${req.from_warehouse}» только ${srcWh.count} шт, запрошено ${req.amount}`);
    e.status = 409;
    throw e;
  }

  // Шаг 2: Получаем квоты складов (куда можно принять товар).
  // AvailableLimits возвращает quotas[] с officeID, officeName, srcQuota, dstQuota
  let quotas;
  try {
    quotas = await getTransferAvailableLimits(sessionToken, req.sku, sessionCookies);
    console.log(`[worker] AvailableLimits: ${quotas.length} складов с квотами`);
  } catch (err) {
    if (err.sessionExpired) {
      const e = new Error('Сессионный токен истёк. Авторизуйтесь снова через SMS в Mini App.');
      e.status = 400;
      throw e;
    }
    throw err;
  }

  // Ищем склад-НАЗНАЧЕНИЕ по названию среди квот с dstQuota > 0
  const dstQuota = quotas.find(q =>
    normalize(q.officeName).includes(normalize(req.to_warehouse)) ||
    normalize(q.displayName || '').includes(normalize(req.to_warehouse)) ||
    normalize(req.to_warehouse).includes(normalize(q.officeName))
  );

  if (!dstQuota) {
    const e = new Error(`Склад назначения «${req.to_warehouse}» не найден в списке квот`);
    e.status = 409;
    throw e;
  }

  const dstOfficeId = dstQuota.officeID;
  console.log(`[worker] назначение: ${dstQuota.officeName} (officeID=${dstOfficeId}, dstQuota=${dstQuota.dstQuota})`);

  // Проверяем квоту ИСТОЧНИКА — открыта ли отгрузка с этого склада сейчас.
  // srcQuota=0 — квота временно закрыта. WB открывает квоты порциями в течение дня,
  // поэтому это ПОВТОР (409), а не отказ — воркер ждёт появления квоты. В этом суть бота.
  const srcQuota = quotas.find(q => q.officeID === srcOfficeId);
  const srcQuotaValue = srcQuota ? srcQuota.srcQuota : 0;
  console.log(`[worker] квота источника «${req.from_warehouse}»: srcQuota=${srcQuotaValue}`);

  if (srcQuotaValue <= 0) {
    const e = new Error(`Квота отгрузки со склада «${req.from_warehouse}» пока закрыта (srcQuota=0). Ждём открытия.`);
    e.status = 409; // ПОВТОР — ждём пока WB откроет квоту
    throw e;
  }

  // Сколько ещё осталось переместить (с учётом уже перемещённого ранее частями)
  const alreadyMoved = req.moved || 0;
  const remaining    = Number(req.amount) - alreadyMoved;
  if (remaining <= 0) {
    return; // всё уже перемещено — заявка будет помечена done выше по потоку
  }

  // Сколько реально можем переместить за эту попытку — минимум из:
  // остатка к перемещению, остатка на складе, открытой квоты отгрузки, квоты приёма
  const moveNow = Math.min(
    remaining,
    srcWh.count,
    srcQuotaValue,
    dstQuota.dstQuota
  );
  console.log(`[worker] можем переместить сейчас: ${moveNow} (осталось=${remaining}, остаток склада=${srcWh.count}, srcQuota=${srcQuotaValue}, dstQuota=${dstQuota.dstQuota})`);

  if (moveNow <= 0) {
    const e = new Error(`Нет доступной квоты для перемещения прямо сейчас. Ждём.`);
    e.status = 409;
    throw e;
  }

  // Проверяем что назначение есть в списке разрешённых направлений источника
  if (Array.isArray(srcWh.dstWarehouseIDs) && !srcWh.dstWarehouseIDs.includes(dstOfficeId)) {
    const e = new Error(`Перемещение «${req.from_warehouse}» → «${req.to_warehouse}» недоступно для этого артикула`);
    e.status = 409;
    throw e;
  }

  // Шаг 3: Создаём перемещение на moveNow единиц
  console.log(`[worker] createWbTransfer: nmID=${req.sku} chrtID=${chrtId} src=${srcOfficeId} dst=${dstOfficeId} count=${moveNow}`);
  const createResult = await createWbTransfer(sessionToken, {
    nmId:         Number(req.sku),
    chrtId:       chrtId,
    fromOfficeId: srcOfficeId,
    toOfficeId:   dstOfficeId,
    amount:       moveNow,
  }, sessionCookies);
  console.log(`[worker] ✅ перемещено ${moveNow} ед:`, JSON.stringify(createResult).substring(0, 150));

  // Возвращаем сколько переместили — обработчик решит done или продолжать частями
  return { moved: moveNow, total: Number(req.amount), wasMoved: alreadyMoved + moveNow };
}

/**
 * Отправляет уведомление пользователю в Telegram.
 */
async function notifyUser(telegramId, text, req) {
  if (!BOT_TOKEN) return;
  try {
    let articleLine = `✅ Артикул: ${req.sku}`;
    if (req.product_name) {
      articleLine += ` (${req.product_name})`;
    }
    const detail = req
      ? `\n✅ Поставщик: Текущий аккаунт WB\n✅ Склад: ${req.from_warehouse} ➡️ ${req.to_warehouse}\n${articleLine}\n✅ Единиц товара: ${req.amount}`
      : '';
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: telegramId, text: `‼️ Заявка на перемещение выполнена ‼️\n${detail}`, parse_mode: 'HTML' },
      { timeout: 8000 }
    );
  } catch (e) {
    console.error('[notify] Ошибка отправки уведомления:', e.message);
  }
}

// ─── Запуск воркера ───────────────────────────────────────────────────────────
function startWorker() {
  console.log(`🔄 Фоновый воркер запущен (интервал ${WORKER_INTERVAL / 1000}с)`);
  setInterval(transferWorker, WORKER_INTERVAL);
  // Первый запуск через 5 сек после старта (дать время подключиться к БД)
  setTimeout(transferWorker, 5000);
}

// ─── Запуск ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`🔧 Тестовый режим: ${TEST_MODE ? 'ВКЛ (telegramId=12345)' : 'ВЫКЛ (проверка Telegram)'}`);
  console.log(`📦 Статика: ${path.join(__dirname, 'public')}`);
  console.log(`🌐 APP_URL: ${APP_URL || 'не задан'}`);
  // Настраиваем бота и запускаем воркер
  setTimeout(setupBot, 2000);
  startWorker();
});
