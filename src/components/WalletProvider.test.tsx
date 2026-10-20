/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getConnectedAccount: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('@/lib/wallet', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/wallet')>();
  return {
    ...original,
    listAvailableWallets: vi.fn(async () => [
      {
        id: 'freighter',
        name: 'Freighter',
        isAvailable: vi.fn(async () => true),
        connect: mocks.connect,
        getConnectedAccount: mocks.getConnectedAccount,
        signTransaction: vi.fn(),
        signMessage: vi.fn(),
      },
    ]),
  };
});

import { useWallet } from '@/lib/wallet/context';
import { WalletProvider } from './WalletProvider';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function CurrentAddress() {
  const { address, status } = useWallet();
  return <output data-status={status}>{address ?? 'none'}</output>;
}

describe('WalletProvider account refresh', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.getConnectedAccount.mockReset().mockResolvedValue({ address: 'GOLD' });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('re-reads the authorized account when the window regains focus', async () => {
    await act(async () => {
      root.render(
        <WalletProvider>
          <CurrentAddress />
        </WalletProvider>,
      );
    });

    expect(container.querySelector('output')?.textContent).toBe('GOLD');

    mocks.getConnectedAccount.mockResolvedValue({ address: 'GNEW' });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(container.querySelector('output')?.textContent).toBe('GNEW');
    expect(container.querySelector('output')?.dataset.status).toBe('connected');
  });

  it('disconnects the stale account when Freighter no longer returns one', async () => {
    await act(async () => {
      root.render(
        <WalletProvider>
          <CurrentAddress />
        </WalletProvider>,
      );
    });

    mocks.getConnectedAccount.mockResolvedValue(null);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(container.querySelector('output')?.textContent).toBe('none');
    expect(container.querySelector('output')?.dataset.status).toBe('disconnected');
  });

  it('guards connect against concurrent invocations and reuses the existing in-flight promise', async () => {
    let resolveConnect!: (val: { address: string }) => void;
    mocks.connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveConnect = resolve;
        }),
    );
    mocks.getConnectedAccount.mockResolvedValue(null);

    function ConnectAction() {
      const { connect, address, status } = useWallet();
      return (
        <div>
          <button type="button" onClick={() => void connect()}>
            Connect
          </button>
          <output data-status={status}>{address ?? 'none'}</output>
        </div>
      );
    }

    await act(async () => {
      root.render(
        <WalletProvider>
          <ConnectAction />
        </WalletProvider>,
      );
    });

    const button = container.querySelector('button')!;

    // Rapid concurrent clicks
    act(() => {
      button.click();
      button.click();
    });

    // Exactly one prompt/connect was triggered
    expect(mocks.connect).toHaveBeenCalledTimes(1);

    // Resolve deferred connect
    await act(async () => {
      resolveConnect({ address: 'GCONCURRENT' });
    });

    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(container.querySelector('output')?.textContent).toBe('GCONCURRENT');
    expect(container.querySelector('output')?.dataset.status).toBe('connected');
  });

  it('allows connecting again after an earlier failure settles', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('User declined'));
    mocks.getConnectedAccount.mockResolvedValue(null);

    function ConnectAction() {
      const { connect, address, status } = useWallet();
      return (
        <div>
          <button type="button" onClick={() => void connect()}>
            Connect
          </button>
          <output data-status={status}>{address ?? 'none'}</output>
        </div>
      );
    }

    await act(async () => {
      root.render(
        <WalletProvider>
          <ConnectAction />
        </WalletProvider>,
      );
    });

    const button = container.querySelector('button')!;

    await act(async () => {
      button.click();
    });

    expect(container.querySelector('output')?.dataset.status).toBe('disconnected');

    // Second connect attempt succeeds
    mocks.connect.mockResolvedValueOnce({ address: 'GSUCCESS' });
    await act(async () => {
      button.click();
    });

    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(container.querySelector('output')?.textContent).toBe('GSUCCESS');
    expect(container.querySelector('output')?.dataset.status).toBe('connected');
  });
});
