// server.js — итоговая версия с временно отключённой ЮKassa
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Client } = require('pg');
const { validate } = require('@telegram-apps/init-data-node');
const { requestSmsCode, confirmSmsCode } = require('./wb-auth');
const { getWarehouses, getStocks, updateStocks } = require('./wb-api');

const app = express();
const fs = require('fs');
const path = require('path');

app.get('/check-files', (req, res) => {
  const rootFiles = fs.readdirSync(__dirname);
  let publicFiles = 'папка public не найдена';
  const publicPath = path.join(__dirname, 'public');
  if (fs.existsSync(publicPath)) {
    publicFiles = fs.readdirSync(publicPath).join(', ');
  }
  res.json({
    rootFiles: rootFiles,
    publicFiles: publicFiles
  });
});
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Общие middleware
app.use(cors());
app.use(bodyParser.json());

// Раздача статических файлов Mini App (из папки public)
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

// Подключение к базе данных
const client = new Client({ connectionString: process.env.DATABASE_URL });
// Функция, которая создаёт таблицы, если их ещё нет
async function initDB() {
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE NOT NULL,
        phone VARCHAR(20),
        name VARCHAR(255),
        username VARCHAR(255),
        api_key_wb VARCHAR(255),
        wb_token TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sms_requests (
        telegram_id BIGINT PRIMARY KEY,
        phone VARCHAR(20),
        request_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS transfer_requests (
        id SERIAL PRIMARY KEY,
        user_id BIGINT,
        from_warehouse VARCHAR(255),
        to_warehouse VARCHAR(255),
        sku VARCHAR(50),
        amount INTEGER,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        user_id BIGINT,
        amount NUMERIC(10, 2),
        status VARCHAR(50),
        yookassa_id VARCHAR(255) UNIQUE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Таблицы проверены/созданы');
  } catch (err) {
    console.error('❌ Ошибка создания таблиц:', err);
  }
}

// Подключаемся и сразу инициализируем таблицы
client.connect()
  .then(() => {
    console.log('✅ Подключено к PostgreSQL');
    return initDB(); // <-- создаём таблицы
  })
  .catch(err => console.error('❌ Ошибка подключения к БД:', err));

// =====================================================
//  Middleware авторизации Telegram
// =====================================================
async function telegramAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const [authType, authData] = authHeader.split(' ');

  if (authType !== 'tma') {
    return res.status(401).json({ error: 'Требуется авторизация через Telegram' });
  }

  try {
    validate(authData, BOT_TOKEN, { expiresIn: 86400 });
    const initData = new URLSearchParams(authData);
    const user = JSON.parse(initData.get('user'));
    if (!user || !user.id) {
      return res.status(400).json({ error: 'Нет данных пользователя' });
    }
    req.telegramId = user.id;
    next();
  } catch (error) {
    console.error('Ошибка валидации Telegram:', error);
    return res.status(403).json({ error: 'Недействительные данные Telegram' });
  }
}

// =====================================================
//  АВТОРИЗАЦИЯ ЧЕРЕЗ СМС (Wildberries)
// =====================================================

// Шаг 1: Запросить SMS-код
app.post('/auth/request-sms', telegramAuth, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Введите номер телефона' });

  const existing = await client.query(
    'SELECT wb_token FROM users WHERE telegram_id = $1',
    [req.telegramId]
  );
  if (existing.rows.length > 0 && existing.rows[0].wb_token) {
    return res.json({ success: false, already_authorized: true, message: 'Вы уже авторизованы в Wildberries' });
  }

  const result = await requestSmsCode(phone);
  if (result.success) {
    await client.query(
      `INSERT INTO sms_requests (telegram_id, phone, request_id, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (telegram_id) DO UPDATE SET phone = $2, request_id = $3, created_at = NOW()`,
      [req.telegramId, phone, result.requestId]
    );
    res.json({ success: true, message: 'Код отправлен на номер ' + phone });
  } else {
    res.status(400).json({ success: false, error: result.error });
  }
});

