const router = require('express').Router();
const { getWarehouses, getStocks, updateStocks } = require('../wb-api');
const auth = require('../middleware/authMiddleware');
const client = require('../db'); // Твой клиент БД

// Получить список складов
router.get('/warehouses', auth, async (req, res) => {
  try {
    // Берем API-ключ текущего пользователя из БД
    const user = await client.query('SELECT api_key_wb FROM users WHERE telegram_id = $1', [req.userId]);
    const warehouses = await getWarehouses(user.rows[0].api_key_wb);
    res.json(warehouses);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch warehouses' });
  }
});

// Получить остатки по складу
router.get('/stocks/:warehouseId', auth, async (req, res) => {
  // ... Логика похожа на предыдущую: получаем ключ пользователя и вызываем getStocks
});

// Создать запрос на перемещение
router.post('/create', auth, async (req, res) => {
  const { from_warehouse, to_warehouse, sku, amount } = req.body;
  try {
    // Сохраняем запрос в БД со статусом 'pending'
    const result = await client.query(
      `INSERT INTO transfer_requests (user_id, from_warehouse, to_warehouse, sku, amount, status)
       VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *`,
      [req.userId, from_warehouse, to_warehouse, sku, amount]
    );
    res.json({ success: true, request: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create transfer request' });
  }
});

module.exports = router;