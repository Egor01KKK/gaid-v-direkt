// Admin API 的極簡 fetch 封裝。credentials: 'include' 讓瀏覽器自動帶上 Session Cookie。
export interface ApiError {
  status: number;
  message: string;
  // 啟用失敗（422）時伺服器回傳的原因代碼，由頁面翻成可讀文字。
  reasons?: string[];
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'include' });
  if (!res.ok) {
    const err: ApiError = { status: res.status, message: `HTTP ${res.status}` };
    throw err;
  }
  return (await res.json()) as T;
}

export async function apiPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let message = 'Что-то пошло не так. Попробуйте ещё раз чуть позже.';
    let reasons: string[] | undefined;
    if (res.status === 429) {
      message = 'Слишком много попыток. Подождите немного и попробуйте снова.';
    } else {
      try {
        const data = (await res.json()) as { error?: string; reasons?: unknown };
        if (data.error) message = data.error;
        if (Array.isArray(data.reasons)) reasons = data.reasons.filter((r): r is string => typeof r === 'string');
      } catch {
        // 忽略非 JSON 回應，沿用預設訊息。
      }
    }
    const err: ApiError = { status: res.status, message, reasons };
    throw err;
  }

  return (await res.json()) as T;
}