// Шаг 2: Подтвердить SMS-код
app.post('/auth/verify-sms', telegramAuth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Введите код' });

  const smsReq = await client.query(
    'SELECT phone, request_id FROM sms_requests WHERE telegram_id = $1',
    [req.telegramId]
  );
  if (smsReq.rows.length === 0) {
    return res.status(400).json({ error: 'Сначала запросите код' });
  }

  const { phone, request_id } = smsReq.rows[0];
  const result = await confirmSmsCode(phone, code, request_id);

  if (result.success) {
    await client.query(
      `INSERT INTO users (telegram_id, phone, wb_token, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (telegram_id) DO UPDATE SET phone = $2, wb_token = $3, updated_at = NOW()`,
      [req.telegramId, phone, result.token]
    );
    await client.query('DELETE FROM sms_requests WHERE telegram_id = $1', [req.telegramId]);
    res.json({ success: true, message: 'Авторизация в Wildberries успешно завершена' });
  } else {
    res.status(400).json({ success: false, error: result.error });
  }
});

// Проверка статуса авторизации
app.get('/auth/status', telegramAuth, async (req, res) => {
  const user = await client.query(
    'SELECT wb_token FROM users WHERE telegram_id = $1',
    [req.telegramId]
  );
  const authorized = user.rows.length > 0 && user.rows[0].wb_token !== null;
  res.json({ authorized });
});

// =====================================================
//  МАРШРУТЫ ДЛЯ РАБОТЫ С WILDBERRIES
// =====================================================

// Получить список складов
app.get('/transfers/warehouses', telegramAuth, async (req, res) => {
  try {
    const user = await client.query(
      'SELECT wb_token FROM users WHERE telegram_id = $1',
      [req.telegramId]
    );
    if (!user.rows[0]?.wb_token) {
      return res.status(401).json({ error: 'Сначала авторизуйтесь в Wildberries через SMS' });
    }
    const warehouses = await getWarehouses(user.rows[0].wb_token);
    res.json(warehouses);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка получения складов' });
  }
});

// Получить остатки по складу
app.get('/transfers/stocks/:warehouseId', telegramAuth, async (req, res) => {
  const { warehouseId } = req.params;
  const { skus } = req.query;
  if (!skus) return res.status(400).json({ error: 'Укажите список SKU' });
  const skuArray = skus.split(',');

  try {
    const user = await client.query(
      'SELECT wb_token FROM users WHERE telegram_id = $1',
      [req.telegramId]
    );
    if (!user.rows[0]?.wb_token) {
      return res.status(401).json({ error: 'Сначала авторизуйтесь в Wildberries через SMS' });
    }
    const stocks = await getStocks(user.rows[0].wb_token, warehouseId, skuArray);
    res.json(stocks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка получения остатков' });
  }
});

// Создать запрос на перемещение
app.post('/transfers/create', telegramAuth, async (req, res) => {
  const { from_warehouse, to_warehouse, sku, amount } = req.body;
  if (!from_warehouse || !to_warehouse || !sku || !amount) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }

  try {
    const result = await client.query(
      `INSERT INTO transfer_requests (user_id, from_warehouse, to_warehouse, sku, amount, status)
       VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *`,
      [req.telegramId, from_warehouse, to_warehouse, sku, amount]
    );
    res.json({ success: true, request: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка создания запроса' });
  }
});

// Список запросов на перемещение
app.get('/transfers/list', telegramAuth, async (req, res) => {
  try {
    const result = await client.query(
      'SELECT * FROM transfer_requests WHERE user_id = $1 ORDER BY created_at DESC',
      [req.telegramId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки списка' });
  }
});

// =====================================================
//  ПЛАТЕЖИ — заглушка (временно без ЮKassa)
// =====================================================
const yooKassa = null; // отключено

app.post('/payments/create', telegramAuth, async (req, res) => {
  if (!yooKassa) {
    return res.status(503).json({ error: 'Платёжный сервис временно недоступен' });
  }
  // ... код создания платежа (будет добавлен позже)
});

app.get('/payments/history', telegramAuth, async (req, res) => {
  try {
    const result = await client.query(
      'SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC',
      [req.telegramId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки истории' });
  }
});

// =====================================================
//  ЗАПУСК СЕРВЕРА
// =====================================================
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});