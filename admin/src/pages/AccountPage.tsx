// 帳號設定頁：變更登入密碼。
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { AppHeader } from '../components/AppHeader';
import { apiPost, type ApiError } from '../api/client';

const MIN_PASSWORD_LENGTH = 12;

export function AccountPage() {
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`Новый пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов.`);
      return;
    }
    if (newPassword !== confirm) {
      setError('Новые пароли не совпадают.');
      return;
    }

    setBusy(true);
    try {
      await apiPost('/api/admin/auth/change-password', { currentPassword, newPassword });
      setNotice('Пароль обновлён ✓');
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.status === 401) navigate('/login');
      else setError(apiErr.message ?? 'Не получилось обновить пароль. Попробуйте ещё раз чуть позже.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <AppHeader />
      <div className="container container-tight">
        <h1 className="page-title">Настройки аккаунта</h1>
        <div className="card">
          <h2 className="card-title">Смена пароля</h2>
          <form onSubmit={handleSubmit}>
            <div className="form-field">
              <label className="label" htmlFor="current-password">
                Текущий пароль
              </label>
              <input
                id="current-password"
                className="input"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </div>
            <div className="form-field">
              <label className="label" htmlFor="new-password">
                Новый пароль
              </label>
              <input
                id="new-password"
                className="input"
                type="password"
                autoComplete="new-password"
                placeholder={`Не короче ${MIN_PASSWORD_LENGTH} символов`}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
              />
            </div>
            <div className="form-field">
              <label className="label" htmlFor="confirm-password">
                Повторите новый пароль
              </label>
              <input
                id="confirm-password"
                className="input"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </div>

            {error ? (
              <div className="alert alert-danger alerts-block" role="alert">
                {error}
              </div>
            ) : null}
            {notice ? (
              <div className="alert alert-success alerts-block" role="status">
                {notice}
              </div>
            ) : null}

            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Сохраняем…' : 'Сохранить пароль'}
            </button>
          </form>
        </div>
        <p className="page-subtitle is-footnote">
          Восстановить забытый пароль здесь нельзя, поэтому сохраните новый пароль в надёжном месте.
        </p>
      </div>
    </>
  );
}
