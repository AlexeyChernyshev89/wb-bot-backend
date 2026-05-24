// wb-auth.js — валидация и хранение API-токена Wildberries
// Официальная авторизация через Bearer-токен (JWT), выдаётся в ЛК продавца:
// Профиль → Настройки → Доступ к API → Создать токен (категория: Marketplace)
// Токен действителен 180 дней.

const axios = require('axios');

const WB_MARKETPLACE_API = 'https://marketplace-api.wildberries.ru';

/**
 * Проверяет валидность API-токена WB, делая реальный запрос к API.
 * @param {string} token — Bearer-токен из ЛК WB
 * @returns {{ success: boolean, error?: string }}
 */
async function validateWbToken(token) {
  if (!token || typeof token !== 'string' || token.trim().length < 10) {
    return { success: false, error: 'Токен слишком короткий или пустой' };
  }

  try {
    await axios.get(`${WB_MARKETPLACE_API}/api/v3/warehouses`, {
      headers: {
        'Authorization': `Bearer ${token.trim()}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    return { success: true };
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.detail || err.response?.data?.message || '';

    if (status === 401 || status === 403) {
      return { success: false, error: 'Токен недействителен или не имеет прав на категорию Marketplace' };
    }
    if (status === 429) {
      return { success: false, error: 'Слишком много запросов к WB API, попробуйте через минуту' };
    }
    if (err.code === 'ECONNABORTED') {
      return { success: false, error: 'Таймаут соединения с WB API' };
    }

    console.error('❌ Ошибка валидации токена WB:', status, detail);
    return { success: false, error: `Ошибка WB API (${status || 'сеть'}): ${detail || err.message}` };
  }
}

/**
 * Декодирует JWT-токен WB и возвращает данные из payload (без проверки подписи).
 * Позволяет узнать срок действия и доступные категории API.
 * @param {string} token
 * @returns {object|null}
 */
function decodeWbToken(token) {
  try {
    const parts = token.trim().split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload;
  } catch {
    return null;
  }
}

module.exports = { validateWbToken, decodeWbToken };