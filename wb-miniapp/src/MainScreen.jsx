import { useEffect, useState } from 'react';

const tg = window.Telegram.WebApp;
const authHeader = { 'Authorization': `tma ${tg.initData}` };

export default function MainScreen() {
  const [warehouses, setWarehouses] = useState([]);
  const [error, setError] = useState('');

  const loadWarehouses = async () => {
    try {
      const res = await fetch('/transfers/warehouses', { headers: authHeader });
      if (!res.ok) throw new Error('Ошибка загрузки');
      const data = await res.json();
      setWarehouses(data);
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    loadWarehouses();
  }, []);

  return (
    <div style={{ padding: '20px' }}>
      <h1>Управление поставками</h1>
      <p>Ваши склады:</p>
      {error && <p style={{ color: 'red' }}>{error}</p>}
      <ul>
        {warehouses.map(wh => (
          <li key={wh.id}>{wh.name} (ID: {wh.id})</li>
        ))}
      </ul>
    </div>
  );
}