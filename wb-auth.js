// wb-auth.js — тестовая заглушка (имитирует отправку SMS)
async function requestSmsCode(phone) {
  console.log('📱 [TEST MODE] Имитация отправки SMS на номер', phone);
  // Генерируем случайный requestId
  const requestId = 'test-request-' + Date.now();
  // Заглушка всегда "успешна"
  return { success: true, requestId: requestId };
}

async function confirmSmsCode(phone, code, requestId) {
  console.log('🔐 [TEST MODE] Проверка кода для', phone, 'код:', code);
  // Принимаем любой код
  // Генерируем тестовый токен
  const testToken = 'test-wb-token-' + Date.now();
  return { success: true, token: testToken };
}

module.exports = { requestSmsCode, confirmSmsCode };