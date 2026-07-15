// server.js — WB_Logistic_bot Backend
// Авторизация продавца: Bearer API-токен из ЛК Wildberries
// Telegram Mini App: валидация initData через @telegram-apps/init-data-node

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const crypto = require('crypto');
// @telegram-apps/init-data-node заменён на прямую реализацию алгоритма Telegram
const { validateWbToken, decodeWbToken, requestSmsCode, confirmSmsCode } = require('./wb-auth');
const { getWarehouses, getStocks, updateStocks, getAllCards, extractSkusFromCards, getArticleStocks, getWbFboWarehouseNames, getTransferAvailableLimits, getTransferStockByWarehouse, createWbTransfer, getWbTransferList, getInventoryList, checkRedistributionOption, refreshWbSession, fetchSupplierId, onAntibotChange, getWarehouseSupplyTypes } = require('./wb-api');
const axios = require('axios');
const path = require('path');
const fs   = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// URL прокси-ПК, где живёт браузерный пул и откуда уходит /order (тот же IP, что у токена).
// Это публичный ngrok-адрес прокси-машины. /create-transfer делает токен + /order локально.
const PROXY_TRANSFER_URL = process.env.PROXY_TRANSFER_URL || (process.env.YANDEX_FN_URL ? process.env.YANDEX_FN_URL.replace(/\/$/, '') + '/create-transfer' : '');

// Минимальный интервал между обновлениями сессии одного пользователя (троттл refresh).
// Authorizev3 имеет короткий exp (~5мин), без троттла /auth/token дёргался бы каждый цикл.
const REFRESH_MIN_INTERVAL_MS = 4 * 60 * 1000; // 4 минуты

// Telegram id администратора для системных оповещений (изменение antibot и т.п.).
// Задаётся через переменную окружения ADMIN_CHAT_ID; если не задана — берётся дефолт владельца.
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '285237021';

// ─── Тестовый режим ───────────────────────────────────────────────────────────
// true  — отключает проверку подписи Telegram, telegramId = 12345 (для отладки из браузера)
// false — включает строгую валидацию Telegram initData (для продакшена)
const TEST_MODE = process.env.TEST_MODE === 'true' || false;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── База данных ──────────────────────────────────────────────────────────────
// КРИТИЧНО: ловим необработанные ошибки на уровне процесса, чтобы единичный
// сбой (разрыв соединения, ошибка в промисе) не ронял весь бот. Логируем и продолжаем.
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ [process] unhandledRejection (бот продолжает работу):', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ [process] uncaughtException (бот продолжает работу):', err?.message || err);
});

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,                        // до 10 параллельных соединений
  idleTimeoutMillis: 30000,       // закрывать простаивающие через 30с
  connectionTimeoutMillis: 10000, // таймаут на получение соединения
  keepAlive: true,                // TCP keep-alive против разрывов
});

