/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddressChip } from './ui';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TEST_ADDRESS = 'CCC7KAX4V4GJD6FVG6GSYQ4I2D2B3CWEOQMIX6YM4QBGXTA6INCGRUYC';

describe('AddressChip accessibility and copy affordance', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('exposes the full 56-character address once to assistive tech via visually-hidden text', () => {
    act(() => {
      root.render(<AddressChip value={TEST_ADDRESS} />);
    });

    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    // Redundant aria-label is removed to avoid announcing the address twice
    expect(code?.hasAttribute('aria-label')).toBe(false);
    expect(code?.querySelectorAll('.sr-only')).toHaveLength(1);
    expect(code?.querySelector('.sr-only')?.textContent).toBe(TEST_ADDRESS);

    // Visually-hidden text contains full address for screen readers
    const srOnly = container.querySelector('.sr-only');
    expect(srOnly?.textContent).toBe(TEST_ADDRESS);

    // Truncated presentation is aria-hidden
    const truncated = container.querySelector('[aria-hidden="true"]');
    expect(truncated?.textContent).toContain('…');
  });

  it('provides a copy-to-clipboard affordance that copies the full address', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });

    act(() => {
      root.render(<AddressChip value={TEST_ADDRESS} />);
    });

    const copyBtn = container.querySelector('button');
    expect(copyBtn).not.toBeNull();
    expect(copyBtn?.getAttribute('aria-label')).toMatch(/copy/i);

    await act(async () => {
      copyBtn?.click();
    });

    expect(writeText).toHaveBeenCalledWith(TEST_ADDRESS);
    expect(copyBtn?.getAttribute('aria-label')).toMatch(/copied/i);
  });

  it('handles clipboard failure gracefully without throwing unhandled exceptions', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Permission denied'));
    Object.assign(navigator, {
      clipboard: { writeText },
    });

    act(() => {
      root.render(<AddressChip value={TEST_ADDRESS} />);
    });

    const copyBtn = container.querySelector('button');
    expect(copyBtn).not.toBeNull();

    await act(async () => {
      copyBtn?.click();
    });

    expect(writeText).toHaveBeenCalledWith(TEST_ADDRESS);
    // Button still exists and remains functional
    expect(copyBtn?.getAttribute('aria-label')).toMatch(/copy/i);
  });

  it('renders optional label alongside address chip', () => {
    act(() => {
      root.render(<AddressChip value={TEST_ADDRESS} label="Factory" />);
    });

    expect(container.textContent).toContain('Factory');
    const code = container.querySelector('code');
    expect(code?.hasAttribute('aria-label')).toBe(false);
    expect(code?.querySelector('.sr-only')?.textContent).toBe(TEST_ADDRESS);
  });
});
