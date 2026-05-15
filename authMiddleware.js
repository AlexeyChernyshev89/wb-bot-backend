// middleware/authMiddleware.js
const { validate } = require('@telegram-apps/init-data-node');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const [authType, authData] = authHeader.split(' ');

  if (authType !== 'tma') {
    return res.status(401).json({ error: 'Требуется авторизация через Telegram' });
  }

  try {
    // Валидируем initData, чтобы убедиться, что запрос из нашего бота
    validate(authData, BOT_TOKEN, { expiresIn: 86400 }); // 24 часа

    // Извлекаем Telegram ID
    const initData = new URLSearchParams(authData);
    const user = JSON.parse(initData.get('user'));
    if (!user || !user.id) {
      return res.status(400).json({ error: 'Нет данных пользователя' });
    }

    req.telegramId = user.id;   // Идентификатор Telegram (число)
    next();
  } catch (error) {
    console.error('Ошибка валидации Telegram:', error);
    return res.status(403).json({ error: 'Недействительные данные Telegram' });
  }
}

module.exports = authMiddleware;