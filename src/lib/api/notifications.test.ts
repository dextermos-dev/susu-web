import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './errors';

const ENV = {
  VITE_APP_URL: 'http://localhost:5173',
  VITE_SUPABASE_URL: 'https://example.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'test-key',
  VITE_STELLAR_NETWORK: 'testnet',
  VITE_STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
  VITE_FACTORY_CONTRACT_ID: '',
  VITE_USDC_CONTRACT_ID: '',
  VITE_EXPLORER_BASE_URL: 'https://stellar.expert/explorer/testnet',
  VITE_API_BASE_URL: 'https://api.example.test/api/v1',
};

vi.mock('../env', () => ({ getEnv: () => ENV }));

const { listNotifications, markNotificationRead } = await import('./notifications');

const NOTIFICATION = {
  id: 'notif-1',
  kind: 'round_due',
  title: 'Round 2 is due',
  body: 'Please contribute 10 USDC',
  data: { groupId: 1 },
  readAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function okPageWithBody(data: unknown, page: unknown, extra: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ data, page, ...extra }), { status: 200 });
}

describe('listNotifications', () => {
  it('reads notifications and unreadCount', async () => {
    fetchMock.mockResolvedValue(
      okPageWithBody([NOTIFICATION], { limit: 20, offset: 0, hasMore: false }, { unreadCount: 1 }),
    );

    const result = await listNotifications({ unreadOnly: false }, 'a-token');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe('Round 2 is due');
    expect(result.unreadCount).toBe(1);
  });

  it('fails validation when notification items are malformed', async () => {
    fetchMock.mockResolvedValue(
      okPageWithBody(
        [{ id: 'notif-1', kind: 12345 }], // kind should be string
        { limit: 20, offset: 0, hasMore: false },
        { unreadCount: 1 },
      ),
    );

    await expect(listNotifications({}, 'a-token')).rejects.toBeInstanceOf(ApiError);
  });

  it('fails validation when unreadCount is missing or malformed', async () => {
    fetchMock.mockResolvedValue(
      okPageWithBody(
        [NOTIFICATION],
        { limit: 20, offset: 0, hasMore: false },
        { unreadCount: 'not-a-number' },
      ),
    );

    await expect(listNotifications({}, 'a-token')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('markNotificationRead', () => {
  it('posts to the read path', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { success: true } }), { status: 200 }),
    );

    await markNotificationRead('notif-1', 'a-token');

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.example.test/api/v1/notifications/notif-1/read',
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
  });
});
