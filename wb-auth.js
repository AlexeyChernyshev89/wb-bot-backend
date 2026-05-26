// wb-auth.js — SMS-авторизация в ЛК продавца Wildberries
// Имитирует вход через браузер на seller.wildberries.ru
// Шаг 1: POST /passport/api/v2/auth/login_by_phone → requestToken
// Шаг 2: POST /passport/api/v2/auth/login + SMS-код → Cookie сессии → Authorizev3 JWT

const axios  = require('axios');
const dns    = require('dns');
const https  = require('https');

// ─── Кастомный DNS-резолвер ────────────────────────────────────────────────
// Railway иногда не резолвит .ru домены через свой дефолтный DNS.
// Явно используем Google (8.8.8.8) и Cloudflare (1.1.1.1).
const wbResolver = new dns.Resolver();
wbResolver.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

function wbLookup(hostname, options, callback) {
  wbResolver.resolve4(hostname, (err, addrs) => {
    if (!err && addrs && addrs.length) {
      return callback(null, addrs[0], 4);
    }
    // fallback to IPv6
    wbResolver.resolve6(hostname, (err2, addrs6) => {
      if (!err2 && addrs6 && addrs6.length) return callback(null, addrs6[0], 6);
      // fallback to system DNS
      dns.lookup(hostname, options, callback);
    });
  });
}

// HTTPS-агент с кастомным lookup — используется во всех запросах к WB
const WB_AGENT = new https.Agent({ lookup: wbLookup, keepAlive: true });

console.log('[wb-auth] Custom DNS agent initialized (Google 8.8.8.8 / Cloudflare 1.1.1.1)');

// Эндпоинты авторизации WB (пробуем по очереди если основной недоступен)
const WB_AUTH_ENDPOINTS = [
  'https://content-suppliers.wildberries.ru/passport/api/v2/auth',
  'https://seller.wildberries.ru/passport/api/v2/auth',
  'https://passport.wildberries.ru/api/v2/auth',
];

// Общие заголовки — имитируем браузер на seller.wildberries.ru
const BROWSER_HEADERS = {
  'Content-Type':   'application/json',
  'Accept':         'application/json, text/plain, */*',
  'User-Agent':     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Origin':         'https://seller.wildberries.ru',
  'Referer':        'https://seller.wildberries.ru/',
  'Accept-Language':'ru-RU,ru;q=0.9,en-US;q=0.8',
};

/**
 * Шаг 1 — запросить SMS-код на номер телефона.
 * @param {string} phone — номер в формате +79991234567
 * @returns {{ success: boolean, requestToken?: string, error?: string }}
 */
async function requestSmsCode(phone) {
  const cleanPhone = phone.replace(/[\s\-\(\)]/g, '');
  console.log(`[wb-auth] Запрос SMS на номер ${cleanPhone}`);

  let lastError = null;

  // Перебираем эндпоинты — WB периодически меняет URL
  for (const base of WB_AUTH_ENDPOINTS) {
    try {
      console.log(`[wb-auth] Trying: ${base}/login_by_phone`);
      const res = await axios.post(
        `${base}/login_by_phone`,
        { phone: cleanPhone, is_terms_and_conditions_accepted: true },
        { headers: BROWSER_HEADERS, timeout: 12000, httpsAgent: WB_AGENT, validateStatus: s => s < 500 }
      );

      const status = res.status;
      console.log(`[wb-auth] ${base} → status ${status}, data:`, JSON.stringify(res.data)?.substring(0, 100));

      if (status === 429) return { success: false, error: 'Слишком много попыток. Подождите несколько минут.' };
      if (status === 400) return { success: false, error: res.data?.message || 'Неверный номер телефона' };
      if (status === 404) return { success: false, error: 'Продавец с этим номером не найден на WB' };

      if (status !== 200) {
        lastError = `HTTP ${status}: ${JSON.stringify(res.data)}`;
        continue; // пробуем следующий эндпоинт
      }

      const requestToken = res.data?.token || res.data?.requestId || res.data?.requestToken || null;
      if (!requestToken) {
        console.warn('[wb-auth] No token in response:', JSON.stringify(res.data));
        lastError = 'WB не вернул токен запроса. Ответ: ' + JSON.stringify(res.data)?.substring(0, 80);
        continue;
      }

      console.log(`[wb-auth] ✅ SMS запрошен через ${base}. Token: ${requestToken.substring(0, 20)}...`);
      return { success: true, requestToken };

    } catch (err) {
      const status = err.response?.status;
      lastError = `${base}: ${err.message} (${status || 'no response'})`;
      console.warn(`[wb-auth] ${base} failed:`, lastError);
    }
  }

  console.error('[wb-auth] Все эндпоинты недоступны. lastError:', lastError);
  return { success: false, error: lastError || 'Не удалось подключиться к WB. Проверьте номер телефона.' };
}

