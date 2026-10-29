// 共用頁首：品牌（點擊回首頁）＋右側「新增自動化」下拉與使用者頭像選單（email／帳號設定／登出）。
import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { apiGet, apiPost, type ApiError } from '../api/client';

type OpenMenu = 'new' | 'user' | null;

export function AppHeader() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);

  useEffect(() => {
    apiGet<{ email: string }>('/api/admin/auth/me')
      .then((r) => setEmail(r.email))
      .catch(() => setEmail(''));
  }, []);

  // session 過期自動登出：每 5 分鐘＋分頁重新取得焦點時檢查一次，
  // 過期（401）就導回登入頁——避免頁面停留在過期的舊資料上，操作看似沒反應。
  useEffect(() => {
    let cancelled = false;
    async function checkSession() {
      try {
        await apiGet('/api/admin/auth/me');
      } catch (e) {
        if (!cancelled && (e as ApiError).status === 401) navigate('/login?expired=1');
      }
    }
    const timer = setInterval(checkSession, 5 * 60 * 1000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void checkSession();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [navigate]);

  async function logout() {
    try {
      await apiPost('/api/admin/auth/logout', {});
    } catch {
      /* ignore */
    }
    navigate('/login');
  }

  function goNew(scope: 'next_post' | 'account_default') {
    setOpenMenu(null);
    navigate(`/automations/new?scope=${scope}`);
  }

  return (
    <header className="app-header">
      <NavLink to="/" className="app-brand">
        <span className="dot" />
        Робот комментарии → директ
      </NavLink>
      <div className="app-header-right">
        <div className="nav-menu">
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setOpenMenu(openMenu === 'new' ? null : 'new')}
          >
            + Новое правило
          </button>
          {openMenu === 'new' ? (
            <>
              <div className="nav-menu-backdrop" onClick={() => setOpenMenu(null)} />
              <div className="nav-dropdown is-right">
                <button type="button" onClick={() => goNew('next_post')}>
                  <strong>Для следующего поста</strong>
                  <span>Подключится само, как только выйдет новый пост. Даже первый комментарий не потеряется</span>
                </button>
                <button type="button" onClick={() => goNew('account_default')}>
                  <strong>Для всех новых постов</strong>
                  <span>Работает на всех постах, у которых нет своего правила</span>
                </button>
              </div>
            </>
          ) : null}
        </div>
        <div className="nav-menu">
          <button
            className="avatar-btn"
            title="Меню аккаунта"
            aria-label="Меню аккаунта"
            onClick={() => setOpenMenu(openMenu === 'user' ? null : 'user')}
          >
            {email ? email[0].toUpperCase() : '?'}
          </button>
          {openMenu === 'user' ? (
            <>
              <div className="nav-menu-backdrop" onClick={() => setOpenMenu(null)} />
              <div className="nav-dropdown is-right">
                <div className="user-menu-email">{email || '(вы не вошли)'}</div>
                <button
                  type="button"
                  onClick={() => {
                    setOpenMenu(null);
                    navigate('/account');
                  }}
                >
                  <strong>Настройки аккаунта</strong>
                  <span>Сменить пароль</span>
                </button>
                <button type="button" onClick={logout}>
                  <strong>Выйти</strong>
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
}
