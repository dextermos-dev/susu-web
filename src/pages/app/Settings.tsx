import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useDeleteAccount, useLinkWallet, useMe, useUpdateProfile } from '@/lib/api/hooks';
import { apiErrorMessage } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/context';
import { signOutOtherSessions, updatePassword } from '@/lib/auth/actions';
import { resetPasswordSchema, validate } from '@/lib/auth/validation';
import { useStellar } from '@/lib/stellar/hooks';
import {
  avatarProblemMessage,
  avatarSignedUrl,
  removeAvatar,
  replaceAvatar,
  type AvatarProblem,
} from '@/lib/storage/avatar';
import { useWallet } from '@/lib/wallet/context';
import type { Account } from '@/lib/api/me';
import {
  AddressChip,
  Button,
  Card,
  Field,
  Notice,
  Page,
  PageHeader,
  Spinner,
} from '@/components/ui';

/**
 * Settings.
 *
 * Four things that are all about the account rather than the protocol: who you
 * are, which wallet is proved to be yours, how you sign in, and how to leave.
 *
 * THE TWO IDENTITIES STAY SEPARATE
 * The account and the wallet are shown as two things, because they are. Linking
 * a wallet is a signed claim stored on the server; connecting one is a browser
 * session. A user may have either without the other, and only the linked one
 * decides which groups this account's activity is drawn from. Nothing on this
 * page moves money, and nothing here can: the photo is not financial, the wallet
 * link is a signature over text, and deleting the account does not reach the
 * chain.
 */
function ProfileSection({ account }: { account: Account }) {
  const updateProfile = useUpdateProfile();
  const fileInput = useRef<HTMLInputElement>(null);
  const [displayName, setDisplayName] = useState(account.displayName ?? '');
  // Both the URL and the failure are kept *with the path they belong to*, and the
  // one that is shown is the one whose path is still the stored one. That is what
  // makes a replaced photo replace itself: nothing has to be cleared when the path
  // changes, so there is no render in which the old photo is still on screen.
  const [signedPhoto, setSignedPhoto] = useState<{ path: string; url: string } | undefined>(
    undefined,
  );
  const [signFailure, setSignFailure] = useState<
    { path: string; problem: AvatarProblem } | undefined
  >(undefined);
  const [photoProblem, setPhotoProblem] = useState<AvatarProblem | undefined>(undefined);
  const [photoPending, setPhotoPending] = useState(false);

  const avatarPath = account.avatarPath;

  // The bucket is private and its read policy is owner-only, so a photo is shown
  // through a short-lived signed URL rather than a public one.
  useEffect(() => {
    if (avatarPath === null) return;
    let cancelled = false;

    void avatarSignedUrl(avatarPath).then((result) => {
      if (cancelled) return;
      if (result.ok) setSignedPhoto({ path: avatarPath, url: result.value });
      else setSignFailure({ path: avatarPath, problem: result.problem });
    });

    return () => {
      cancelled = true;
    };
  }, [avatarPath]);

  const photoUrl =
    signedPhoto !== undefined && signedPhoto.path === avatarPath ? signedPhoto.url : undefined;
  const problem =
    photoProblem ??
    (signFailure !== undefined && signFailure.path === avatarPath
      ? signFailure.problem
      : undefined);

  async function onChoosePhoto(file: File): Promise<void> {
    setPhotoProblem(undefined);
    setSignFailure(undefined);
    setPhotoPending(true);

    try {
      const result = await replaceAvatar(account.userId, file, avatarPath, async (path) => {
        await updateProfile.mutateAsync({ avatarPath: path });
      });
      if (!result.ok) {
        setPhotoProblem(result.problem);
        return;
      }
    } catch {
      return;
    } finally {
      setPhotoPending(false);
      if (fileInput.current !== null) fileInput.current.value = '';
    }
  }

  async function onRemovePhoto(): Promise<void> {
    if (avatarPath === null) return;
    setPhotoProblem(undefined);
    setPhotoPending(true);

    // The reference is cleared first this time. The order is the reverse of the
    // upload because the failure that matters is the opposite one: a profile
    // pointing at an object that no longer exists would render as a broken image
    // on every screen, while an object nothing points at is invisible.
    try {
      await updateProfile.mutateAsync({ avatarPath: null });
    } catch {
      return;
    } finally {
      setPhotoPending(false);
    }

    await removeAvatar(avatarPath);
  }

  const nameChanged = displayName.trim() !== (account.displayName ?? '');

  return (
    <Card>
      <h2 className="text-sm font-medium">Profile</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Shown to you in this app. A photo is optional and never required.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <div className="flex size-16 items-center justify-center overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
          {photoUrl === undefined ? (
            <span className="text-xs text-neutral-500">No photo</span>
          ) : (
            <img src={photoUrl} alt="" className="size-16 object-cover" />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            pending={photoPending}
            onClick={() => fileInput.current?.click()}
          >
            {avatarPath === null ? 'Add a photo' : 'Replace photo'}
          </Button>
          {avatarPath === null ? null : (
            <Button variant="ghost" pending={photoPending} onClick={() => void onRemovePhoto()}>
              Remove
            </Button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void onChoosePhoto(file);
            }}
          />
        </div>
      </div>

      {problem === undefined ? null : (
        <div className="mt-3">
          <Notice tone="warning" title="That photo was not saved">
            {avatarProblemMessage(problem)}
          </Notice>
        </div>
      )}

      <form
        className="mt-6 max-w-sm space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!nameChanged) return;
          const trimmed = displayName.trim();
          updateProfile.mutate({ displayName: trimmed === '' ? null : trimmed });
        }}
      >
        <Field
          label="Display name"
          value={displayName}
          maxLength={80}
          hint="Up to 80 characters. Leave it empty to remove it."
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <Button type="submit" pending={updateProfile.isPending} disabled={!nameChanged}>
          Save name
        </Button>
      </form>

      {updateProfile.isError ? (
        <div className="mt-3">
          <Notice tone="warning" title="Your profile was not saved">
            {apiErrorMessage(updateProfile.error)}
          </Notice>
        </div>
      ) : null}
    </Card>
  );
}

