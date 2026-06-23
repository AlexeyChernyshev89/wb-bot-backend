// Эталонный fingerprint, расшифрованный из реального solution WB.
// solution.payload = base64(hexCsv(XOR(JSON(fp), challengeId))). hash пустой — WB не проверяет содержимое.
module.exports = {
  "userAgent": "mozilla/5.0 (windows nt 10.0; win64; x64) applewebkit/537.36 (khtml, like gecko) chrome/149.0.0.0 safari/537.36",
  "appVersion": "5.0 (windows nt 10.0; win64; x64) applewebkit/537.36 (khtml, like gecko) chrome/149.0.0.0 safari/537.36",
  "languages": {
    "main": "ru-RU",
    "preferred": [
      "ru-RU",
      "ru",
      "en-US",
      "en"
    ],
    "dateTimePreffered": "ru"
  },
  "mimeTypes": {
    "mimeTypes": [
      "Portable Document Format::application/pdf",
      "Portable Document Format::text/pdf"
    ],
    "isPrototypesConsistent": true
  },
  "evalLength": 33,
  "plugins": {
    "plugins": [
      "PDF Viewer",
      "Chrome PDF Viewer",
      "Chromium PDF Viewer",
      "Microsoft Edge PDF Viewer",
      "WebKit built-in PDF"
    ],
    "pluginsTrueInstance": true
  },
  "documentElementAttrs": [
    "lang",
    "dir",
    "style"
  ],
  "errorTrace": "TypeError: Cannot read properties of null (reading '0')\n    at fn (https://antibot.wildberries.ru/statics/fingerprint_v1.0.26.js:1:80068)\n    at https://antibot.wildberries.ru/statics/fingerprint_v1.0.26.js:1:120801\n    at async Promise.all (index 7)\n    at async qe.solve (https://antibot.wildberries.ru/statics/challenge-solver_v1.0.6.js:1:48923)\n    at async L.solveChallenge (https://antibot.wildberries.ru/statics/challenge-solver_v1.0.6.js:1:57211)\n    at async L.solve (https://antibot.wildberries.ru/statics/challenge-solver_v1.0.6.js:1:56475)\n    at async we.createTokenWithRetries (https://static-basket-02.wbbasket.ru/vol20/stock-control-front/v2.1.2/855.chunk.1bbead9284354abbcbc1.js:2:1278545)\n    at async we.createOneTimeToken (https://static-basket-02.wbbasket.ru/vol20/stock-control-front/v2.1.2/855.chunk.1bbead9284354abbcbc1.js:2:1277943)\n    at async https://static-basket-02.wbbasket.ru/vol20/stock-control-front/v2.1.2/418.chunk.10ab37caaced4b5f26ff.js:1:129501\n    at async O (https://static-basket-02.wbbasket.ru/vol20/stock-control-front/v2.1.2/418.chunk.10ab37caaced4b5f26ff.js:1:129318)",
  "functionBind": "function bind() { [native code] }",
  "productSub": "20030107",
  "webDriver": false,
  "screenParams": {
    "wInnerHeight": 1412,
    "wOuterHeight": 1400,
    "wOuterWidth": 1782,
    "wInnerWidth": 826,
    "wScreenX": 778,
    "wPageXOffset": 0,
    "wPageYOffset": 453.3333435058594,
    "cWidth": 827,
    "cHeight": 1532,
    "sWidth": 2560,
    "sHeight": 1440,
    "sAvailWidth": 2560,
    "sAvailHeight": 1400,
    "sColorDepth": 32,
    "sPixelDepth": 32,
    "wDevicePixelRatio": 0.8999999761581421,
    "wColorGamut": [
      "any"
    ]
  },
  "browserVendor": "chrome",
  "browserEngineType": "chromium",
  "platform": "Win32",
  "custom": true,
  "timezone": "Europe/Moscow",
  "math": {
    "acos": 1.047197551196598,
    "asin": 0,
    "cos": 0,
    "largeCos": 0.763970404441728,
    "largeSin": -0.645251285265781,
    "largeTan": -0.844602463019884,
    "sin": 0,
    "tan": 7e-14,
    "hypot": 5,
    "log1p": 9.99995e-06,
    "expm1": 1.000005e-05,
    "atan2": 0.523598775598299,
    "imul": -824525248
  },
  "canvas": {
    "winding": true,
    "geometry": "73ba292c90251e6ee8ed6e41cde7d8510b5f2485efb531b55c28d1a80eaa0800",
    "text": "24ea47a81370310e4a54d4099c927e373bdf3457f74eb4df1f7814027963b826",
    "tampered": false
  },
  "screen2": {
    "value": {
      "cdp": {
        "b": "ca",
        "t": "14",
        "s": 7
      },
      "ies": {
        "b": "di",
        "t": "10",
        "s": 0
      },
      "ion": {
        "b": "ar",
        "t": "7",
        "s": 3
      },
      "trs": {
        "b": "ar",
        "t": "8",
        "s": 1
      },
      "ace": {
        "b": "ap",
        "t": "12",
        "s": 0
      },
      "gth": {
        "b": "de",
        "t": "11",
        "s": 9
      },
      "ver": {
        "b": "de",
        "t": "16",
        "s": 8
      },
      "ent": {
        "b": "ar",
        "t": "16",
        "s": 9
      },
      "ind": {
        "b": "ma",
        "t": "15",
        "s": 4
      },
      "ges": {
        "b": "ma",
        "t": "6",
        "s": 6
      },
      "ins": {
        "b": "ar",
        "t": "9",
        "s": 0
      },
      "sub": {
        "b": "di",
        "t": "15",
        "s": 3
      }
    }
  },
  "elapsedTime": 545,
  "elapsedTimeCleared": 0,
  "elapsedTimePerItem": {
    "value": {
      "userAgent": 0.10009765625,
      "appVersion": 0,
      "languages": 0.10009765625,
      "mimeTypes": 0.10009765625,
      "evalLength": 0,
      "plugins": 0.10009765625,
      "documentElementAttrs": 0,
      "errorTrace": 0.099853515625,
      "functionBind": 0,
      "productSub": 0,
      "webDriver": 0,
      "screenParams": 0.60009765625,
      "browserVendor": 0,
      "browserEngineType": 0.099853515625,
      "platform": 0,
      "custom": 0,
      "timezone": 0.199951171875,
      "math": 0.5,
      "canvas": 25.60009765625,
      "sum": 27.500244140625
    }
  }
};
