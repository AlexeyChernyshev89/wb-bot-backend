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

// HTTPS-агент: кастомный DNS + принудительный IPv4
// Railway EU использует IPv6, но WB auth API не принимает IPv6
const WB_AGENT = new https.Agent({ lookup: wbLookup, keepAlive: false, family: 4 });

console.log('[wb-auth] Custom DNS agent initialized (Google 8.8.8.8 / Cloudflare 1.1.1.1)');

const WB_AUTH_PROXY = process.env.WB_AUTH_PROXY || '';

// Порядок: прямые WB эндпоинты ПЕРВЫМИ (Railway EU + IPv4 + Google DNS)
// Cloudflare Worker — в конце как fallback (WB блокирует Cloudflare IP)
const WB_AUTH_ENDPOINTS = [
  'https://seller.wildberries.ru/passport/api/v2/auth',
  'https://passport.wildberries.ru/api/v2/auth',
  'https://content-suppliers.wildberries.ru/passport/api/v2/auth',
  ...(WB_AUTH_PROXY ? [WB_AUTH_PROXY + '/passport/api/v2/auth'] : []),
];

console.log('[wb-auth] Auth endpoints:', WB_AUTH_ENDPOINTS.length, '| proxy:', WB_AUTH_PROXY || 'none');

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
 * Сгенерировать UUID v4 (формат wbx-validation-key)
 */
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/**
 * Получить/сформировать cookies для WB auth запроса.
 * WB проверяет наличие wbx-validation-key перед отправкой SMS.
 * Пробуем:
 * 1. Получить реальные cookies через GET seller.wildberries.ru
 * 2. Если нет — добавляем обязательные cookies вручную
 */
async function getWbSessionCookies() {
  let cookieStr = '';

  // Пробуем получить реальные cookies
  try {
    const res = await axios.get('https://seller.wildberries.ru/', {
      headers: {
        'User-Agent':     BROWSER_HEADERS['User-Agent'],
        'Accept':         'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language':'ru-RU,ru;q=0.9,en-US;q=0.8',
      },
      httpsAgent:   WB_AGENT,
      timeout:      8000,
      maxRedirects: 3,
    });
    const setCookies = res.headers['set-cookie'] || [];
    cookieStr = setCookies.map(c => c.split(';')[0]).join('; ');
    console.log('[wb-auth] Real cookies:', cookieStr.substring(0, 150));
  } catch(e) {
    console.warn('[wb-auth] Could not GET seller.wildberries.ru:', e.message);
  }

  // Добавляем/заменяем обязательные ключи если их нет
  const needsValidationKey = !cookieStr.includes('wbx-validation-key');
  if (needsValidationKey) {
    const validationKey = uuidv4();
    console.log('[wb-auth] Generating wbx-validation-key:', validationKey);
    cookieStr = [
      cookieStr,
      `wbx-validation-key=${validationKey}`,
    ].filter(Boolean).join('; ');
  }

  console.log('[wb-auth] Final cookies:', cookieStr.substring(0, 200));
  return cookieStr;
}

/**
 * Шаг 1 — запросить SMS-код на номер телефона.
 * @param {string} phone — номер в формате +79991234567
 * @returns {{ success: boolean, requestToken?: string, error?: string }}
 */
