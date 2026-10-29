// 自動化編輯器：為某篇貼文建立/編輯留言關鍵字自動回覆。
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { AppHeader } from '../components/AppHeader';
import { apiGet, apiPost, type ApiError } from '../api/client';

type MatchType = 'contains_any' | 'exact_any' | 'all_comments';

interface AutomationDetail {
  automation: {
    id: string;
    name: string;
    status: string;
    applyScope?: string;
    matchType: MatchType;
    publicReplyEnabled: number;
    privateReplyEnabled: number;
    openingDm: string | null;
    buttonText: string | null;
    buttonUrl: string | null;
    dailyLimit: number | null;
  };
  media: { id: string; mediaType: string } | null;
  keywords: string[];
  publicReplyVariants: string[];
}

// 新建自動化時預填的公開回覆範本（可改可刪）。
const DEFAULT_PUBLIC_REPLIES = [
  'Ответ уже у вас в директе, загляните 📩',
  'Прислали ссылку вам в директ — проверяйте!',
  'Написали вам в директ 🙌 Если не видно, загляните в «Запросы»',
];

const ACTIVATION_REASON_TEXT: Record<string, string> = {
  keywords_required: 'Добавьте хотя бы одно ключевое слово (или выберите «на любой комментарий»)',
  at_least_one_reply_required: 'Включите хотя бы что-то одно: ответ под комментарием или сообщение в директ',
  opening_dm_required: 'Напишите текст сообщения в директ — он не может быть пустым',
  private_reply_required_for_story: 'Для сторис нужно включить сообщение в директ — больше бот там ничего не делает',
  button_url_invalid: 'Ссылка кнопки должна быть рабочей и начинаться с https://',
  token_unhealthy: 'Проблема с доступом к Instagram (токен не работает)',
  emergency_stop_active: 'Сейчас включена аварийная остановка',
  automation_not_found: 'Правило не найдено',
};

