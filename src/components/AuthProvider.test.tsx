/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth, type AuthContextValue } from '@/lib/auth/context';

const mocks = vi.hoisted(() => ({
  getSupabaseClient: vi.fn(),
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  unsubscribe: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ getSupabaseClient: mocks.getSupabaseClient }));
vi.mock('@/lib/auth/actions', () => ({ signOut: mocks.signOut }));

import { AuthProvider } from './AuthProvider';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function session(id: string): Session {
  return {
    access_token: 'dummy-access-token',
    refresh_token: 'dummy-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    user: { id, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '' },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

describe('AuthProvider session observation', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;
  let auth: AuthContextValue;
  let onChange: (event: AuthChangeEvent, next: Session | null) => void;
  let firstRead: ReturnType<typeof deferred<{ data: { session: Session | null } }>>;

  function CurrentSession() {
    auth = useAuth();
    return <output data-status={auth.status}>{auth.user?.id ?? 'none'}</output>;
  }

  async function mount() {
    await act(async () => {
      root?.render(
        <AuthProvider>
          <CurrentSession />
        </AuthProvider>,
      );
    });
  }

  function state() {
    const output = container.querySelector('output');
    return { status: output?.dataset.status, user: output?.textContent };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    firstRead = deferred();
    mocks.getSession.mockReturnValue(firstRead.promise);
    mocks.onAuthStateChange.mockImplementation((callback: typeof onChange) => {
      onChange = callback;
      return { data: { subscription: { unsubscribe: mocks.unsubscribe } } };
    });
    mocks.getSupabaseClient.mockReturnValue({
      auth: { getSession: mocks.getSession, onAuthStateChange: mocks.onAuthStateChange },
    });
    mocks.signOut.mockResolvedValue({ ok: true, data: undefined });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    container.remove();
  });

  it('stays loading until the persisted session read resolves', async () => {
    await mount();
    expect(state()).toEqual({ status: 'loading', user: 'none' });

    await act(async () => firstRead.resolve({ data: { session: session('persisted-user') } }));

    expect(state()).toEqual({ status: 'authenticated', user: 'persisted-user' });
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
  });

  it('settles to anonymous when no persisted session exists', async () => {
    await mount();
    await act(async () => firstRead.resolve({ data: { session: null } }));
    expect(state()).toEqual({ status: 'anonymous', user: 'none' });
  });

  it('settles to anonymous when the initial session read rejects', async () => {
    await mount();
    await act(async () => firstRead.reject(new Error('dummy read failure')));
    expect(state()).toEqual({ status: 'anonymous', user: 'none' });
  });

  it('observes sign-in and sign-out changes without calling the client from the callback', async () => {
    await mount();
    await act(async () => firstRead.resolve({ data: { session: null } }));
    mocks.getSupabaseClient.mockClear();

    act(() => onChange('SIGNED_IN', session('new-user')));
    expect(state()).toEqual({ status: 'authenticated', user: 'new-user' });
    act(() => onChange('SIGNED_OUT', null));
    expect(state()).toEqual({ status: 'anonymous', user: 'none' });
    expect(mocks.getSupabaseClient).not.toHaveBeenCalled();
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
  });

  it('subscribes before reading so a change during the initial read is observed', async () => {
    const changed = session('during-read');
    mocks.getSession.mockImplementation(() => {
      onChange('SIGNED_IN', changed);
      return firstRead.promise;
    });

    await mount();

    expect(mocks.onAuthStateChange.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getSession.mock.invocationCallOrder[0]!,
    );
    expect(state()).toEqual({ status: 'authenticated', user: 'during-read' });
    await act(async () => firstRead.resolve({ data: { session: changed } }));
    expect(state()).toEqual({ status: 'authenticated', user: 'during-read' });
  });

  it('refreshes the visible session through the public context', async () => {
    await mount();
    await act(async () => firstRead.resolve({ data: { session: session('old-user') } }));
    mocks.getSession.mockResolvedValue({ data: { session: session('refreshed-user') } });

    await act(async () => auth.refresh());

    expect(state()).toEqual({ status: 'authenticated', user: 'refreshed-user' });
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
  });

  it('settles to anonymous without an unhandled rejection when refresh rejects', async () => {
    await mount();
    await act(async () => firstRead.resolve({ data: { session: session('old-user') } }));
    expect(state()).toEqual({ status: 'authenticated', user: 'old-user' });

    mocks.getSession.mockRejectedValue(new Error('network failure during refresh'));

    await act(async () => {
      await expect(auth.refresh()).resolves.toBeUndefined();
    });

    expect(state()).toEqual({ status: 'anonymous', user: 'none' });
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
  });

  it('drops the local session when sign-out reports a revocation failure', async () => {
    await mount();
    await act(async () => firstRead.resolve({ data: { session: session('signed-in-user') } }));
    mocks.signOut.mockResolvedValue({ ok: false, error: new Error('dummy revocation failure') });

    await act(async () => auth.signOut());

    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith();
    expect(state()).toEqual({ status: 'anonymous', user: 'none' });
  });

  it('observes the provider event after a successful sign-out action', async () => {
    await mount();
    await act(async () => firstRead.resolve({ data: { session: session('signed-in-user') } }));
    mocks.signOut.mockImplementation(async () => {
      onChange('SIGNED_OUT', null);
      return { ok: true, data: undefined };
    });

    await act(async () => auth.signOut());

    expect(state()).toEqual({ status: 'anonymous', user: 'none' });
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(['resolve', 'reject'] as const)(
    'unsubscribes while the initial read is pending, including a late %s and callback',
    async (completion) => {
      await mount();
      const observedBeforeUnmount = auth;
      act(() => root?.unmount());
      root = undefined;
      expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);

      await act(async () => {
        onChange('SIGNED_IN', session('too-late'));
        if (completion === 'resolve') firstRead.resolve({ data: { session: session('too-late') } });
        else firstRead.reject(new Error('late read failure'));
      });

      expect(container.childElementCount).toBe(0);
      expect(auth).toBe(observedBeforeUnmount);
      expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    },
  );
});