async function requestSmsCode(phone) {
  const cleanPhone = phone.replace(/[\s\-\(\)]/g, '');
  console.log(`[wb-auth] Запрос SMS на номер ${cleanPhone}`);

  let lastError = null;

  // Получаем начальные cookies от WB (нужны чтобы SMS реально отправился)
  const wbCookies = await getWbSessionCookies();
  const authHeaders = { ...BROWSER_HEADERS, ...(wbCookies ? { Cookie: wbCookies } : {}) };

  // Перебираем эндпоинты — WB периодически меняет URL
  for (const base of WB_AUTH_ENDPOINTS) {
    try {
      console.log(`[wb-auth] Trying: ${base}/login_by_phone | cookies: ${wbCookies.substring(0, 80)}`);
      const res = await axios.post(
        `${base}/login_by_phone`,
        { phone: cleanPhone, is_terms_and_conditions_accepted: true },
        { headers: authHeaders, timeout: 12000, httpsAgent: WB_AGENT, validateStatus: s => s < 500 }
      );

      const status = res.status;
      console.log(`[wb-auth] ${base} → status ${status}, data:`, JSON.stringify(res.data)?.substring(0, 100));

      if (status === 429) return { success: false, error: 'Слишком много попыток. Подождите несколько минут.' };
      if (status === 400) return { success: false, error: res.data?.message || 'Неверный номер телефона' };
      if (status === 404) return { success: false, error: 'Продавец с этим номером не найден на WB' };

      // 204 = SMS успешно отправлена (нет тела ответа) — это нормальный ответ WB
      // 200 = SMS отправлена с токеном в теле
      if (status !== 200 && status !== 204) {
        lastError = `HTTP ${status}: ${JSON.stringify(res.data)?.substring(0, 60)}`;
        continue;
      }

      // Логируем заголовки для отладки
      console.log(`[wb-auth] ${base} → ${status} | headers:`, JSON.stringify(res.headers || {}).substring(0, 200));
      console.log(`[wb-auth] body:`, JSON.stringify(res.data)?.substring(0, 100));

      // При 204 нет токена — используем phone как идентификатор сессии
      const requestToken = res.data?.token || res.data?.requestId || res.data?.requestToken
        || (status === 204 ? 'phone:' + cleanPhone : null);

      if (!requestToken) {
        lastError = 'WB не вернул токен. Ответ: ' + JSON.stringify(res.data)?.substring(0, 80);
        continue;
      }

      console.log('[wb-auth] ✅ SMS отправлена через', base, '| token:', requestToken.substring(0, 30));
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
  const wbCookies  = await getWbSessionCookies();

  // Если requestToken — sticker из Puppeteer (wb-captcha flow)
  const isStickerBased = requestToken && requestToken.startsWith('sticker:');
  if (isStickerBased) {
    const sticker = requestToken.replace('sticker:', '');
    console.log(`[wb-auth] Подтверждение через wb-captcha sticker: ${sticker.substring(0,8)}...`);
    try {
      const res = await axios.post(
        'https://seller-auth.wildberries.ru/auth/v2/login',
        { sticker, code: cleanCode },
        { headers: BROWSER_HEADERS, timeout: 15000, validateStatus: s => s < 500 }
      );
      console.log(`[wb-auth] seller-auth confirm → ${res.status}`, JSON.stringify(res.data).substring(0,100));
      if (res.status === 200 || res.status === 201) {
        const token = res.data?.token || res.data?.accessToken || res.data?.access_token
          || res.data?.payload?.token || null;
        return { success: true, sessionToken: token, cookies: '' };
      }
      if (res.status === 400 || res.status === 422) {
        return { success: false, error: res.data?.message || 'Неверный код' };
      }
    } catch(e) {
      console.warn('[wb-auth] seller-auth confirm error:', e.message);
    }
  }

  const isPhoneBased = requestToken && requestToken.startsWith('phone:');
  const confirmBody = isPhoneBased
    ? { phone: cleanPhone, code: cleanCode, options: { notify_code: cleanCode } }
    : { token: requestToken, options: { notify_code: cleanCode } };

  console.log('[wb-auth] confirm body:', JSON.stringify(confirmBody).substring(0, 100));

  // Перебираем endpoints — seller.wildberries.ru работает из Railway
  for (const base of WB_AUTH_ENDPOINTS) {
    try {
      const res = await axios.post(
        `${base}/login`,
        confirmBody,
        {
          headers:         BROWSER_HEADERS,
          timeout:         15000,
          httpsAgent:      WB_AGENT,
          withCredentials: true,
          validateStatus:  s => s < 500,
        }
      );

      const status = res.status;
      console.log(`[wb-auth] ${base}/login → ${status}`);

      if (status === 400 || status === 422) {
        const msg = res.data?.message || 'Неверный SMS-код';
        return { success: false, error: msg };
      }
      if (status === 204) {
        // WB возвращает 204 при успешном подтверждении — токен в Set-Cookie
        const setCookieHeader = res.headers['set-cookie'];
        let sessionCookies = '';
        if (Array.isArray(setCookieHeader)) {
          sessionCookies = setCookieHeader.map(c => c.split(';')[0]).join('; ');
        }
        let authorizev3 = null;
        if (setCookieHeader) {
          const zzatwCookie = (Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader])
            .find(c => c.includes('zzatw-wb='));
          if (zzatwCookie) authorizev3 = zzatwCookie.split('zzatw-wb=')[1]?.split(';')[0] || null;
        }
        if (!authorizev3 && sessionCookies) authorizev3 = await fetchAuthorizev3(sessionCookies);
        console.log(`[wb-auth] ✅ 204 через ${base}, authorizev3=${authorizev3 ? 'найден' : 'не найден'}`);
        return { success: true, sessionToken: authorizev3 || sessionCookies, cookies: sessionCookies };
      }
      if (status !== 200) {
        console.warn(`[wb-auth] ${base} → ${status}, trying next...`);
        continue;
      }

      const setCookieHeader = res.headers['set-cookie'];
      let sessionCookies = '';
      if (Array.isArray(setCookieHeader)) {
        sessionCookies = setCookieHeader.map(c => c.split(';')[0]).join('; ');
      }

      const bodyToken = res.data?.token || res.data?.accessToken || res.data?.access_token || null;
      let authorizev3 = bodyToken;
      if (!authorizev3 && setCookieHeader) {
        const zzatwCookie = (Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader])
          .find(c => c.includes('zzatw-wb='));
        if (zzatwCookie) {
          authorizev3 = zzatwCookie.split('zzatw-wb=')[1]?.split(';')[0] || null;
        }
      }

      console.log(`[wb-auth] ✅ Авторизация успешна через ${base}. authorizev3=${authorizev3 ? authorizev3.substring(0,20)+'...' : 'не найден'}`);

      if (!authorizev3 && sessionCookies) {
        authorizev3 = await fetchAuthorizev3(sessionCookies);
      }

      return {
        success:      true,
        sessionToken: authorizev3 || sessionCookies,
        cookies:      sessionCookies,
      };
    } catch (err) {
      console.warn(`[wb-auth] ${base}/login error:`, err.message);
    }
  }

  return { success: false, error: 'Ошибка подтверждения — все endpoint недоступны' };
}


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