function WalletSection({ account }: { account: Account }) {
  const { status, address, wallet, connect, error } = useWallet();
  const { network } = useStellar();
  const link = useLinkWallet();

  async function onLink(): Promise<void> {
    // Connect first if this browser has not authorized the site. `connect` returns
    // the account, because the context's own `address` only updates on the next
    // render and the signature has to be requested in this gesture.
    const target = address ?? (await connect())?.address;
    if (target === undefined || wallet === undefined) return;

    link.mutate({
      address: target,
      signMessage: async (message) => {
        const signed = await wallet.signMessage(message, {
          networkPassphrase: network.passphrase,
          address: target,
        });
        return signed.signature;
      },
    });
  }

  return (
    <Card>
      <h2 className="text-sm font-medium">Wallet</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Proving a wallet is how this account is matched to on-chain activity. It involves no payment
        and no on-chain action — only a signature over a message.
      </p>

      {account.walletAddress === null ? (
        <div className="mt-4">
          <Button pending={link.isPending} onClick={() => void onLink()}>
            {status === 'connected' ? 'Link this wallet' : 'Connect and link a wallet'}
          </Button>
          {status === 'unavailable' ? (
            <p className="mt-2 text-xs text-neutral-500">
              No Stellar wallet was found in this browser. Freighter is the supported wallet.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <AddressChip value={account.walletAddress} />
          <span className="text-xs text-neutral-500">Linked</span>
        </div>
      )}

      {error === undefined ? null : (
        <p className="mt-3 text-xs text-neutral-500">{error.message}</p>
      )}

      {link.isError ? (
        <div className="mt-3">
          <Notice tone="warning" title="The wallet was not linked">
            {apiErrorMessage(link.error)}
          </Notice>
        </div>
      ) : null}
    </Card>
  );
}

function PasswordSection() {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const validation = validate(resetPasswordSchema, {
    password,
    confirmPassword: confirmation,
  });
  const passwordError = password === '' || validation.ok ? undefined : validation.errors.password;
  const confirmationError =
    confirmation === '' || validation.ok ? undefined : validation.errors.confirmPassword;
  const canSubmit = validation.ok && !pending;

  async function onSubmit(): Promise<void> {
    setProblem(undefined);
    setDone(false);
    setPending(true);

    try {
      const result = await updatePassword(password);
      if (!result.ok) {
        setProblem(result.error.message);
        return;
      }

      // Other sessions are ended afterwards, and deliberately not reported as a
      // failure: the password has changed, which is what the user asked for. A
      // password is usually changed because someone else may have access, and a
      // refresh token elsewhere survives the change — so this is the step that
      // actually removes them, and it is worth doing even if its result is not
      // shown.
      await signOutOtherSessions();

      setPassword('');
      setConfirmation('');
      setDone(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <h2 className="text-sm font-medium">Password</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Changing it also signs out every other session, which is what makes a reset useful when
        someone else may have had access.
      </p>

      <form
        className="mt-4 max-w-sm space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) void onSubmit();
        }}
      >
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          error={passwordError}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Field
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirmation}
          error={confirmationError}
          onChange={(event) => setConfirmation(event.target.value)}
        />
        <Button type="submit" pending={pending} disabled={!canSubmit}>
          Change password
        </Button>
      </form>

      {problem === undefined ? null : (
        <div className="mt-3">
          <Notice tone="warning" title="Your password was not changed">
            {problem}
          </Notice>
        </div>
      )}

      {done ? (
        <div className="mt-3">
          <Notice tone="success" title="Password changed">
            Other sessions were signed out.
          </Notice>
        </div>
      ) : null}
    </Card>
  );
}

function DangerSection() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const deleteAccount = useDeleteAccount();
  const [confirmation, setConfirmation] = useState('');
  const [leaving, setLeaving] = useState(false);

  // The same value the API requires. Typing it is a speed bump against the
  // accident, not a security control: the request is already authenticated as
  // the account being deleted.
  const canDelete = confirmation === 'DELETE' && !deleteAccount.isPending && !leaving;

  async function onDelete(): Promise<void> {
    if (!canDelete) return;
    setLeaving(true);

    try {
      await deleteAccount.mutateAsync();
    } catch {
      // The notice below reports it; the account is still there.
      setLeaving(false);
      return;
    }

    // The session is revoked after the account is gone. Clearing it first would
    // leave a failed deletion with no session to retry from.
    await signOut();
    void navigate('/', { replace: true });
  }

  return (
    <Card>
      <h2 className="text-sm font-medium">Delete account</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Removes this account, its profile and its photo, and the invitations it created. It does not
        touch the chain: contributions and payouts are recorded against a wallet and a contract, so
        closing an account cannot erase what it did.
      </p>

      <div className="mt-4 max-w-sm space-y-3">
        <Field
          label="Type DELETE to confirm"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
        <Button
          variant="danger"
          pending={deleteAccount.isPending || leaving}
          disabled={!canDelete}
          onClick={() => void onDelete()}
        >
          Delete my account
        </Button>
      </div>

      {deleteAccount.isError ? (
        <div className="mt-3">
          <Notice tone="danger" title="The account was not deleted">
            {apiErrorMessage(deleteAccount.error)}
          </Notice>
        </div>
      ) : null}
    </Card>
  );
}

export function Settings() {
  const account = useMe();

  return (
    <Page>
      <PageHeader
        title="Settings"
        description="Profile, wallet, sign-in and account deletion. Nothing here can move money."
      />

      {account.isPending ? (
        <p className="mt-8 flex items-center gap-2 text-sm text-neutral-500">
          <Spinner /> Reading your account…
        </p>
      ) : null}

      {account.isError ? (
        <div className="mt-8">
          <Notice tone="warning" title="Your account could not be read">
            {apiErrorMessage(account.error)}{' '}
            <Link to="/app" className="font-medium underline underline-offset-2">
              Back to the overview
            </Link>
          </Notice>
        </div>
      ) : null}

      {account.data === undefined ? null : (
        <div className="mt-8 space-y-6">
          <ProfileSection account={account.data} />
          <WalletSection account={account.data} />
          <PasswordSection />
          <DangerSection />
        </div>
      )}
    </Page>
  );
}
