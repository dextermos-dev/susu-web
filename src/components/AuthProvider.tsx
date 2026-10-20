import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getSupabaseClient } from '@/lib/supabase';
import { signOut as signOutAction } from '@/lib/auth/actions';
import { AuthContext, type AuthContextValue, type AuthStatus } from '@/lib/auth/context';

/**
 * Provides the authentication session.
 *
 * The provider observes; it does not authenticate. Sign-in, sign-up and password
 * changes go through `@/lib/auth/actions`, and the resulting session arrives here
 * as a change from the provider. That split matters, because the provider cannot
 * be the only thing that knows about a session — a sign-in that happened in
 * another tab, or a recovery link that established a session before this
 * component mounted, has to be picked up too.
 *
 * The initial state is `loading`, not `anonymous`, and the distinction is
 * load-bearing. A persisted session is read asynchronously, so rendering
 * "anonymous" first would show a signed-out interface for a moment before
 * correcting itself — and would bounce a signed-in user to the login page every
 * time they reloaded, which is the kind of bug that trains people to distrust
 * the app.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [session, setSession] = useState<Session | undefined>(undefined);

  const applySession = useCallback((next: Session | null) => {
    setSession(next ?? undefined);
    setStatus(next === null ? 'anonymous' : 'authenticated');
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const { data } = await getSupabaseClient().auth.getSession();
      applySession(data.session);
    } catch {
      // A failure to refresh the session is handled safely to avoid unhandled
      // rejections. Treat it as no session, settling the provider to anonymous.
      applySession(null);
    }
  }, [applySession]);

  useEffect(() => {
    const client = getSupabaseClient();
    let cancelled = false;

    const guardedApply = (next: Session | null): void => {
      if (cancelled) return;
      applySession(next);
    };

    // Subscribed before the first read, so a change that lands between reading
    // the session and subscribing cannot be missed.
    const { data } = client.auth.onAuthStateChange((_event, nextSession) => {
      // Deliberately does nothing but set state. This callback runs while the
      // client holds an internal lock, and calling back into the client from
      // here — fetching the user, refreshing, signing out — deadlocks it. Work
      // that needs the client belongs in an effect or an action, not here.
      guardedApply(nextSession);
    });

    void client.auth
      .getSession()
      .then(({ data: result }) => guardedApply(result.session))
      .catch(() => {
        // A failure to read the persisted session is not a reason to trap the
        // user in a loading state. Treat it as no session; the next auth event
        // will correct it if one arrives.
        guardedApply(null);
      });

    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
    };
  }, [applySession]);

  const signOut = useCallback(async (): Promise<void> => {
    const result = await signOutAction();

    if (!result.ok) {
      // The revocation failed — most likely the token was already invalid, or
      // the network is down. The user asked to be signed out, so they are: the
      // local session is dropped and the provider will emit a SIGNED_OUT event
      // regardless. Reporting this as a failure would leave them staring at a
      // signed-in interface they explicitly dismissed.
      setSession(undefined);
      setStatus('anonymous');
    }
  }, []);

  const user = session?.user;

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, signOut, refresh }),
    [status, user, signOut, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