/**
 * Шаг 2 — подтвердить SMS-код и получить сессионные данные.
 * @param {string} phone        — номер телефона
 * @param {string} smsCode      — 6-значный код из SMS
 * @param {string} requestToken — токен из шага 1
 * @returns {{ success: boolean, sessionToken?: string, cookies?: string, error?: string }}
 */
async function confirmSmsCode(phone, smsCode, requestToken) {
  const cleanPhone = phone.replace(/[\s\-\(\)]/g, '');
  const cleanCode  = smsCode.trim();
  console.log(`[wb-auth] Подтверждение кода ${cleanCode} для ${cleanPhone}`);

  try {
    // используем тот же базовый URL что сработал (или первый по умолчанию)
    const base = WB_AUTH_ENDPOINTS[0];
    const res = await axios.post(
      `${base}/login`,
      {
        token:   requestToken,
        options: { notify_code: cleanCode },
      },
      {
        headers:          BROWSER_HEADERS,
        timeout:          15000,
        httpsAgent:       WB_AGENT,
        withCredentials:  true,
        // Важно — читаем Set-Cookie из ответа
        validateStatus:   s => s < 500,
      }
    );

    const status = res.status;
    console.log(`[wb-auth] confirmSmsCode status: ${status}`);

    if (status === 400 || status === 422) {
      const msg = res.data?.message || 'Неверный SMS-код';
      return { success: false, error: msg };
    }
    if (status !== 200) {
      return { success: false, error: `Ошибка WB Auth (${status})` };
    }

    // Собираем Set-Cookie из ответа — это и есть наша сессия
    const setCookieHeader = res.headers['set-cookie'];
    let sessionCookies = '';
    if (Array.isArray(setCookieHeader)) {
      sessionCookies = setCookieHeader
        .map(c => c.split(';')[0])   // берём только имя=значение без expires и т.д.
        .join('; ');
    }

    // Пробуем извлечь Authorizev3 JWT из тела ответа или cookie
    const bodyToken = res.data?.token || res.data?.accessToken || res.data?.access_token || null;

    // Ищем zzatw-wb в cookies — это обычно и есть Authorizev3
    let authorizev3 = bodyToken;
    if (!authorizev3 && setCookieHeader) {
      const zzatwCookie = (Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader])
        .find(c => c.includes('zzatw-wb='));
      if (zzatwCookie) {
        authorizev3 = zzatwCookie.split('zzatw-wb=')[1]?.split(';')[0] || null;
      }
    }

    console.log(`[wb-auth] ✅ Авторизация успешна. cookies=${sessionCookies.length}b authorizev3=${authorizev3 ? authorizev3.substring(0,20)+'...' : 'не найден'}`);

    // Если не нашли Authorizev3 напрямую — пробуем получить его отдельным запросом
    if (!authorizev3 && sessionCookies) {
      authorizev3 = await fetchAuthorizev3(sessionCookies);
    }

    return {
      success:      true,
      sessionToken: authorizev3 || sessionCookies,  // используем что получили
      cookies:      sessionCookies,
    };

  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data;
    console.error('[wb-auth] confirmSmsCode error:', status, JSON.stringify(detail));
    return { success: false, error: detail?.message || `Ошибка подтверждения (${status || 'сеть'})` };
  }
}

/**
 * Получить Authorizev3 JWT через сессионные cookie.
 * Некоторые версии WB требуют отдельного запроса для получения JWT.
 */
async function fetchAuthorizev3(sessionCookies) {
  const endpoints = [
    'https://seller.wildberries.ru/user-settings/api/v1/user-config',
    'https://seller.wildberries.ru/ns/identity/auth/login-response',
    'https://seller-supply.wildberries.ru/ns/identity/auth/login-response',
  ];

  for (const url of endpoints) {
    try {
      const res = await axios.get(url, {
        headers: {
          ...BROWSER_HEADERS,
          Cookie: sessionCookies,
        },
        timeout: 10000,
        httpsAgent: WB_AGENT,
        validateStatus: s => s < 500,
      });
      const token = res.data?.token || res.data?.accessToken
        || res.headers?.['authorizev3'] || null;
      if (token) {
        console.log(`[wb-auth] Authorizev3 получен через ${url}`);
        return token;
      }
    } catch {}
  }
  console.warn('[wb-auth] Authorizev3 не найден, используем cookies напрямую');
  return null;
}

module.exports = { requestSmsCode, confirmSmsCode };