// КРИТИЧНО: без этого обработчика разрыв соединения крашит весь процесс
// (Unhandled 'error' event). Pool сам переподключится к следующему запросу.
db.on('error', (err) => {
  console.error('⚠️ [db pool] ошибка соединения (не критично, пул переподключится):', err.message);
});


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
    ALTER TABLE transfer_requests ADD COLUMN IF NOT EXISTS waybill        TEXT;
    ALTER TABLE transfer_requests ADD COLUMN IF NOT EXISTS waybill_mime   VARCHAR(120);

    -- История успешных перемещений для блокировки повтора той же пары товар→склад в течение 72ч.
    -- WB не даёт двигать ту же пару (товар + склад-источник) раньше чем через 72 часа.
    CREATE TABLE IF NOT EXISTS transfer_history (
      id             SERIAL PRIMARY KEY,
      user_id        BIGINT NOT NULL,
      from_warehouse VARCHAR(255) NOT NULL,
      sku            VARCHAR(100) NOT NULL,
      moved_at       TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_transfer_history_lookup
      ON transfer_history (user_id, from_warehouse, sku, moved_at);

    CREATE TABLE IF NOT EXISTS payments (
      id           SERIAL PRIMARY KEY,
      user_id      BIGINT NOT NULL,
      amount       NUMERIC(10, 2),
      units        INTEGER,
      status       VARCHAR(50) DEFAULT 'pending',
      yookassa_id  VARCHAR(255) UNIQUE,
      email        VARCHAR(255),
      created_at   TIMESTAMP DEFAULT NOW(),
      updated_at   TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS email      VARCHAR(255);
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

    -- Промокоды: каждый даёт фиксированное число единиц перемещений, активируется 1 раз
    CREATE TABLE IF NOT EXISTS promo_codes (
      code          VARCHAR(32) PRIMARY KEY,
      units         INTEGER NOT NULL,
      used_by       BIGINT,               -- telegram_id того, кто активировал (NULL = не использован)
      used_at       TIMESTAMP,
      created_at    TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ Таблицы БД проверены/созданы');
}

// Флаг готовности БД — маршруты возвращают 503 пока БД не поднялась
let dbReady = false;

async function connectDB(attempt = 1) {
  try {
    // Pool подключается лениво. Проверяем доступность простым запросом.
    await db.query('SELECT 1');
    console.log('✅ PostgreSQL подключён (Pool)');
    await initDB();
    dbReady = true;
    console.log('✅ БД готова к работе');
  } catch (err) {
    const delay = Math.min(attempt * 2000, 30000);
    console.error(`❌ Ошибка инициализации БД (попытка ${attempt}):`, err.message);
    if (err.stack) console.error(err.stack.split('\n').slice(0, 4).join('\n'));
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
  // ВАЖНО: refresh троттлится по реальному времени (wb_session_updated), чтобы не дёргать
  // /auth/token каждый цикл (Authorizev3 имеет короткий exp ~5мин). Минимум REFRESH_MIN_INTERVAL_MS между обновлениями.
  if (token && token.startsWith('eyJhbGciOiJSUzI1NiIs')) {
    let needRefresh = false;

    // Троттл: не обновляем чаще чем раз в REFRESH_MIN_INTERVAL_MS
    const lastUpdated = row?.wb_session_updated ? new Date(row.wb_session_updated).getTime() : 0;
    const sinceLast = Date.now() - lastUpdated;
    const throttled = sinceLast < REFRESH_MIN_INTERVAL_MS;

    if (!throttled) {
      try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        const ageSec = Math.floor(Date.now() / 1000) - (payload.iat || 0);
        if (payload.exp) {
          // обновляем за 5 мин до истечения
          needRefresh = (payload.exp - Math.floor(Date.now() / 1000)) < 300;
        } else {
          needRefresh = ageSec > 2 * 3600;
        }
      } catch { needRefresh = false; }
    }

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
    // Блокировка повтора в течение 72ч: WB не двигает ту же пару (товар + склад-источник)
    // раньше чем через 72 часа после успешного перемещения.
    const blockRes = await db.query(
      `SELECT moved_at FROM transfer_history
       WHERE user_id=$1 AND from_warehouse=$2 AND sku=$3
         AND moved_at > NOW() - INTERVAL '72 hours'
       ORDER BY moved_at DESC LIMIT 1`,
      [req.telegramId, from_warehouse, String(sku)]
    );
    if (blockRes.rows.length > 0) {
      const movedAt = new Date(blockRes.rows[0].moved_at);
      const unlockAt = new Date(movedAt.getTime() + 72 * 60 * 60 * 1000);
      const hoursLeft = Math.ceil((unlockAt - Date.now()) / (60 * 60 * 1000));
      const unlockStr = unlockAt.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      return res.status(409).json({
        error: 'repeat_blocked',
        message: `Повторное перемещение этого товара с этого склада заблокировано. Wildberries разрешает повтор только через 72 часа. Осталось ~${hoursLeft} ч (можно будет ${unlockStr} МСК).`,
      });
    }
  } catch (e) {
    console.warn('[create] не удалось проверить 72ч-блокировку:', e.message);
    // не блокируем создание при ошибке проверки
  }

  // Проверка баланса: количество в заявке не должно превышать доступный баланс.
  try {
    const available = await getAvailableBalance(req.telegramId);
    const need = parseInt(amount, 10);
    if (need > available) {
      const over = need - available;
      return res.status(409).json({
        error: 'insufficient_balance',
        message: `Количество товара в запросе (${need}) превышает текущий баланс перемещений (${Math.max(available,0)}) на ${over} ед. Отредактируйте количество товара в запросе (не более ${Math.max(available,0)} ед.) или пополните баланс.`,
        available: Math.max(available, 0),
        requested: need,
      });
    }
  } catch (e) {
    console.warn('[create] не удалось проверить баланс:', e.message);
    // При ошибке проверки — не блокируем (не ломаем работу из-за сбоя БД)
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
      'SELECT id, user_id, from_warehouse, to_warehouse, sku, amount, status, retry_count, error_message, next_retry_at, created_at, updated_at, product_name FROM transfer_requests WHERE user_id = $1 ORDER BY created_at DESC',
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
 * GET /transfers/warehouse-restrictions?dstWarehouseId=507
 * Проверяет ограничения склада назначения по типам поставок (с 9 июля 2026).
 * Монопаллета-only = перемещение недоступно.
 */
app.get('/transfers/warehouse-restrictions', telegramAuth, requireDB, async (req, res) => {
  try {
    const { dstWarehouseId } = req.query;
    const token = await getUserToken(req.telegramId);

    // Если API-токена нет — не можем проверить, не блокируем (предупреждаем только при наличии данных)
    if (!token || !dstWarehouseId) {
      return res.json({ canTransfer: true, warning: null });
    }

    const supplyMap = await getWarehouseSupplyTypes(token);
    const warehouseId = Number(dstWarehouseId);
    const wh = supplyMap.get(warehouseId);

    if (!wh) {
      return res.json({ canTransfer: true, warning: null, note: 'Информация о складе не найдена' });
    }

    if (wh.isMonoPalletOnly) {
      return res.json({
        canTransfer: false,
        warning: `⚠️ Склад «${wh.name}» принимает товар только в монопаллетах. По новым правилам WB (с 9 июля 2026) перемещение туда недоступно. Выберите другой склад или дождитесь изменения ограничений.`,
        boxTypes: wh.boxTypes,
      });
    }

    if (wh.hasMono && wh.hasBox) {
      return res.json({
        canTransfer: true,
        warning: `ℹ️ Склад «${wh.name}» принимает несколько типов поставок (в т.ч. монопаллету). Перемещение доступно, но если временно введут ограничение только на монопаллету — оно станет недоступным.`,
        boxTypes: wh.boxTypes,
      });
    }

    return res.json({ canTransfer: true, warning: null, boxTypes: wh.boxTypes });
  } catch (err) {
    console.error('[warehouse-restrictions] error:', err.message);
    res.json({ canTransfer: true, warning: null, error: err.message });
  }
});

/**
 * GET /transfers/wb-warehouses
 * Список складов WB куда можно ОТПРАВИТЬ товар (для поля «Куда отправить»).
 * Источник — AvailableLimits (quotas с dstQuota > 0), как в реальном ЛК WB.
 */
app.get('/transfers/wb-warehouses', telegramAuth, requireDB, async (req, res) => {
  try {
    // Показываем только склады, реально принимающие товар прямо сейчас (dstQuota > 0).
    // Закрытые не показываем — иначе пользователь выберет заведомо неработающий вариант.
    // Список меняется в течение дня (WB открывает квоты порциями).
    const { token: sessionToken, cookies: sessionCookies } = await getUserSessionToken(req.telegramId);
    if (sessionToken && sessionToken.startsWith('eyJhbGciOiJSUzI1NiIs')) {
      try {
        const quotas = await getTransferAvailableLimits(sessionToken, null, sessionCookies);
        // Схлопываем варианты одного склада (Питание + основной) по имени, берём максимум
        const byName = {};
        for (const q of quotas) {
          const name = q.displayName || q.officeName;
          if (!name) continue;
          if (/остальные/i.test(name)) continue;   // служебные скрываем
          const dst = q.dstQuota || 0;
          if (!byName[name] || dst > byName[name]) byName[name] = dst;
        }
        const open = Object.entries(byName)
          .filter(([, dst]) => dst > 0)
          .map(([name]) => name)
          .sort((a, b) => a.localeCompare(b, 'ru'));
        const closedCount = Object.values(byName).filter(v => v === 0).length;
        console.log(`[wb-warehouses] ${open.length} открытых для приёмки | ${closedCount} закрытых сейчас`);
        return res.json({ warehouses: open });
      } catch (e) {
        console.warn('[wb-warehouses] AvailableLimits failed:', e.message);
      }
    }

    // Fallback: старый способ через WB API-токен (Analytics остатки)
    const token = await getUserToken(req.telegramId);
    if (!token) return res.status(401).json({ error: 'Сначала войдите через SMS' });
    const names = (await getWbFboWarehouseNames(token))
      .filter(n => !/остальные|питание/i.test(n));
    res.json({ warehouses: names });
  } catch(err) {
    console.error('wb-warehouses error:', err.message);
    res.json({ warehouses: [], error: err.message });
  }
});

/**
 * GET /transfers/:id/waybill
 * Отдаёт накладную (Excel) успешного перемещения для скачивания.
 */
app.get('/transfers/:id/waybill', telegramAuth, requireDB, async (req, res) => {
  try {
    const { id } = req.params;
    const r = await db.query(
      'SELECT waybill, waybill_mime, sku FROM transfer_requests WHERE id=$1 AND user_id=$2',
      [id, req.telegramId]
    );
    if (!r.rows.length || !r.rows[0].waybill) {
      return res.status(404).json({ error: 'Накладная не найдена. Возможно, перемещение ещё не выполнено.' });
    }
    const { waybill, waybill_mime, sku } = r.rows[0];
    const buf = Buffer.from(waybill, 'base64');
    const mime = waybill_mime || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const ext = /excel|spreadsheet|xlsx/i.test(mime) ? 'xlsx' : 'pdf';
    res.set('Content-Type', mime);
    res.set('Content-Disposition', `attachment; filename="nakladnaya_${sku}_${id}.${ext}"`);
    res.send(buf);
  } catch (err) {
    console.error('[waybill] ошибка:', err.message);
    res.status(500).json({ error: 'Не удалось получить накладную' });
  }
});

/**
 * GET /transfers/articles
 * Список артикулов продавца с наименованиями для выпадающего списка.
 * Работает через SMS-сессию (seller-supply/transfer/list с пустым nmIDs).
 * Возвращает [{ nmID, name }].
 */
app.get('/transfers/articles', telegramAuth, requireDB, async (req, res) => {
  try {
    const { token: sessionToken, cookies: sessionCookies } = await getUserSessionToken(req.telegramId);
    const wbToken = await getUserToken(req.telegramId);
    if (!sessionToken && !wbToken) return res.status(401).json({ error: 'Сначала авторизуйтесь через SMS' });

    let items = [];
    let sessionFailed = false;   // seller-supply вернул 401/403 (сессия не работает)

    // ОСНОВНОЙ путь: inventoryManagement/list — список ВСЕХ товаров с остатками.
    // Тот же endpoint, что страница «Управление остатками» WB. Работает по SMS-сессии.
    if (sessionToken) {
      try {
        const inv = await getInventoryList(sessionToken, sessionCookies);
        items = inv.map(g => ({ nmID: g.nmID, name: g.name, quantity: g.quantity }));
        console.log(`[articles] inventoryManagement вернул ${items.length} товаров (user=${req.telegramId})`);
      } catch (e) {
        console.warn('[articles] inventory path failed:', e.message, '| status:', e.status);
        if (e.status === 401 || e.status === 403 || /401|403|supplier|сесси/i.test(e.message)) {
          sessionFailed = true;
        }
      }
    }

    // ФОЛБЭК: если inventory не дал ничего, а WB-токен есть — возьмём карточки
    if (!items.length && wbToken) {
      try {
        const cards = await getAllCards(wbToken);
        items = (cards || [])
          .map(c => ({
            nmID: c.nmID || c.nmId,
            name: (c.title || c.subjectName || c.vendorCode || '').toString().trim(),
          }))
          .filter(x => x.nmID);
      } catch (e) { console.warn('[articles] getAllCards fallback fail:', e.message); }
    }

    if (!items.length) {
      if (sessionFailed || !sessionToken) {
        return res.status(401).json({
          articles: [], count: 0,
          error: 'Сессия WB не активна. Войдите заново через SMS, чтобы бот получил доступ к вашим товарам.'
        });
      }
      return res.status(404).json({
        articles: [], count: 0,
        error: 'Нет товаров с остатками на складах. Список формируется из товаров, которые есть на складах WB.'
      });
    }

    // сортируем по имени, дедуп на всякий случай
    const seen = new Set();
    items = items.filter(x => !seen.has(x.nmID) && seen.add(x.nmID));
    items.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));

    res.set('Cache-Control', 'no-store');
    res.json({ articles: items, count: items.length });
  } catch (err) {
    console.error('[articles] ошибка:', err.message);
    res.status(500).json({ error: 'Не удалось получить список артикулов' });
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
    const { token: sessionToken, cookies: sessionCookies } = await getUserSessionToken(req.telegramId);
    if (!sessionToken) return res.status(401).json({ error: 'Сначала авторизуйтесь через SMS' });
    const { article, warehouses, source } = await getArticleStocks(token, nmId, sessionToken, sessionCookies);
    if (!article && (!warehouses || warehouses.length === 0)) return res.status(404).json({
      error: 'Артикул не найден или нет остатков на складах.'
    });

    // Дополнительно: собираем карту разрешённых складов-приёмников из transfer/list.
    // Используется на фронте для предупреждения «склад не принимает этот товар (Монопаллета)».
    // Ключ = имя склада-источника, значение = Set officeID разрешённых приёмников.
    let allowedDestBySource = {};
    try {
      const resp = await getTransferStockByWarehouse(sessionToken, nmId, sessionCookies);
      for (const c of (resp || [])) {
        const srcName = c.warehouseName || `Склад ${c.warehouseID}`;
        if (!allowedDestBySource[srcName]) allowedDestBySource[srcName] = [];
        if (Array.isArray(c.dstWarehouseIDs)) {
          allowedDestBySource[srcName].push(...c.dstWarehouseIDs);
        }
      }
      // Дедупликация
      for (const k of Object.keys(allowedDestBySource)) {
        allowedDestBySource[k] = [...new Set(allowedDestBySource[k])];
      }
    } catch { /* некритично, продолжаем без карты */ }

    console.log(`[article-stocks] nmId=${nmId} source=${source} warehouses=${warehouses.length}`);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.json({ nmId: article.nmId, name: article.name, warehouses, allowedDestBySource });
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

// ═══════════════════════════════════════════════════════════════════════════════
// ЮKASSA — интеграция платёжного сервиса
// ═══════════════════════════════════════════════════════════════════════════════

const YOOKASSA_SHOP_ID  = process.env.YOOKASSA_SHOP_ID  || '1350204';
const YOOKASSA_SECRET   = process.env.YOOKASSA_SECRET_KEY;
const { randomUUID }    = require('crypto');

// Проверка конфигурации ЮKassa при старте
if (YOOKASSA_SECRET) {
  console.log(`[yookassa] ✅ настроен: shopId=${YOOKASSA_SHOP_ID}, secret=${YOOKASSA_SECRET.slice(0,10)}..., proxy=${process.env.YOOKASSA_PROXY_URL || 'нет'}`);
} else {
  console.warn('[yookassa] ⚠️ YOOKASSA_SECRET_KEY не задан — платежи недоступны');
}

/** Вызов API ЮKassa с Basic-авторизацией */
async function yookassaApi(method, path, body = null, idempotenceKey = null) {
  const auth = Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET}`).toString('base64');

  // Если задан YOOKASSA_PROXY_URL — запросы к ЮKassa идут через него
  // (нужно когда Railway блокирует прямые запросы к api.yookassa.ru)
  const baseUrl = process.env.YOOKASSA_PROXY_URL
    ? process.env.YOOKASSA_PROXY_URL.replace(/\/$/, '')
    : 'https://api.yookassa.ru/v3';
  const url = process.env.YOOKASSA_PROXY_URL
    ? `${baseUrl}${path}`
    : `https://api.yookassa.ru/v3${path}`;

  const res = await axios({
    method,
    url,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type':  'application/json',
      'Idempotence-Key': idempotenceKey || randomUUID(),
      'ngrok-skip-browser-warning': 'true',
    },
    data: body || undefined,
    validateStatus: () => true,
    timeout: 20000,
  });
  console.log(`[yookassa] ${method} ${url} → HTTP ${res.status} | body sent: ${JSON.stringify(body).slice(0,200)} | response: ${JSON.stringify(res.data).slice(0, 300)}`);
  return { ...res.data, _httpStatus: res.status };
}

/**
 * POST /payments/create
 * Создаёт платёж в ЮKassa. Возвращает URL для перенаправления пользователя.
 * Body: { email, units, amount }
 */
/**
 * GET /payments/test-yookassa  (только для отладки — убрать после настройки)
 * Проверяет подключение к ЮKassa: вызывает GET /me для проверки credetionals.
 */
app.get('/payments/test-yookassa', telegramAuth, async (req, res) => {
  if (!YOOKASSA_SECRET) return res.json({ error: 'YOOKASSA_SECRET_KEY не задан в Variables' });
  try {
    const me = await yookassaApi('GET', '/me');
    res.json({
      ok: true,
      shopId: YOOKASSA_SHOP_ID,
      secretStart: YOOKASSA_SECRET.slice(0, 15) + '...',
      response: me,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/payments/create', telegramAuth, requireDB, async (req, res) => {
  if (!YOOKASSA_SECRET) {
    return res.status(503).json({ error: 'Платёжный сервис не настроен. Задайте YOOKASSA_SECRET_KEY в Variables.' });
  }
  const { email, units, amount } = req.body || {};
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Укажите корректный e-mail' });
  if (!units  || units < 1)       return res.status(400).json({ error: 'Укажите количество единиц' });
  if (!amount || amount < 1)      return res.status(400).json({ error: 'Укажите сумму' });

  try {
    const idempKey = randomUUID();
    const payment = await yookassaApi('POST', '/payments', {
      amount: { value: Number(amount).toFixed(2), currency: 'RUB' },
      confirmation: {
        type: 'redirect',
        return_url: `${APP_URL}/?payment=success`,
      },
      capture: true,
      description: `WB_Logistic_bot: ${units} единиц перемещений`,
      metadata: {
        telegram_id: String(req.telegramId),
        units:       String(units),
      },
      // receipt не добавляем — требует подключённую онлайн-кассу в ЮKassa
      // Добавить позже когда касса будет настроена
    }, idempKey);

    if ((payment._httpStatus === 200 || payment._httpStatus === 201) && payment.status === 'pending' && payment.confirmation?.confirmation_url) {
      await db.query(
        `INSERT INTO payments (user_id, amount, units, status, yookassa_id, email)
         VALUES ($1, $2, $3, 'pending', $4, $5)
         ON CONFLICT (yookassa_id) DO NOTHING`,
        [req.telegramId, amount, units, payment.id, email]
      );
      return res.json({ confirmation_url: payment.confirmation.confirmation_url, payment_id: payment.id });
    }
    const ykErr = payment.description || payment.parameter || payment.code || `HTTP ${payment._httpStatus}`;
    console.error('[payments/create] ЮKassa error:', JSON.stringify(payment));
    return res.status(502).json({ error: `Ошибка ЮKassa: ${ykErr}. Проверьте настройки магазина.` });

  } catch (err) {
    console.error('[payments/create] exception:', err.message);
    return res.status(500).json({ error: 'Ошибка создания платежа: ' + err.message });
  }
});

/**
 * POST /payments/webhook/yookassa
 * Принимает уведомления от ЮKassa (HTTP-уведомления).
 * Добавить URL в ЮKassa: Интеграция → HTTP-уведомления → добавить URL:
 *   https://wb-bot-backend-production.up.railway.app/payments/webhook/yookassa
 */
app.post('/payments/webhook/yookassa', express.json({ limit: '1mb' }), async (req, res) => {
  // Сразу отвечаем 200 — иначе ЮKassa будет повторять запросы
  res.json({ ok: true });

  const event   = req.body;
  const payment = event?.object;
  if (!event || event.type !== 'notification' || !payment) return;
  if (!db) return;

  const yookassaId = payment.id;
  const status     = payment.status; // pending / waiting_for_capture / succeeded / canceled

  try {
    if (status === 'succeeded') {
      // Обновляем статус в БД
      const upd = await db.query(
        `UPDATE payments SET status='succeeded', updated_at=NOW()
         WHERE yookassa_id=$1 AND status != 'succeeded'
         RETURNING user_id, units, amount`,
        [yookassaId]
      );
      if (!upd.rows.length) return; // уже обработан

      const { user_id, units, amount } = upd.rows[0];
      console.log(`[payments] ✅ платёж ${yookassaId} подтверждён | user=${user_id} units=${units}`);

      // Уведомляем пользователя в Telegram
      if (BOT_TOKEN && user_id) {
        await tgApi('sendMessage', {
          chat_id: user_id,
          text: `✅ Оплата получена!\n\nПополнено: *${Number(units).toLocaleString('ru')} единиц* перемещений\nСумма: *${Number(amount).toLocaleString('ru')} ₽*\n\nВаш баланс обновлён. Откройте приложение, чтобы создать запросы.`,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '🚀 Открыть приложение', web_app: { url: APP_URL } }]] }
        }).catch(e => console.warn('[payments] Telegram notify failed:', e.message));
      }

    } else if (status === 'canceled') {
      await db.query(
        `UPDATE payments SET status='canceled', updated_at=NOW() WHERE yookassa_id=$1`,
        [yookassaId]
      );
      console.log(`[payments] ❌ платёж ${yookassaId} отменён`);
    }
  } catch (err) {
    console.error('[payments/webhook] error:', err.message);
  }
});

/**
 * GET /payments/balance
 * Модель баланса:
 *   Куплено       = сумма успешных оплат (units)
 *   Потрачено     = сумма реально перемещённых единиц (moved во всех заявках)
 *   Зарезервировано = сумма ещё-не-перемещённого в активных заявках (amount - moved, pending)
 *   Доступно (balance) = Куплено - Потрачено - Зарезервировано
 */
app.get('/payments/balance', telegramAuth, requireDB, async (req, res) => {
  try {
    const uid = req.telegramId;
    const paid = await db.query(
      `SELECT COALESCE(SUM(units),0) AS total FROM payments
       WHERE user_id=$1 AND status='succeeded'`, [uid]
    );
    // Потрачено — реально перемещённые единицы во всех заявках (moved)
    const spent = await db.query(
      `SELECT COALESCE(SUM(moved),0) AS total FROM transfer_requests
       WHERE user_id=$1`, [uid]
    );
    // Зарезервировано — оставшееся к перемещению в активных заявках
    const reserved = await db.query(
      `SELECT COALESCE(SUM(GREATEST(amount - COALESCE(moved,0), 0)),0) AS total
       FROM transfer_requests
       WHERE user_id=$1 AND status='pending'`, [uid]
    );
    const purchased    = Number(paid.rows[0]?.total || 0);
    const spentTotal   = Number(spent.rows[0]?.total || 0);
    const reservedTotal= Number(reserved.rows[0]?.total || 0);
    const available    = purchased - spentTotal - reservedTotal;
    res.json({
      balance:   Math.max(available, 0),   // доступно для новых заявок
      reserved:  reservedTotal,            // зарезервировано в активных
      purchased,                           // всего куплено
      spent:     spentTotal,               // всего потрачено
    });
  } catch (err) {
    console.error('balance error:', err.message);
    res.json({ balance: 0, reserved: 0, purchased: 0, spent: 0 });
  }
});

/** Вспомогательная: возвращает доступный баланс пользователя (для проверки при создании) */
async function getAvailableBalance(userId) {
  const paid = await db.query(
    `SELECT COALESCE(SUM(units),0) AS total FROM payments WHERE user_id=$1 AND status='succeeded'`, [userId]);
  const spent = await db.query(
    `SELECT COALESCE(SUM(moved),0) AS total FROM transfer_requests WHERE user_id=$1`, [userId]);
  const reserved = await db.query(
    `SELECT COALESCE(SUM(GREATEST(amount - COALESCE(moved,0), 0)),0) AS total
     FROM transfer_requests WHERE user_id=$1 AND status='pending'`, [userId]);
  return Number(paid.rows[0].total) - Number(spent.rows[0].total) - Number(reserved.rows[0].total);
}

/**
 * POST /payments/promo
 * Активация промокода. Body: { code }.
 * Начисляет units из промокода на баланс пользователя (через запись в payments).
 * Каждый код одноразовый.
 */
app.post('/payments/promo', telegramAuth, requireDB, async (req, res) => {
  const raw = (req.body?.code || '').trim().toUpperCase();
  if (!raw) return res.status(400).json({ error: 'Введите промокод' });

  try {
    // Атомарно помечаем код использованным (только если ещё не использован)
    const upd = await db.query(
      `UPDATE promo_codes SET used_by=$1, used_at=NOW()
       WHERE code=$2 AND used_by IS NULL
       RETURNING units`,
      [req.telegramId, raw]
    );

    if (!upd.rows.length) {
      // Код не существует, или уже использован — уточним причину
      const exists = await db.query('SELECT used_by FROM promo_codes WHERE code=$1', [raw]);
      if (!exists.rows.length) {
        return res.status(404).json({ error: 'Промокод не найден. Проверьте правильность.' });
      }
      if (exists.rows[0].used_by === req.telegramId) {
        return res.status(409).json({ error: 'Вы уже активировали этот промокод.' });
      }
      return res.status(409).json({ error: 'Промокод уже был использован.' });
    }

    const units = upd.rows[0].units;
    // Начисляем на баланс — запись в payments как succeeded
    await db.query(
      `INSERT INTO payments (user_id, amount, units, status, yookassa_id, created_at)
       VALUES ($1, 0, $2, 'succeeded', $3, NOW())`,
      [req.telegramId, units, `promo_${raw}_${req.telegramId}`]
    );

    const available = await getAvailableBalance(req.telegramId);
    console.log(`[promo] ✅ ${raw} активирован user=${req.telegramId} (+${units} ед)`);
    res.json({ success: true, units, balance: Math.max(available, 0) });
  } catch (err) {
    console.error('[promo] ошибка:', err.message);
    res.status(500).json({ error: 'Не удалось активировать промокод' });
  }
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
          text: '👋 Добро пожаловать в *WB\\_Logistic\\_bot*\n\nАвтоматизация перераспределения остатков товаров между складами Wildberries\\.\n\n🔥 *Уважаемые пользователи, до сентября 2026 у нас низкая цена\\! Всего 1 рубль за перемещение 1 товара\\!*\n\nНажмите кнопку ниже, чтобы открыть приложение:',
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🚀 Открыть приложение', web_app: { url: APP_URL } }],
              [{ text: '📢 Канал бота', url: process.env.BOT_CHANNEL_URL || 'https://t.me/wb_logistic_news' }],
              [{ text: '💬 Поддержка', url: 'https://t.me/Chernyshevofficial' }]
            ]
          }
        });
      } else if (text === '/support') {
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: '💬 Служба поддержки WB\\_Logistic\\_bot\n\nПо всем вопросам обращайтесь к @Chernyshevofficial',
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [[{ text: '💬 Написать в поддержку', url: 'https://t.me/Chernyshevofficial' }]]
          }
        });
      } else if (text === '/teststats' && chatId === 285237021) {
        const r = await postToChannel(
          `📊 *Статистика за неделю* (тест)\n\n` +
          `✅ Выполнено перемещений: *12*\n` +
          `📦 Перемещено товаров: *340 шт*\n\n` +
          `Автобронь работает круглосуточно 🚀\n` +
          `Всего 1₽ за перемещение 1 товара!`
        );
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: r.ok ? '✅ Пост статистики опубликован в канале!' : `❌ Ошибка: ${r.error}\n\nchat_id=${process.env.BOT_CHANNEL_ID || 'НЕ ЗАДАН'}`
        });
      } else if (text === '/testquota' && chatId === 285237021) {
        const r = await postToChannel(
          `⚡️ *Открылись квоты!* (тест)\n\n` +
          `🏭 Склад: *Коледино*\n` +
          `📥 Доступно: отгрузка 5000, приёмка 8355\n\n` +
          `Успейте создать заявку на перемещение 🚀`
        );
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: r.ok ? '✅ Пост про квоты опубликован в канале!' : `❌ Ошибка: ${r.error}\n\nchat_id=${process.env.BOT_CHANNEL_ID || 'НЕ ЗАДАН'}`
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

// ═══════════════════════════════════════════════════════════════════════════════
// АВТОПОСТИНГ В КАНАЛ
// ═══════════════════════════════════════════════════════════════════════════════
// Канал задаётся переменной BOT_CHANNEL_ID (@username канала или числовой -100...).
// Бот должен быть администратором канала с правом публикации.
const BOT_CHANNEL_ID = process.env.BOT_CHANNEL_ID || null;

/** Публикация поста в канал бота */
async function postToChannel(text) {
  if (!BOT_CHANNEL_ID) {
    console.warn('[channel] BOT_CHANNEL_ID не задан');
    return { ok: false, error: 'BOT_CHANNEL_ID не задан в Variables' };
  }
  try {
    const resp = await tgApi('sendMessage', {
      chat_id: BOT_CHANNEL_ID,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
    // Telegram возвращает {ok: false, description: "..."} при ошибке прав/chat_id
    if (resp && resp.ok === false) {
      console.warn(`[channel] Telegram отклонил: ${resp.description} (chat_id=${BOT_CHANNEL_ID})`);
      return { ok: false, error: resp.description };
    }
    console.log('[channel] ✅ пост опубликован в', BOT_CHANNEL_ID);
    return { ok: true };
  } catch (e) {
    const tgErr = e.response?.data?.description || e.message;
    console.warn(`[channel] не удалось опубликовать: ${tgErr} (chat_id=${BOT_CHANNEL_ID})`);
    return { ok: false, error: tgErr };
  }
}

// ── Еженедельная статистика перемещений ─────────────────────────────────────────
let lastWeeklyStatsAt = 0;
async function maybePostWeeklyStats() {
  if (!BOT_CHANNEL_ID || !dbReady) return;
  const now = Date.now();
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  // Постим раз в неделю (по понедельникам ~10:00 МСК, но не чаще раза в неделю)
  const d = new Date();
  const isMonday10 = d.getUTCDay() === 1 && d.getUTCHours() === 7;  // 10:00 МСК = 07:00 UTC
  if (!isMonday10) return;
  if (now - lastWeeklyStatsAt < WEEK - 3600000) return;  // защита от двойного поста

  try {
    // Считаем перемещённое за последние 7 дней
    const stats = await db.query(
      `SELECT COALESCE(SUM(moved),0) AS total_moved,
              COUNT(*) FILTER (WHERE status='done') AS done_count
       FROM transfer_requests
       WHERE updated_at >= NOW() - INTERVAL '7 days' AND moved > 0`
    );
    const totalMoved = Number(stats.rows[0]?.total_moved || 0);
    const doneCount  = Number(stats.rows[0]?.done_count || 0);
    if (totalMoved === 0) return;  // нечего постить

    lastWeeklyStatsAt = now;
    await postToChannel(
      `📊 *Статистика за неделю*\n\n` +
      `✅ Выполнено перемещений: *${doneCount}*\n` +
      `📦 Перемещено товаров: *${totalMoved.toLocaleString('ru')} шт*\n\n` +
      `Автобронь работает круглосуточно 🚀\n` +
      `Всего 1₽ за перемещение 1 товара!`
    );
  } catch (e) {
    console.warn('[channel] ошибка статистики:', e.message);
  }
}

// ── Оповещение об открытии квот на ключевые склады ──────────────────────────────
const KEY_WAREHOUSES = ['Коледино', 'Краснодар', 'Казань', 'Электросталь', 'Екатеринбург'];
const quotaOpenState = {};   // { склад: true/false } — было ли открыто в прошлой проверке
let lastQuotaCheckAt = 0;

async function maybePostQuotaOpen(quotas) {
  if (!BOT_CHANNEL_ID || !Array.isArray(quotas)) return;
  const now = Date.now();
  // Проверяем не чаще раза в 10 минут (чтобы не спамить)
  if (now - lastQuotaCheckAt < 10 * 60 * 1000) return;
  lastQuotaCheckAt = now;

  for (const keyWh of KEY_WAREHOUSES) {
    // Ищем квоту склада (по вхождению имени — «Казань: Питание» тоже подойдёт)
    const q = quotas.find(x => {
      const nm = (x.displayName || x.officeName || '');
      return nm.toLowerCase().includes(keyWh.toLowerCase());
    });
    const isOpen = q && (q.srcQuota > 0 || q.dstQuota > 0);
    const wasOpen = quotaOpenState[keyWh] || false;

    // Постим ТОЛЬКО при переходе закрыто→открыто (чтобы не спамить каждый цикл)
    if (isOpen && !wasOpen) {
      const parts = [];
      if (q.srcQuota > 0) parts.push(`отгрузка ${q.srcQuota}`);
      if (q.dstQuota > 0) parts.push(`приёмка ${q.dstQuota}`);
      await postToChannel(
        `⚡️ *Открылись квоты!*\n\n` +
        `🏭 Склад: *${keyWh}*\n` +
        `📥 Доступно: ${parts.join(', ')}\n\n` +
        `Успейте создать заявку на перемещение 🚀`
      );
    }
    quotaOpenState[keyWh] = isOpen;
  }
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
        { command: 'start', description: '🚀 Открыть WB_Logistic_bot' },
        { command: 'support', description: '💬 Поддержка' }
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
const MAX_RETRY_COUNT    = 11520;   // 11520 × 30 сек = 96 часов

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

  // Автопостинг еженедельной статистики (проверка времени внутри)
  maybePostWeeklyStats().catch(() => {});

  try {
    // Берём pending-заявки. Требуется только живая сессия (SMS), wb_token НЕ обязателен —
    // перемещение работает на session-токене + supplier id (как у конкурента, только SMS).
    const { rows } = await db.query(`
      SELECT tr.id, tr.user_id, tr.from_warehouse, tr.to_warehouse,
             tr.sku, tr.amount, tr.retry_count, tr.moved, tr.product_name,
             u.wb_token
      FROM   transfer_requests tr
      JOIN   users u ON u.telegram_id = tr.user_id
      WHERE  tr.status = 'pending'
        AND  u.wb_session_token IS NOT NULL
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

    // Записываем успешное перемещение в историю (для 72ч-блокировки повтора).
    // Пара (пользователь + склад-источник + товар) теперь заблокирована на 72 часа.
    try {
      await db.query(
        `INSERT INTO transfer_history (user_id, from_warehouse, sku, moved_at)
         VALUES ($1, $2, $3, NOW())`,
        [req.user_id, req.from_warehouse, String(req.sku)]
      );
    } catch (e) {
      console.warn('[worker] не удалось записать в transfer_history:', e.message);
    }

    if (wasMoved >= total) {
      // ✅ Полностью перемещено — сохраняем накладную
      await db.query(
        `UPDATE transfer_requests SET status='done', moved=\$2, error_message=NULL, updated_at=NOW(),
         waybill=COALESCE(\$3, waybill), waybill_mime=COALESCE(\$4, waybill_mime) WHERE id=\$1`,
        [req.id, total, result.waybill || null, result.waybillMime || null]
      );
      await notifyUser(req.user_id, '‼️ Заявка на перемещение выполнена ‼️', req);
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

        // Если на складе не хватает товара — уведомляем пользователя ОДИН РАЗ (при первом обнаружении)
        if (err.stockShortage && newCount === 1) {
          const available = err.availableCount;
          await notifyUser(
            req.user_id,
            `⚠️ Недостаток остатков\n\nСклад: ${req.from_warehouse}\nАртикул: ${req.sku}${req.product_name ? ' (' + req.product_name + ')' : ''}\n\nНа складе доступно сейчас: ${available} шт\nЗапрошено к перемещению: ${req.amount} шт\n\n✏️ Отредактируйте количество товаров к перемещению в заявке — укажите не более ${available} шт.`,
            null
          );
        }
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
      // Сессия истекла — это ВРЕМЕННО (авто-refresh обновит её). Повторяем, не помечаем failed.
      const e = new Error('Сессия обновляется, повтор. Если повторяется долго — авторизуйтесь через SMS.');
      e.status = 409;
      throw e;
    }
    throw err;
  }

  if (!chrts || chrts.length === 0) {
    // transfer/list вернул пусто. Остатки у товара могут БЫТЬ, но WB не показывает
    // его в доступных к перемещению — по новым правилам (с 7 июля 2026), если склад
    // назначения принимает товар только Монопаллетой (не Короб/Поштучная паллета).
    const e = new Error(
      `Товар ${req.sku} сейчас недоступен для перемещения. Возможные причины: ` +
      `склад назначения не принимает этот товар в поставках типа Короб/Поштучная паллета ` +
      `(только Монопаллета), либо действует временное ограничение склада, либо нет остатков. ` +
      `Проверьте: Поставки → FBW → Ограничения складов.`
    );
    e.status = 409;
    e.palletRestriction = true;
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
    const available = srcWh.count;
    const e = new Error(`На складе «${req.from_warehouse}» только ${available} шт, запрошено ${req.amount}`);
    e.status = 409;
    e.stockShortage = true;
    e.availableCount = available;
    throw e;
  }

  // Шаг 2: Получаем квоты складов (куда можно принять товар).
  // AvailableLimits возвращает quotas[] с officeID, officeName, srcQuota, dstQuota
  let quotas;
  try {
    quotas = await getTransferAvailableLimits(sessionToken, req.sku, sessionCookies);
    console.log(`[worker] AvailableLimits: ${quotas.length} складов с квотами`);
    // Автопостинг в канал при открытии квот на ключевые склады (throttle внутри)
    maybePostQuotaOpen(quotas).catch(() => {});
  } catch (err) {
    if (err.sessionExpired) {
      const e = new Error('Сессия обновляется, повтор. Если повторяется долго — авторизуйтесь через SMS.');
      e.status = 409;
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
    // Уточняем, ЧТО именно ограничивает — чтобы сообщение не путало источник и назначение.
    let reason;
    if (dstQuota.dstQuota <= 0) {
      reason = `Склад назначения «${req.to_warehouse}» сейчас не принимает товар (суточный лимит приёмки исчерпан). Ждём открытия.`;
    } else if (srcQuotaValue <= 0) {
      reason = `Квота отгрузки со склада «${req.from_warehouse}» пока закрыта. Ждём открытия.`;
    } else if (srcWh.count <= 0) {
      reason = `На складе «${req.from_warehouse}» нет остатка для перемещения.`;
    } else {
      reason = `Нет доступной квоты для перемещения прямо сейчас. Ждём.`;
    }
    const e = new Error(reason);
    e.status = 409;
    throw e;
  }

  // Проверяем что назначение есть в списке разрешённых направлений источника
  if (Array.isArray(srcWh.dstWarehouseIDs) && !srcWh.dstWarehouseIDs.includes(dstOfficeId)) {
    const e = new Error(`Перемещение «${req.from_warehouse}» → «${req.to_warehouse}» недоступно для этого артикула`);
    e.status = 409;
    throw e;
  }

  // Шаг 3: Создаём перемещение на moveNow единиц.
  // /order шлётся НА ПРОКСИ-ПК (через /create-transfer): там и antibot-токен,
  // и сам заказ уходят с одного IP. Railway только готовит параметры.
  console.log(`[worker] create-transfer: nmID=${req.sku} chrtID=${chrtId} src=${srcOfficeId} dst=${dstOfficeId} count=${moveNow}`);

  let createResult;
  if (PROXY_TRANSFER_URL) {
    console.log(`[worker] → используем прокси-ПК: ${PROXY_TRANSFER_URL}`);
    // supplier id живёт внутри кук (x-supplier-id=...). Достаём его оттуда;
    // /create-transfer на прокси тоже умеет извлекать из кук, передаём для надёжности.
    let supplierId = null;
    if (sessionCookies) {
      const m = sessionCookies.match(/x-supplier-id=([0-9a-f-]{36})/i);
      if (m) supplierId = m[1];
    }
    const transfers = [{
      nmID: Number(req.sku),
      srcOfficeID: Number(srcOfficeId),
      items: [{ dstOfficeID: Number(dstOfficeId), chrtID: Number(chrtId), count: Number(moveNow) }],
    }];
    let resp;
    try {
      resp = await axios.post(PROXY_TRANSFER_URL, {
        sessionToken, sessionCookies, supplierId, transfers,
      }, {
        timeout: 45000,
        headers: { 'ngrok-skip-browser-warning': 'true' },
        validateStatus: () => true,
      });
    } catch (err) {
      const e = new Error(`Прокси-ПК недоступен: ${err.message}`);
      e.status = 409;  // повторяем — машина пула может быть временно офлайн
      throw e;
    }
    if (resp.status === 503) {
      // пул не смог сгенерить токен (разлогин / WB сменил antibot) — повторяем
      const e = new Error(`Пул не сгенерил antibot-токен: ${JSON.stringify(resp.data).slice(0,150)}`);
      e.status = 409;
      e.captchaRequired = true;
      throw e;
    }
    const orderHttp = resp.data && resp.data.status;
    const orderData = resp.data && resp.data.data;
    // Успех ТОЛЬКО при HTTP 200 + накладная (file). Иначе — не подтверждено.
    if (orderHttp !== 200 || !orderData || !orderData.result || !orderData.result.file) {
      const rpcErr = orderData && orderData.error;
      const e = new Error(rpcErr ? (rpcErr.message || `WB error ${rpcErr.code}`) : `Перемещение не подтверждено (HTTP ${orderHttp})`);
      e.wbDetail = rpcErr && rpcErr.message;
      e.notConfirmed = true;
      // капча/сессия — повторяем; иначе считаем ошибкой
      if (rpcErr && (rpcErr.code === -32002 || /капч|captcha/i.test(rpcErr.message || ''))) { e.status = 409; e.captchaRequired = true; }
      else if (orderHttp === 401 || orderHttp === 403) { e.status = 401; e.sessionExpired = true; }
      else { e.status = 502; }
      throw e;
    }
    createResult = orderData.result;  // { file, mime }
    console.log(`[worker] ✅ #${req.id} WB подтвердил: file=${String(createResult.file).length} симв, mime=${createResult.mime || '?'}, keys=${JSON.stringify(Object.keys(orderData.result))}`);
  } else {
    // Фолбэк (если прокси-URL не задан): прямой вызов. /order уйдёт с Railway —
    // сработает только если WB не сверяет IP. Логируем предупреждение.
    console.warn('[worker] PROXY_TRANSFER_URL не задан — /order уходит с Railway (риск IP-несоответствия)');
    createResult = await createWbTransfer(sessionToken, {
      nmId: Number(req.sku), chrtId, fromOfficeId: srcOfficeId, toOfficeId: dstOfficeId, amount: moveNow,
    }, sessionCookies);
  }

  // Двойная защита от ложного успеха: засчитываем перемещение ТОЛЬКО при наличии накладной.
  // createWbTransfer уже бросает исключение без file, но проверяем ещё раз здесь.
  if (!createResult || !createResult.file) {
    const e = new Error('Перемещение не подтверждено WB (нет накладной).');
    e.status = 502;
    e.notConfirmed = true;
    throw e;
  }
  console.log(`[worker] ✅ перемещено ${moveNow} ед (накладная получена)`);

  // Возвращаем сколько переместили + накладную (для сохранения и скачивания)
  return {
    moved: moveNow, total: Number(req.amount), wasMoved: alreadyMoved + moveNow,
    waybill: createResult.file, waybillMime: createResult.mime,
  };
}

/**
 * Отправляет уведомление пользователю в Telegram.
 */
async function notifyUser(telegramId, text, req) {
  if (!BOT_TOKEN) return;
  try {
    // Заголовок берём из переданного text (✅ выполнена / ❌ ошибка / ⏳ частично).
    // РАНЕЕ был баг: функция всегда писала «выполнена», игнорируя text → ложные уведомления.
    const header = text || 'Обновление по заявке';
    let body = '';
    if (req) {
      let articleLine = `Артикул: ${req.sku}`;
      if (req.product_name) articleLine += ` (${req.product_name})`;
      body = `\nПоставщик: Текущий аккаунт WB\nСклад: ${req.from_warehouse} ➡️ ${req.to_warehouse}\n${articleLine}\nЕдиниц товара: ${req.amount}`;
    }
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: telegramId, text: `${header}${body}` },
      { timeout: 8000 }
    );
  } catch (e) {
    console.error('[notify] Ошибка отправки уведомления:', e.message);
  }
}

/**
 * Системное оповещение администратора (например, об изменении antibot WB).
 */
async function notifyAdmin(text) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: ADMIN_CHAT_ID, text },
      { timeout: 8000 }
    );
  } catch (e) {
    console.error('[notify-admin] Ошибка:', e.message);
  }
}

// Регистрируем оповещение об изменении antibot WB.
// Срабатывает при смене версии скрипта, провале парсинга challenge или отклонении solution.
onAntibotChange((info) => {
  const lines = [
    '⚠️ ВНИМАНИЕ: изменился antibot Wildberries',
    `Тип: ${info.type}`,
    info.scriptPath ? `Скрипт: ${info.scriptPath}` : null,
    info.expected ? `Ожидался: ${info.expected}` : null,
    info.status ? `HTTP: ${info.status}` : null,
    info.note ? `\n${info.note}` : null,
    '\nДействие: проверить прохождение капчи. При сбоях обновить antibot-fingerprint.js (снять свежий solution из DevTools и пересобрать эталон).',
  ].filter(Boolean);
  notifyAdmin(lines.join('\n'));
});

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
