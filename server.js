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
const { validateWbToken, decodeWbToken } = require('./wb-auth');
const { getWarehouses, getStocks, updateStocks, getAllCards, extractSkusFromCards, getArticleStocks } = require('./wb-api');
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
      wb_token_info JSONB,
      created_at  TIMESTAMP DEFAULT NOW(),
      updated_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS transfer_requests (
      id             SERIAL PRIMARY KEY,
      user_id        BIGINT NOT NULL,
      from_warehouse VARCHAR(255) NOT NULL,
      to_warehouse   VARCHAR(255) NOT NULL,
      sku            VARCHAR(100) NOT NULL,
      amount         INTEGER NOT NULL CHECK (amount > 0),
      status         VARCHAR(50) DEFAULT 'pending',
      created_at     TIMESTAMP DEFAULT NOW(),
      updated_at     TIMESTAMP DEFAULT NOW()
    );

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
      'SELECT wb_token, wb_token_info, updated_at FROM users WHERE telegram_id = $1',
      [req.telegramId]
    );
    const row = result.rows[0];

    if (!row?.wb_token) {
      return res.json({ authorized: false });
    }

    const tokenInfo = row.wb_token_info;
    const expiresAt = tokenInfo?.exp
      ? new Date(tokenInfo.exp * 1000).toLocaleDateString('ru-RU')
      : null;

    const isExpired = tokenInfo?.exp ? Date.now() / 1000 > tokenInfo.exp : false;

    res.json({
      authorized: !isExpired,
      expires_at: expiresAt,
      is_expired: isExpired,
      connected_at: row.updated_at
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
  const { from_warehouse, to_warehouse, sku, amount } = req.body;

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
      `INSERT INTO transfer_requests (user_id, from_warehouse, to_warehouse, sku, amount, status)
       VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *`,
      [req.telegramId, from_warehouse, to_warehouse, sku, parseInt(amount, 10)]
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
      'SELECT * FROM transfer_requests WHERE user_id = $1 ORDER BY created_at DESC',
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
    const { article, warehouses, source } = await getArticleStocks(token, nmId);
    if (!article) return res.status(404).json({
      error: 'Артикул не найден. Убедитесь что токен имеет категории Content и Статистика.'
    });
    console.log(`[article-stocks] nmId=${nmId} source=${source} warehouses=${warehouses.length}`);
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
// ─── Запуск ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`🔧 Тестовый режим: ${TEST_MODE ? 'ВКЛ (telegramId=12345)' : 'ВЫКЛ (проверка Telegram)'}`);
  console.log(`📦 Статика: ${path.join(__dirname, 'public')}`);
  console.log(`🌐 APP_URL: ${APP_URL || 'не задан'}`);
  // Настраиваем бота после старта сервера
  setTimeout(setupBot, 2000);
});