export function AutomationEditorPage() {
  const navigate = useNavigate();
  const { mediaId } = useParams();
  const [searchParams] = useSearchParams();
  const automationId = searchParams.get('automationId');
  // 無 mediaId 時的套用範圍：next_post（下一篇新貼文）或 account_default（全帳號預設）。
  const scopeParam = searchParams.get('scope');
  const [applyScope, setApplyScope] = useState<string>(
    mediaId ? 'media' : (scopeParam ?? 'next_post'),
  );
  // 限動模式：新建時由首頁帶 ?story=1，編輯既有時由 API 的 media.mediaType 判斷。
  const [storyMode, setStoryMode] = useState(searchParams.get('story') === '1');

  const [name, setName] = useState('');
  const [matchType, setMatchType] = useState<MatchType>('contains_any');
  const [keywords, setKeywords] = useState<string[]>([]);
  const [keywordDraft, setKeywordDraft] = useState('');
  const [publicReplyEnabled, setPublicReplyEnabled] = useState(searchParams.get('story') !== '1');
  // 新建（非限動）預填三則繁中範本；編輯既有以伺服器資料為準。
  const [variants, setVariants] = useState<string[]>(
    automationId || searchParams.get('story') === '1' ? [''] : [...DEFAULT_PUBLIC_REPLIES],
  );
  const [privateReplyEnabled, setPrivateReplyEnabled] = useState(true);
  const [openingDm, setOpeningDm] = useState('');
  const [buttonEnabled, setButtonEnabled] = useState(false);
  const [buttonText, setButtonText] = useState('');
  const [buttonUrl, setButtonUrl] = useState('');
  const [dailyLimit, setDailyLimit] = useState('');

  const [status, setStatus] = useState('draft');
  const [savedId, setSavedId] = useState<string | null>(automationId);
  const [loading, setLoading] = useState(Boolean(automationId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activationErrors, setActivationErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!automationId) return;
    try {
      const d = await apiGet<AutomationDetail>(`/api/admin/automations/${automationId}`);
      setName(d.automation.name);
      setMatchType(d.automation.matchType);
      setKeywords(d.keywords);
      setPublicReplyEnabled(d.automation.publicReplyEnabled === 1);
      setVariants(d.publicReplyVariants.length ? d.publicReplyVariants : ['']);
      setPrivateReplyEnabled(d.automation.privateReplyEnabled === 1);
      setOpeningDm(d.automation.openingDm ?? '');
      setButtonEnabled(Boolean(d.automation.buttonUrl));
      setButtonText(d.automation.buttonText ?? '');
      setButtonUrl(d.automation.buttonUrl ?? '');
      setDailyLimit(d.automation.dailyLimit != null ? String(d.automation.dailyLimit) : '');
      setStatus(d.automation.status);
      setApplyScope(d.automation.applyScope ?? 'media');
      if (d.media?.mediaType === 'STORY') {
        setStoryMode(true);
        setPublicReplyEnabled(false);
      }
    } catch (e) {
      if ((e as ApiError).status === 401) navigate('/login');
      else setError((e as ApiError).message);
    } finally {
      setLoading(false);
    }
  }, [automationId, navigate]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function addKeyword() {
    const v = keywordDraft.trim();
    if (v && !keywords.includes(v)) setKeywords([...keywords, v]);
    setKeywordDraft('');
  }

  function payload() {
    return {
      ...(mediaId ? { instagramMediaId: mediaId } : { applyScope }),
      name: name.trim(),
      matchType,
      keywords: matchType === 'all_comments' ? [] : keywords,
      // 限動沒有留言串，公開回覆一律關閉。
      publicReplyEnabled: storyMode ? false : publicReplyEnabled,
      publicReplyVariants: storyMode ? [] : variants.map((v) => v.trim()).filter(Boolean),
      privateReplyEnabled,
      openingDm: openingDm.trim(),
      // 沒勾「加上連結按鈕」就送空字串 → 後端發純文字 DM。
      buttonText: buttonEnabled ? buttonText.trim() : '',
      buttonUrl: buttonEnabled ? buttonUrl.trim() : '',
      dailyLimit: dailyLimit ? Number(dailyLimit) : undefined,
    };
  }

  // 儲存：建立用 POST、更新用 PATCH。
  async function handleSave() {
    setError(null);
    setNotice(null);
    setActivationErrors([]);
    if (!name.trim()) {
      setError('Введите название правила');
      return;
    }
    setBusy(true);
    try {
      let id = savedId;
      if (id) {
        await patch(`/api/admin/automations/${id}`, payload());
      } else {
        const created = await apiPost<{ id: string }>('/api/admin/automations', payload());
        id = created.id;
        setSavedId(id);
      }
      setNotice('Сохранено ✓');
    } catch (e) {
      if ((e as ApiError).status === 401) {
        navigate('/login');
        return;
      }
      setError((e as ApiError).message ?? 'Не получилось сохранить');
    } finally {
      setBusy(false);
    }
  }

  async function handleActivate() {
    if (!savedId) {
      setError('Сначала сохраните правило, потом включайте');
      return;
    }
    setBusy(true);
    setError(null);
    setActivationErrors([]);
    try {
      await apiPost(`/api/admin/automations/${savedId}/activate`, {});
      setStatus('active');
      setNotice('Включено ✓');
    } catch (e) {
      const err = e as ApiError & { reasons?: string[] };
      if (err.status === 401) {
        navigate('/login');
        return;
      }
      if (err.status === 422 && err.reasons) setActivationErrors(err.reasons);
      else setError(err.message ?? 'Не получилось включить');
    } finally {
      setBusy(false);
    }
  }

  async function handlePause() {
    if (!savedId) return;
    setBusy(true);
    try {
      await apiPost(`/api/admin/automations/${savedId}/pause`, {});
      setStatus('paused');
      setNotice('Поставлено на паузу');
    } catch (e) {
      if ((e as ApiError).status === 401) {
        navigate('/login');
        return;
      }
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <>
        <AppHeader />
        <div className="container">
          <div className="state-note">Загружаем…</div>
        </div>
      </>
    );
  }

  return (
    <>
      <AppHeader />
      <div className="container container-narrow">
        <Link to="/" className="back-link">
          ← На главную
        </Link>

        <div className="status-line">
          <h1 className="page-title">
            {storyMode
              ? savedId
                ? 'Изменить правило для сторис'
                : 'Настроить правило для сторис'
              : applyScope === 'next_post'
                ? 'Правило для следующего поста'
                : applyScope === 'account_default'
                  ? 'Правило для всех новых постов'
                  : savedId
                    ? 'Изменить правило'
                    : 'Настроить правило'}
          </h1>
          {applyScope === 'next_post' ? (
            <span className="badge badge-neutral">Ждёт новый пост</span>
          ) : null}
          {status === 'active' ? (
            <span className="badge badge-success">Работает</span>
          ) : status === 'paused' ? (
            <span className="badge badge-warning">На паузе</span>
          ) : (
            <span className="badge badge-neutral">Черновик</span>
          )}
        </div>

        {storyMode ? (
          <p className="page-subtitle">
            Когда кто-то ответит на эту сторис сообщением с ключевым словом, бот пришлёт ему ваш текст в директ. Сторис живёт 24 часа, потом правило само встанет на паузу.
          </p>
        ) : applyScope === 'next_post' ? (
          <p className="page-subtitle">
            Заранее настройте ключевые слова и ответы и включите правило. Следующий новый пост (в том числе запланированный) подхватит его сам — даже первый комментарий не потеряется.
          </p>
        ) : applyScope === 'account_default' ? (
          <p className="page-subtitle">
            Это правило работает на всех постах, у которых нет своего правила. Такое правило может быть только одно. Если у поста есть своё правило, сработает именно оно.
          </p>
        ) : null}

        {error || activationErrors.length || notice ? (
          <div className="alerts-block">
            {error ? <div className="alert alert-danger">{error}</div> : null}
            {activationErrors.length ? (
              <div className="alert alert-danger">
                Не получилось включить:
                <ul className="alert-list">
                  {activationErrors.map((r) => (
                    <li key={r}>{ACTIVATION_REASON_TEXT[r] ?? r}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {notice ? <div className="alert alert-success">{notice}</div> : null}
          </div>
        ) : null}

        <div className="card">
          {/* 基本 */}
          <div className="form-section">
            <div className="form-field">
              <label className="label" htmlFor="name">Название правила</label>
              <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Например: гайд из видео про монтаж" />
            </div>
            <div className="form-field">
              <label className="label" htmlFor="match">Когда срабатывать</label>
              <select id="match" className="select" value={matchType} onChange={(e) => setMatchType(e.target.value as MatchType)}>
                <option value="contains_any">Содержит любое из слов</option>
                <option value="exact_any">Точно совпадает с одним из слов</option>
                <option value="all_comments">На любой комментарий</option>
              </select>
              <p className="field-help">
                Если ключевое слово — «+» или другой знак, выберите «точно совпадает»: иначе правило сработает на
                любой комментарий, где есть плюс.
              </p>
            </div>

            {matchType !== 'all_comments' ? (
              <div className="form-field">
                <label className="label">Ключевые слова</label>
                <div className="chips">
                  {keywords.map((k) => (
                    <span className="chip" key={k}>
                      {k}
                      <button type="button" onClick={() => setKeywords(keywords.filter((x) => x !== k))} aria-label="Удалить">
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <input
                  className="input"
                  value={keywordDraft}
                  onChange={(e) => setKeywordDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addKeyword();
                    }
                  }}
                  onBlur={addKeyword}
                  placeholder="Введите ключевое слово и нажмите Enter"
                />
                <p className="field-help">
                  {storyMode
                    ? 'Сработает, если ответ на сторис подходит под любое из ключевых слов. Большие и маленькие буквы не важны.'
                    : 'Сработает, если комментарий подходит под любое из ключевых слов. Большие и маленькие буквы не важны.'}
                </p>
              </div>
            ) : null}
          </div>

          {/* 公開回覆（限動沒有留言串，整區隱藏） */}
          {storyMode ? null : (
          <div className="form-section">
            <div className="toggle-row">
              <input id="pub" type="checkbox" checked={publicReplyEnabled} onChange={(e) => setPublicReplyEnabled(e.target.checked)} />
              <label htmlFor="pub">Отвечать под комментарием (ответ увидят все)</label>
            </div>
            {publicReplyEnabled ? (
              <>
                {variants.map((v, i) => (
                  <div className="variant-row" key={i}>
                    <input className="input" value={v} onChange={(e) => setVariants(variants.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`Вариант ответа ${i + 1} (например: Написали вам в директ 📩)`} />
                    {variants.length > 1 ? (
                      <button className="btn btn-ghost btn-sm" type="button" onClick={() => setVariants(variants.filter((_, j) => j !== i))}>
                        Удалить
                      </button>
                    ) : null}
                  </div>
                ))}
                {variants.length < 5 ? (
                  <button className="btn btn-ghost btn-sm" type="button" onClick={() => setVariants([...variants, ''])}>
                    + Добавить вариант
                  </button>
                ) : null}
                <p className="field-help">Бот каждый раз выбирает случайный вариант. Можно добавить до 5 вариантов.</p>
              </>
            ) : null}
          </div>
          )}

          {/* Private Reply */}
          <div className="form-section">
            <div className="toggle-row">
              <input id="dm" type="checkbox" checked={privateReplyEnabled} onChange={(e) => setPrivateReplyEnabled(e.target.checked)} />
              <label htmlFor="dm">Отправлять сообщение в директ автору комментария</label>
            </div>
            {privateReplyEnabled ? (
              <>
                <div className="form-field">
                  <label className="label" htmlFor="odm">Текст сообщения в директ</label>
                  <textarea id="odm" className="textarea" value={openingDm} onChange={(e) => setOpeningDm(e.target.value)} placeholder="Держите гайд из видео:&#10;https://..." />
                  <p className="field-help">Бот отправит только это одно сообщение. Ссылку можно вставить прямо в текст.</p>
                </div>

                <div className="toggle-row">
                  <input id="btn" type="checkbox" checked={buttonEnabled} onChange={(e) => setButtonEnabled(e.target.checked)} />
                  <label htmlFor="btn">Добавить кнопку со ссылкой (по желанию)</label>
                </div>
                {buttonEnabled ? (
                  <>
                    <p className="field-help is-tight">
                      В директе Instagram ссылка в тексте не всегда нажимается. С кнопкой по ссылке точно можно будет перейти.
                    </p>
                    <div className="form-field">
                      <label className="label" htmlFor="btntext">Текст кнопки</label>
                      <input id="btntext" className="input" value={buttonText} onChange={(e) => setButtonText(e.target.value)} placeholder="Открыть гайд" />
                    </div>
                    <div className="form-field">
                      <label className="label" htmlFor="btnurl">Ссылка кнопки (начинается с https://)</label>
                      <input id="btnurl" className="input" value={buttonUrl} onChange={(e) => setButtonUrl(e.target.value)} placeholder="https://..." />
                    </div>
                  </>
                ) : null}
              </>
            ) : null}
          </div>

          {/* 進階 */}
          <div className="form-section">
            <div className="form-field">
              <label className="label" htmlFor="daily">Лимит в день (по желанию)</label>
              <input id="daily" className="input" type="number" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} placeholder="Например, 2000" />
            </div>
          </div>

          <div className="btn-row">
            {!savedId ? <span className="field-help is-inline">Сначала сохраните, потом можно включить</span> : null}
            <button className="btn btn-outline" onClick={handleSave} disabled={busy}>
              {busy ? 'Секунду…' : 'Сохранить'}
            </button>
            {status !== 'active' ? (
              <button className="btn btn-primary" onClick={handleActivate} disabled={busy || !savedId}>
                Включить
              </button>
            ) : (
              <button className="btn btn-danger" onClick={handlePause} disabled={busy}>
                Поставить на паузу
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// PATCH helper（apiPost 只做 POST，這裡補一個 PATCH）。
async function patch<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const d = (await res.json()) as { error?: string };
      if (d.error) message = d.error;
    } catch {
      /* ignore */
    }
    throw { status: res.status, message } as ApiError;
  }
  return (await res.json()) as T;
}
