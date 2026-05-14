// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const { isValid, parse } = require('@telegram-apps/init-data-node');
const { requestSmsCode, confirmSmsCode } = require('./wb-auth');
const { getWarehouses, getStocks, updateStocks } = require('./wb-api');
const YooKassa = require('yookassa-sdk');


// --- Конфигурация ---
const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// --- Middleware ---
app.use(cors());
app.use(bodyParser.json());

// --- Подключение к БД ---
const client = new Client({ connectionString: process.env.DATABASE_URL });
client.connect()
  .then(() => console.log('✅ Подключено к PostgreSQL'))
  .catch(err => console.error('❌ Ошибка подключения к БД:', err));

  app.use(express.static('public'));
// =====================================================
//  Middleware для проверки Telegram InitData
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
    req.telegramId = user.id;   // сохраняем ID Telegram
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

  // Проверим, не авторизован ли уже пользователь
  const existing = await client.query(
    'SELECT wb_token FROM users WHERE telegram_id = $1',
    [req.telegramId]
  );
  if (existing.rows.length > 0 && existing.rows[0].wb_token) {
    return res.json({ success: false, already_authorized: true, message: 'Вы уже авторизованы в Wildberries' });
  }

  const result = await requestSmsCode(phone);
  if (result.success) {
    // Сохраняем временный requestId в таблицу sms_requests
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

  // Получаем сохранённые данные запроса
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
    // Сохраняем WB-токен в таблицу users
    await client.query(
      `INSERT INTO users (telegram_id, phone, wb_token, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (telegram_id) DO UPDATE SET phone = $2, wb_token = $3, updated_at = NOW()`,
      [req.telegramId, phone, result.token]
    );
    // Удаляем временную запись
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
//  МАРШРУТЫ ДЛЯ РАБОТЫ С WILDBERRIES (защищены)
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
  const { skus } = req.query; // ?skus=123,456
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

// Создать запрос на перемещение (пока только сохраняется в БД)
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

// Список всех запросов на перемещение
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
//  ПЛАТЕЖИ (ЮKassa) – каркас
// =====================================================

const yooKassa = YooKassa({
  shop_id: process.env.YOOKASSA_SHOP_ID,
  secret_key: process.env.YOOKASSA_SECRET_KEY
});

app.post('/payments/create', telegramAuth, async (req, res) => {
  const { amount } = req.body;
  if (!amount) return res.status(400).json({ error: 'Укажите сумму' });
  try {
    const payment = await yooKassa.payments.create({
      amount: { value: amount, currency: 'RUB' },
      confirmation: { type: 'redirect', return_url: 'https://yourdomain.com/success' },
      capture: true
    });
    await client.query(
      'INSERT INTO payments (user_id, amount, status, yookassa_id) VALUES ($1, $2, $3, $4)',
      [req.telegramId, amount, 'pending', payment.id]
    );
    res.json({ confirmation_url: payment.confirmation.confirmation_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось создать платёж' });
  }
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

// --- Запуск сервера ---
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});