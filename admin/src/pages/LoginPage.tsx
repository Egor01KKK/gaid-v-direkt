// 登入頁：清爽專業風，使用 design token（styles/tokens.css）。
// 首次啟動（admin_users 為空）時改顯示「建立管理者帳號」表單，讓一鍵部署
// 的使用者不需開 terminal 即可完成後台設定。
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { apiGet, apiPost, type ApiError } from '../api/client';

const MIN_PASSWORD_LENGTH = 12;

export function LoginPage() {
  const navigate = useNavigate();
  // session 過期被自動導回時顯示提示（AppHeader 的過期檢查會帶 ?expired=1）。
  const [searchParams] = useSearchParams();
  const sessionExpired = searchParams.get('expired') === '1';
  const [mode, setMode] = useState<'loading' | 'login' | 'setup'>('loading');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiGet<{ needsSetup: boolean }>('/api/admin/auth/setup-status')
      .then((r) => setMode(r.needsSetup ? 'setup' : 'login'))
      .catch(() => setMode('login'));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (mode === 'setup') {
      if (password.length < MIN_PASSWORD_LENGTH) {
        setError(`Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов.`);
        return;
      }
      if (password !== passwordConfirm) {
        setError('Пароли не совпадают.');
        return;
      }
    }

    setSubmitting(true);
    try {
      if (mode === 'setup') {
        await apiPost('/api/admin/auth/setup', { email, password });
      } else {
        await apiPost('/api/admin/auth/login', { email, password });
      }
      navigate('/');
    } catch (err) {
      setError((err as ApiError).message ?? (mode === 'setup' ? 'Не получилось создать аккаунт.' : 'Не получилось войти.'));
    } finally {
      setSubmitting(false);
    }
  }

  if (mode === 'loading') {
    return <div className="login-viewport" />;
  }

  const isSetup = mode === 'setup';

  return (
    <div className="login-viewport">
      <div className="login-card">
        <div className="login-brand">
          <span className="dot dot-lg" />
          Робот комментарии → директ
        </div>
        <h1 className="login-title">{isSetup ? 'Создайте аккаунт' : 'Вход в панель управления'}</h1>
        <p className="login-hint">
          {isSetup
            ? 'Первый запуск: создайте аккаунт администратора (он будет единственным). После этого вы сразу войдёте, а эта страница больше не появится.'
            : 'Войдите, чтобы настраивать правила и смотреть срабатывания.'}
        </p>

        {sessionExpired && !error ? (
          <div className="alert alert-danger alerts-block" role="status">
            Вход истёк (он действует 8 часов). Войдите снова.
          </div>
        ) : null}

        <form onSubmit={handleSubmit}>
          <div className="form-field">
            <label className="label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              className="input"
              type="email"
              autoComplete="username"
              placeholder="admin@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label className="label" htmlFor="password">
              Пароль
            </label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete={isSetup ? 'new-password' : 'current-password'}
              placeholder={isSetup ? `Не короче ${MIN_PASSWORD_LENGTH} символов` : '••••••••'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {isSetup ? (
            <div className="form-field">
              <label className="label" htmlFor="password-confirm">
                Повторите пароль
              </label>
              <input
                id="password-confirm"
                className="input"
                type="password"
                autoComplete="new-password"
                placeholder="Введите пароль ещё раз"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                required
              />
            </div>
          ) : null}

          {error ? (
            <div className="alert alert-danger alerts-block" role="alert">
              {error}
            </div>
          ) : null}

          <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
            {submitting ? (isSetup ? 'Создаём…' : 'Входим…') : isSetup ? 'Создать аккаунт и войти' : 'Войти'}
          </button>
        </form>
      </div>
    </div>
  );
}
