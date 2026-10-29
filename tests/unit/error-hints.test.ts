import { describe, expect, it } from 'vitest';
import { hintForMetaError } from '../../src/meta/error-hints';

const h = (code: string | null, message: string | null, httpStatus: number | null = 400) =>
  hintForMetaError({ metaErrorCode: code, metaErrorMessage: message, httpStatus });

describe('hintForMetaError', () => {
  it('points to the Instagram «Allow access to messages» toggle (real error 2026-10-29)', () => {
    const hint = h('200', '(#200) The account owner has disabled access to Instagram Direct Messaging Outside of Instagram App.', 403);
    expect(hint).toContain('Allow access to messages');
    expect(hint).toContain('Message requests');
  });

  it('explains an expired page token', () => {
    expect(h('190', 'Error validating access token')).toContain('Токен страницы');
  });

  it('explains missing permissions', () => {
    expect(h('10', 'Permission denied')).toContain('7 разрешениями');
  });

  it('explains the «cannot find the requested user» error in Russian and English', () => {
    expect(h('100', '(#100) Не удается найти запрошенного пользователя.')).toContain('не нашла получателя');
    expect(h('100', 'Cannot find the requested user')).toContain('не нашла получателя');
  });

  it('tells the owner rate limits and Meta outages need no action', () => {
    expect(h('4', 'Application request limit reached')).toContain('ничего делать не нужно');
    expect(h(null, null, 503)).toContain('повторит');
  });

  it('falls back to a generic hint', () => {
    expect(h('1', 'Something odd')).toContain('Meta отклонила запрос');
  });
});
