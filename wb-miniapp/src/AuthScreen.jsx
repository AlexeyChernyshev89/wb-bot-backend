import { useState } from 'react';

const tg = window.Telegram.WebApp;
const authHeader = {
  'Authorization': `tma ${tg.initData}`,
  'Content-Type': 'application/json'
};

export default function AuthScreen({ onSuccess }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState('phone');
  const [error, setError] = useState('');

  const requestSms = async () => {
    setError('');
    const res = await fetch('/auth/request-sms', {
      method: 'POST',
      headers: authHeader,
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (data.success) {
      setStep('code');
    } else {
      setError(data.error || 'Ошибка отправки SMS');
    }
  };

  const verifySms = async () => {
    setError('');
    const res = await fetch('/auth/verify-sms', {
      method: 'POST',
      headers: authHeader,
      body: JSON.stringify({ code })
    });
    const data = await res.json();
    if (data.success) {
      onSuccess();
    } else {
      setError(data.error || 'Неверный код');
    }
  };

  return (
    <div style={{ padding: '20px' }}>
      <h2>Вход в Wildberries</h2>
      {step === 'phone' ? (
        <div>
          <input
            type="tel"
            placeholder="+7 (999) 123-45-67"
            value={phone}
            onChange={e => setPhone(e.target.value)}
          />
          <button onClick={requestSms}>Получить код</button>
        </div>
      ) : (
        <div>
          <p>Код отправлен на {phone}</p>
          <input
            type="text"
            placeholder="Введите код"
            value={code}
            onChange={e => setCode(e.target.value)}
          />
          <button onClick={verifySms}>Подтвердить</button>
        </div>
      )}
      {error && <p style={{ color: 'red' }}>{error}</p>}
    </div>
  );
}