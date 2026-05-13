// wb-auth.js
const axios = require('axios');

// Базовые URL внутреннего API Wildberries (могут измениться, проверяйте актуальность)
const WB_AUTH_BASE = 'https://wbx-auth.wildberries.ru/api/v1';   // для авторизации
const WB_API_BASE = 'https://suppliers-api.wildberries.ru';      // для работы с остатками

/**
 * Шаг 1: Запросить SMS-код для номера телефона.
 * @param {string} phone - Номер в формате +79991234567
 * @returns {object} - { success: true, requestId } или { success: false, error }
 */
async function requestSmsCode(phone) {
  try {
    const response = await axios.post(`${WB_AUTH_BASE}/sms/send`, {
      phone,
      type: 'authorization'   // или другой тип, наблюдайте за реальными запросами
    }, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    // Обычно ответ содержит requestId, который нужен для подтверждения
    if (response.data && response.data.requestId) {
      return { success: true, requestId: response.data.requestId };
    } else {
      return { success: false, error: 'Неожиданный ответ от WB' };
    }
  } catch (err) {
    console.error('Ошибка отправки SMS:', err.response?.data || err.message);
    return { success: false, error: 'Не удалось отправить SMS. Проверьте номер.' };
  }
}

/**
 * Шаг 2: Подтвердить SMS-код и получить токен доступа.
 * @param {string} phone - Номер телефона
 * @param {string} code - Код из SMS
 * @param {string} requestId - Идентификатор запроса из предыдущего шага
 * @returns {object} - { success: true, token } или { success: false, error }
 */
async function confirmSmsCode(phone, code, requestId) {
  try {
    const response = await axios.post(`${WB_AUTH_BASE}/sms/verify`, {
      phone,
      code,
      requestId,
      remember: true
    }, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 ...'
      }
    });
    // После успешной верификации Wildberries возвращает токен (обычно в поле access_token или token)
    const token = response.data?.access_token || response.data?.token;
    if (token) {
      return { success: true, token };
    } else {
      return { success: false, error: 'Не удалось получить токен после верификации' };
    }
  } catch (err) {
    console.error('Ошибка подтверждения SMS:', err.response?.data || err.message);
    return { success: false, error: 'Неверный код или запрос устарел' };
  }
}

module.exports = { requestSmsCode, confirmSmsCode };