import { z } from 'zod';

/**
 * Runtime validation for frontend environment configuration.
 *
 * The frontend is a public client: only browser-safe values may appear here.
 * Service-role keys, secret keys, database passwords, and private keys must never
 * be exposed to the browser, and this module actively refuses to start if it
 * detects an elevated credential.
 */

export const stellarNetworkSchema = z.enum(['local', 'testnet', 'mainnet']);

/** Stellar contract addresses are `C` followed by 55 base32 characters. */
const contractIdSchema = z.union([z.string().regex(/^C[A-Z2-7]{55}$/), z.literal('')]);

/** Environment variable names that must never be present in a browser bundle. */
export const FORBIDDEN_ENV_KEYS = [
  'VITE_SUPABASE_SERVICE_ROLE_KEY',
  'VITE_SUPABASE_SECRET_KEY',
  'VITE_DATABASE_URL',
  'VITE_SUPABASE_DB_PASSWORD',
  'VITE_WALLET_NONCE_SECRET',
  'VITE_S3_SECRET_ACCESS_KEY',
  'SERVICE_ROLE_KEY',
] as const;

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

/**
 * URLs that carry the session, the anon key, access tokens or signed transaction
 * submissions may not travel in plaintext in production. A production build requires `https:`;
 * local development may still use `http:` for localhost.
 */
function secureUrl() {
  return z
    .string()
    .url()
    .refine(
      (value) => {
        try {
          const url = new URL(value);
          if (url.protocol === 'https:') return true;
          if (import.meta.env.PROD) return false;
          return url.protocol === 'http:' && isLoopbackHost(url.hostname);
        } catch {
          return false;
        }
      },
      {
        message: 'must use https in production (http only permitted for localhost in development)',
      },
    );
}

export const envSchema = z.object({
  VITE_APP_URL: secureUrl(),
  VITE_SUPABASE_URL: secureUrl(),
  VITE_SUPABASE_ANON_KEY: z.string().min(1),
  VITE_STELLAR_NETWORK: stellarNetworkSchema,
  VITE_STELLAR_RPC_URL: secureUrl(),
  VITE_FACTORY_CONTRACT_ID: contractIdSchema,
  VITE_USDC_CONTRACT_ID: contractIdSchema,
  VITE_EXPLORER_BASE_URL: z.string().url(),
  /**
   * The application API. Optional, because the app still reads group state
   * directly from the chain and works without a backend — only invite codes and
   * notifications need one, and those screens say so rather than failing
   * obscurely when it is absent.
   */
  VITE_API_BASE_URL: secureUrl().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Decodes a JWT payload for inspection only. This performs no signature
 * verification and is never used for an authorization decision — it exists
 * solely to detect a misconfigured, over-privileged key.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  const payload = parts[1];
  if (parts.length !== 3 || !payload) return undefined;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function assertNoElevatedCredentials(raw: Record<string, unknown>): void {
  for (const key of FORBIDDEN_ENV_KEYS) {
    const value = raw[key];
    if (typeof value === 'string' && value.length > 0) {
      throw new Error(
        `Refusing to start: ${key} is a server-side credential and must never be exposed to the browser.`,
      );
    }
  }

  const anonKey = raw['VITE_SUPABASE_ANON_KEY'];
  if (typeof anonKey === 'string' && anonKey.length > 0) {
    const claims = decodeJwtPayload(anonKey);
    if (claims?.['role'] === 'service_role') {
      throw new Error(
        'Refusing to start: VITE_SUPABASE_ANON_KEY contains a service_role token. ' +
          'The frontend may only use the publishable/anon key.',
      );
    }
  }
}

/**
 * Validates raw environment values and returns typed config.
 *
 * Throws with a descriptive message when configuration is missing or when an
 * elevated credential is detected.
 */
export function parseEnv(raw: Record<string, unknown>): Env {
  assertNoElevatedCredentials(raw);

  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid frontend environment configuration — ${issues}`);
  }

  return result.data;
}

let cachedEnv: Env | undefined;

/**
 * Returns validated environment configuration, parsing once on first use.
 *
 * Deliberately lazy so that builds and tests do not require a populated `.env`.
 */
export function getEnv(): Env {
  if (cachedEnv === undefined) {
    cachedEnv = parseEnv(import.meta.env as unknown as Record<string, unknown>);
  }
  return cachedEnv;
}
