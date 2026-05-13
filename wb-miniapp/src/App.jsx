import { useState, useEffect } from 'react';
import AuthScreen from './AuthScreen';
import MainScreen from './MainScreen';

const tg = window.Telegram.WebApp;

function App() {
  const [authorized, setAuthorized] = useState(null); // null = загрузка

  useEffect(() => {
    fetch('/auth/status', {
      headers: { 'Authorization': `tma ${tg.initData}` }
    })
      .then(res => res.json())
      .then(data => setAuthorized(data.authorized))
      .catch(() => setAuthorized(false));
  }, []);

  if (authorized === null) {
    return <div>Загрузка...</div>;
  }

  return authorized ? <MainScreen /> : <AuthScreen onSuccess={() => setAuthorized(true)} />;
}

export default App;