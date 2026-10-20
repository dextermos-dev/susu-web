import {
  useId,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { buttonClasses, type ButtonVariant } from './button-styles';

/**
 * Minimal UI primitives.
 *
 * Deliberately plain: no component here knows anything about money, groups or
 * chain state. States that matter — a pending transaction, an unknown outcome,
 * a waiting round — are rendered by the components that own that meaning, not
 * inferred from a colour prop.
 */

export type { ButtonVariant };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  /** Shows progress and blocks further clicks. */
  readonly pending?: boolean;
}

export function Button({
  variant = 'primary',
  pending = false,
  disabled,
  children,
  className = '',
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      // A pending action is disabled so a transaction cannot be submitted twice
      // by an impatient second click.
      disabled={disabled === true || pending}
      aria-busy={pending}
      className={`${buttonClasses(variant)} ${className}`}
      {...rest}
    >
      {pending ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Spinner() {
  return (
    <span
      role="status"
      aria-label="Working"
      className="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border border-neutral-200 p-5 dark:border-neutral-800 ${className}`}
    >
      {children}
    </div>
  );
}

type NoticeTone = 'neutral' | 'warning' | 'danger' | 'success';

const NOTICE_STYLES: Record<NoticeTone, string> = {
  neutral: 'border-neutral-300 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400',
  warning:
    'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200',
  danger:
    'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200',
  success:
    'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
};

/**
 * An inline message.
 *
 * `role` is set to `alert` only for a danger tone, so that a status the user
 * should not be interrupted by — a round still waiting, say — is not announced
 * as though something had gone wrong.
 */
export function Notice({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: NoticeTone;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={`rounded-lg border px-4 py-3 text-sm ${NOTICE_STYLES[tone]}`}
    >
      {title === undefined ? null : <p className="font-medium">{title}</p>}
      {children === undefined ? null : (
        <div className={title === undefined ? '' : 'mt-1'}>{children}</div>
      )}
    </div>
  );
}

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | undefined;
}

export function Field({
  label,
  hint,
  error,
  id,
  className = '',
  'aria-describedby': describedBy,
  ...rest
}: FieldProps) {
  const generatedId = useId();
  const fieldId = id ?? rest.name ?? generatedId;
  const descriptionIds = [
    describedBy,
    hint === undefined ? undefined : `${fieldId}-hint`,
    error === undefined ? undefined : `${fieldId}-error`,
  ]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(' ');
  return (
    <div className={className}>
      <label htmlFor={fieldId} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={fieldId}
        aria-invalid={error !== undefined}
        aria-describedby={descriptionIds.length === 0 ? undefined : descriptionIds}
        className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-900 focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 dark:border-neutral-700 dark:focus:border-neutral-100 dark:focus-visible:ring-neutral-100 dark:focus-visible:ring-offset-neutral-950"
        {...rest}
      />
      {hint === undefined ? null : (
        <p id={`${fieldId}-hint`} className="mt-1 text-xs text-neutral-500">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={`${fieldId}-error`} className="mt-1 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

export interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly label: string;
  readonly hint?: string;
}

export function SelectField({
  label,
  hint,
  id,
  children,
  className = '',
  ...rest
}: SelectFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? rest.name ?? generatedId;
  return (
    <div className={className}>
      <label htmlFor={fieldId} className="block text-sm font-medium">
        {label}
      </label>
      <select
        id={fieldId}
        aria-describedby={hint === undefined ? undefined : `${fieldId}-hint`}
        className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-neutral-100"
        {...rest}
      >
        {children}
      </select>
      {hint === undefined ? null : (
        <p id={`${fieldId}-hint`} className="mt-1 text-xs text-neutral-500">
          {hint}
        </p>
      )}
    </div>
  );
}

/** A short, monospaced rendering of an on-chain address with copy affordance and accessible name. */
export function AddressChip({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      // Clipboard access can be withheld or unavailable in non-secure origins.
      setCopied(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      {label === undefined ? null : <span className="text-xs text-neutral-500">{label}</span>}
      <code
        title={value}
        className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs dark:bg-neutral-800"
      >
        <span className="sr-only">{value}</span>
        <span aria-hidden="true">
          {value.slice(0, 6)}…{value.slice(-4)}
        </span>
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? 'Copied address to clipboard' : 'Copy address to clipboard'}
        title={copied ? 'Copied' : 'Copy address'}
        className="inline-flex items-center justify-center rounded p-1 text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </span>
  );
}

function CopyIcon() {
  return (
    <svg
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      className="size-3.5 text-emerald-600 dark:text-emerald-400"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description === undefined ? null : (
          <div className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">{description}</div>
        )}
      </div>
      {actions === undefined ? null : <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Page({ children }: { children: ReactNode }) {
  // Narrower gutters on a phone: 24px each side of a 375px screen is a tenth of
  // the width spent on margin. The vertical padding follows for the same reason
  // — a small screen wants content, not air.
  return <section className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">{children}</section>;
}
