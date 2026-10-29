import { describe, expect, it, vi } from 'vitest';
import { MetaClient } from '../../src/meta/client';
import { sendPrivateReply } from '../../src/meta/private-replies';

function captureClient() {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message_id: 'm' }), { status: 200 }));
  const client = new MetaClient({
    accessToken: 't',
    graphApiVersion: 'v21.0',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { client, fetchImpl };
}

async function sentRecipient(fetchImpl: ReturnType<typeof vi.fn>): Promise<unknown> {
  const [, init] = fetchImpl.mock.calls[0] as [unknown, RequestInit];
  const params = new URLSearchParams(String(init.body));
  return JSON.parse(params.get('recipient')!);
}

describe('sendPrivateReply — recipient 形式', () => {
  it('uses comment_id for comment private replies', async () => {
    const { client, fetchImpl } = captureClient();
    await sendPrivateReply(client, { instagramAccountId: 'a', commentId: 'c1', text: 'hi' });
    expect(await sentRecipient(fetchImpl)).toEqual({ comment_id: 'c1' });
  });

  it('posts to the IG account /messages with Instagram Login', async () => {
    const { client, fetchImpl } = captureClient();
    await sendPrivateReply(client, { instagramAccountId: 'ig-1', commentId: 'c1', text: 'hi' });
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://graph.instagram.com/v21.0/ig-1/messages');
  });

  it('posts to the Page (me/messages) with Facebook Login', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message_id: 'm' }), { status: 200 }));
    const client = new MetaClient({
      accessToken: 't',
      graphApiVersion: 'v21.0',
      baseUrl: 'https://graph.facebook.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await sendPrivateReply(client, { instagramAccountId: 'ig-1', commentId: 'c1', text: 'hi' });
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://graph.facebook.com/v21.0/me/messages');
  });

  it('uses user id for story replies (recipientId wins)', async () => {
    const { client, fetchImpl } = captureClient();
    await sendPrivateReply(client, { instagramAccountId: 'a', recipientId: 'user-9', text: 'hi' });
    expect(await sentRecipient(fetchImpl)).toEqual({ id: 'user-9' });
  });
});
