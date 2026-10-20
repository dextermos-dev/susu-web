import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  listAvailableWallets,
  WalletError,
  type WalletAccount,
  type WalletAdapter,
} from '@/lib/wallet';
import { WalletContext, type WalletContextValue, type WalletStatus } from '@/lib/wallet/context';

/**
 * Provides the wallet session.
 *
 * This component only decides *what the session is*. The rules about when a
 * prompt may appear are in `@/lib/wallet/context`, and the signing rules are in
 * the adapters.
 */

function toWalletError(cause: unknown): WalletError {
  if (cause instanceof WalletError) return cause;
  return new WalletError(
    'malformed-response',
    cause instanceof Error ? cause.message : 'The wallet could not be reached.',
    { cause },
  );
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WalletStatus>('checking');
  const [account, setAccount] = useState<WalletAccount | undefined>(undefined);
  const [wallet, setWallet] = useState<WalletAdapter | undefined>(undefined);
  const [available, setAvailable] = useState<readonly WalletAdapter[]>([]);
  const [error, setError] = useState<WalletError | undefined>(undefined);

  const isMounted = useRef(true);
  const pendingConnect = useRef<Promise<WalletAccount | undefined> | null>(null);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (wallet === undefined) return;

    let cancelled = false;
    let refreshRequest = 0;
    const refreshAccount = async (): Promise<void> => {
      const request = ++refreshRequest;
      try {
        const current = await wallet.getConnectedAccount();
        if (cancelled || request !== refreshRequest || !isMounted.current) return;
        setAccount(current ?? undefined);
        setStatus(current === null ? 'disconnected' : 'connected');
        setError(undefined);
      } catch (cause) {
        if (cancelled || request !== refreshRequest || !isMounted.current) return;
        setError(toWalletError(cause));
      }
    };

    const onFocus = (): void => void refreshAccount();
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') void refreshAccount();
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      refreshRequest += 1;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [wallet]);

  useEffect(() => {
    let cancelled = false;

    const detect = async (): Promise<void> => {
      try {
        const detected = await listAvailableWallets();
        if (cancelled || !isMounted.current) return;

        setAvailable(detected);
        const first = detected[0];

        if (first === undefined) {
          setStatus('unavailable');
          return;
        }

        setWallet(first);

        // Never prompts: this reports an existing authorization, or `null`.
        const existing = await first.getConnectedAccount();
        if (cancelled || !isMounted.current) return;

        if (existing === null) {
          setStatus('disconnected');
          return;
        }

        setAccount(existing);
        setStatus('connected');
      } catch (cause) {
        if (cancelled || !isMounted.current) return;
        setError(toWalletError(cause));
        setStatus('unavailable');
      }
    };

    void detect();

    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback((): Promise<WalletAccount | undefined> => {
    if (pendingConnect.current !== null) {
      return pendingConnect.current;
    }

    const task = (async (): Promise<WalletAccount | undefined> => {
      const target = wallet ?? (await listAvailableWallets())[0];

      if (target === undefined) {
        setError(new WalletError('unavailable', 'No Stellar wallet was found in this browser.'));
        setStatus('unavailable');
        return undefined;
      }

      setStatus('connecting');
      setError(undefined);

      try {
        const connected = await target.connect();
        if (!isMounted.current) return undefined;
        setWallet(target);
        setAccount(connected);
        setStatus('connected');
        return connected;
      } catch (cause) {
        if (!isMounted.current) return undefined;
        // A declined prompt leaves the session exactly as it was: still
        // disconnected. It is a decision, not a fault, so it must not be rendered
        // as a broken state.
        setError(toWalletError(cause));
        setStatus('disconnected');
        return undefined;
      } finally {
        pendingConnect.current = null;
      }
    })();

    pendingConnect.current = task;
    return task;
  }, [wallet]);

  const disconnect = useCallback((): void => {
    pendingConnect.current = null;
    setAccount(undefined);
    setError(undefined);
    setStatus('disconnected');
  }, []);

  const value = useMemo<WalletContextValue>(
    () => ({
      status,
      address: account?.address,
      wallet,
      available,
      error,
      connect,
      disconnect,
    }),
    [status, account, wallet, available, error, connect, disconnect],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
