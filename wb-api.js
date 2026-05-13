const axios = require('axios');
const WB_API_BASE = 'https://suppliers-api.wildberries.ru'; // Базовый URL

// Общая функция для запросов к API
const apiRequest = async (apiKey, method, url, data = {}) => {
  try {
    const response = await axios({
      method,
      url: `${WB_API_BASE}${url}`,
      headers: {
        'Authorization': apiKey, // Токен авторизации
        'Content-Type': 'application/json'
      },
      data
    });
    return response.data;
  } catch (error) {
    console.error('WB API Error:', error.response?.data || error.message);
    throw error;
  }
};

// 1. Получение списка складов продавца
async function getWarehouses(apiKey) {
  return apiRequest(apiKey, 'GET', '/api/v3/warehouses');
}

// 2. Получение остатков по конкретному складу
async function getStocks(apiKey, warehouseId, skus) {
  return apiRequest(apiKey, 'POST', `/api/v3/stocks/${warehouseId}`, { skus });
}

// 3. Обновление остатков на складе
async function updateStocks(apiKey, warehouseId, data) {
  return apiRequest(apiKey, 'PUT', `/api/v3/stocks/${warehouseId}`, data);
}

module.exports = { getWarehouses, getStocks, updateStocks };