import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';

const mocks = vi.hoisted(() => ({
  getEnv: vi.fn(),
  Server: vi.fn(function (url: string, options: { allowHttp: boolean }) {
    return { url, options };
  }),
  Contract: vi.fn(function (id: string) {
    return { id };
  }),
}));

vi.mock('../env', () => ({ getEnv: mocks.getEnv }));
vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const original = await importOriginal<typeof import('@stellar/stellar-sdk')>();
  return { ...original, rpc: { ...original.rpc, Server: mocks.Server }, Contract: mocks.Contract };
});

function env(overrides: Partial<Env> = {}): Env {
  return {
    VITE_APP_URL: 'http://localhost:5173',
    VITE_SUPABASE_URL: 'https://example.supabase.co',
    VITE_SUPABASE_ANON_KEY: 'test-publishable-key',
    VITE_STELLAR_NETWORK: 'testnet',
    VITE_STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
    VITE_FACTORY_CONTRACT_ID: '',
    VITE_USDC_CONTRACT_ID: '',
    VITE_EXPLORER_BASE_URL: 'https://stellar.expert/explorer/testnet',
    ...overrides,
  };
}

describe('Stellar client configuration and handles', () => {
  let client: typeof import('./client');

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getEnv.mockReturnValue(env());
    client = await import('./client');
  });

  it('does not read configuration or construct SDK objects at import time', () => {
    expect(mocks.getEnv).not.toHaveBeenCalled();
    expect(mocks.Server).not.toHaveBeenCalled();
    expect(mocks.Contract).not.toHaveBeenCalled();
  });

  it('resolves configuration once and reuses its identity until reset', () => {
    const first = client.getNetworkConfig();
    mocks.getEnv.mockReturnValue(env({ VITE_STELLAR_RPC_URL: 'https://other-testnet.example' }));
    expect(client.getNetworkConfig()).toBe(first);
    expect(client.getNetworkConfig().rpcUrl).toBe('https://soroban-testnet.stellar.org');
    expect(mocks.getEnv).toHaveBeenCalledTimes(1);
    expect(mocks.Server).not.toHaveBeenCalled();
  });

  it('constructs a single server and shares the cached configuration', () => {
    const config = client.getNetworkConfig();
    const first = client.getSorobanServer();
    expect(client.getSorobanServer()).toBe(first);
    expect(client.getNetworkConfig()).toBe(config);
    expect(mocks.getEnv).toHaveBeenCalledTimes(1);
    expect(mocks.Server).toHaveBeenCalledTimes(1);
    expect(mocks.Server).toHaveBeenCalledWith(config.rpcUrl, { allowHttp: false });
  });

  it.each([
    ['http://localhost:8000/soroban/rpc', true],
    ['https://rpc.example.com', false],
  ])('sets allowHttp from the RPC scheme for %s', (rpcUrl, allowHttp) => {
    mocks.getEnv.mockReturnValue(
      env({ VITE_STELLAR_RPC_URL: rpcUrl, VITE_STELLAR_RPC_IS_CUSTOM: 'true' }),
    );
    client.getSorobanServer();
    expect(mocks.Server).toHaveBeenCalledExactlyOnceWith(rpcUrl, { allowHttp });
  });

  it('reset discards both caches and rebuilds them from current configuration', () => {
    const firstConfig = client.getNetworkConfig();
    const firstServer = client.getSorobanServer();
    const nextRpc = 'http://localhost:8001/soroban/rpc';
    mocks.getEnv.mockReturnValue(env({ VITE_STELLAR_RPC_URL: nextRpc }));

    client.resetStellarClientForTests();

    expect(mocks.Server).toHaveBeenCalledTimes(1);
    expect(client.getNetworkConfig()).not.toBe(firstConfig);
    expect(client.getNetworkConfig().rpcUrl).toBe(nextRpc);
    expect(client.getSorobanServer()).not.toBe(firstServer);
    expect(mocks.getEnv).toHaveBeenCalledTimes(2);
    expect(mocks.Server).toHaveBeenCalledTimes(2);
    expect(mocks.Server).toHaveBeenLastCalledWith(nextRpc, { allowHttp: true });
  });

  it.each([
    ['getFactoryContract', 'VITE_FACTORY_CONTRACT_ID'],
    ['getUsdcContract', 'VITE_USDC_CONTRACT_ID'],
  ] as const)('%s rejects an absent contract before constructing a handle', (method, setting) => {
    expect(() => client[method]()).toThrow(
      `${setting} is not configured. Set it in your .env — see .env.example for the deployed Testnet addresses.`,
    );
    expect(mocks.Contract).not.toHaveBeenCalled();
    expect(mocks.Server).not.toHaveBeenCalled();
  });

  it('passes the correct configured addresses to each contract handle', () => {
    const factoryId = `C${'A'.repeat(55)}`;
    const usdcId = `C${'B'.repeat(55)}`;
    mocks.getEnv.mockReturnValue(
      env({ VITE_FACTORY_CONTRACT_ID: factoryId, VITE_USDC_CONTRACT_ID: usdcId }),
    );

    client.getFactoryContract();
    client.getUsdcContract();

    expect(client.getContractConfig()).toEqual({ factoryId, usdcId });
    expect(mocks.Contract).toHaveBeenNthCalledWith(1, factoryId);
    expect(mocks.Contract).toHaveBeenNthCalledWith(2, usdcId);
    expect(mocks.Server).not.toHaveBeenCalled();
  });
});
