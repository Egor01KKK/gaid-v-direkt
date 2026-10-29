// Понятная подсказка «что сделать» по ошибке Meta, сохранённой в api_attempts.
// Тексты — для владельца аккаунта, не для разработчика.

export interface MetaErrorInput {
  metaErrorCode: string | null;
  metaErrorMessage: string | null;
  httpStatus: number | null;
}

const RATE_LIMIT_CODES = new Set(['4', '17', '32', '613']);

export function hintForMetaError({ metaErrorCode, metaErrorMessage, httpStatus }: MetaErrorInput): string {
  const code = metaErrorCode ?? '';
  const msg = (metaErrorMessage ?? '').toLowerCase();

  if (msg.includes('disabled access to instagram direct')) {
    return 'В Instagram выключен доступ к сообщениям для подключённых программ. Включите: Instagram → ☰ → Settings and activity → Messages and story replies → Message requests → Connected tools → Allow access to messages.';
  }
  if (code === '190') {
    return 'Токен страницы больше не действует (например, сменили пароль Facebook или отозвали доступ). Запустите установщик ещё раз: новый токен в Graph API Explorer → «Проверить» → «Установить робота».';
  }
  if (code === '10' || code === '200' || code === '803') {
    return 'У токена не хватает разрешений. Сгенерируйте токен в Graph API Explorer заново со всеми 7 разрешениями и запустите установщик ещё раз.';
  }
  if (code === '368') {
    return 'Meta временно ограничила действия аккаунта. Подождите и не отправляйте много сообщений подряд; при повторении проверьте уведомления Meta в Instagram.';
  }
  if (code === '551' || msg.includes('not available') || msg.includes('недоступ')) {
    return 'Этому человеку сейчас нельзя отправить сообщение (он ограничил сообщения или удалил комментарий). Робот ничего не может с этим сделать.';
  }
  if (RATE_LIMIT_CODES.has(code) || httpStatus === 429) {
    return 'Meta ограничила частоту запросов. Робот сам повторит позже — ничего делать не нужно.';
  }
  if (code === '100' && (msg.includes('find the requested user') || msg.includes('найти запрошенного пользователя'))) {
    return 'Meta не нашла получателя. Обычно это значит, что комментарий удалили или ответ ушёл не через страницу Facebook. Если повторяется на новых комментариях — переустановите робота установщиком.';
  }
  if (httpStatus !== null && httpStatus >= 500) {
    return 'Временная ошибка на стороне Meta. Робот повторит попытку сам.';
  }
  return 'Meta отклонила запрос. Текст ошибки — ниже; если повторяется, пришлите его тому, кто настраивал робота.';
}
