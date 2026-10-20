import { afterEach, describe, expect, it, vi } from 'vitest';

const uploadMock = vi.fn();
const removeMock = vi.fn();
const signMock = vi.fn();
const fromMock = vi.fn(() => ({
  upload: uploadMock,
  remove: removeMock,
  createSignedUrl: signMock,
}));

vi.mock('../supabase', () => ({
  getSupabaseClient: () => ({ storage: { from: fromMock } }),
}));

const {
  AVATAR_BUCKET,
  AVATAR_MAX_EDGE,
  AVATAR_MAX_STORED_BYTES,
  avatarObjectKey,
  avatarPathKind,
  avatarProblemMessage,
  avatarSignedUrl,
  isAvatarPathFor,
  prepareAvatar,
  randomHex,
  removeAvatar,
  replaceAvatar,
  sniffImageKind,
  uploadAvatar,
} = await import('./avatar');

const USER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

const MAGIC = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpg: [0xff, 0xd8, 0xff, 0xe0],
  webp: [0x52, 0x49, 0x46, 0x46, 0x2c, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50],
};

function bytes(prefix: readonly number[], extra = 64): Uint8Array<ArrayBuffer> {
  const all = new Uint8Array(prefix.length + extra);
  all.set(prefix, 0);
  return all;
}

function imageBlob(kind: 'png' | 'jpg' | 'webp', size = 0): Blob {
  const head = bytes(MAGIC[kind]);
  return new Blob([head, new Uint8Array(Math.max(0, size - head.length))]);
}

/** Stubs the two DOM APIs that re-encoding needs. */
function stubDom(
  options: { encoded?: Blob | null; context?: boolean; dims?: [number, number] } = {},
) {
  const [width, height] = options.dims ?? [1000, 800];
  const close = vi.fn();
  const drawImage = vi.fn();

  const canvas = {
    width: 0,
    height: 0,
    getContext: () => (options.context === false ? null : { drawImage }),
    toBlob: (callback: (blob: Blob | null) => void) =>
      callback(options.encoded === undefined ? imageBlob('webp') : options.encoded),
  };

  const createImageBitmap = vi.fn(async () => ({ width, height, close }));
  vi.stubGlobal('createImageBitmap', createImageBitmap);
  vi.stubGlobal('document', { createElement: () => canvas });

  return { canvas, close, drawImage, createImageBitmap };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('sniffImageKind', () => {
  it('recognises the three accepted formats', () => {
    expect(sniffImageKind(bytes(MAGIC.png))).toBe('png');
    expect(sniffImageKind(bytes(MAGIC.jpg))).toBe('jpg');
    expect(sniffImageKind(bytes(MAGIC.webp))).toBe('webp');
  });

  it('refuses anything else, including a declared type that lies', () => {
    expect(sniffImageKind(bytes([0x47, 0x49, 0x46, 0x38]))).toBeUndefined(); // GIF
    expect(sniffImageKind(bytes([0x25, 0x50, 0x44, 0x46]))).toBeUndefined(); // PDF
    expect(sniffImageKind(new Uint8Array(0))).toBeUndefined();
    // A truncated signature is not a signature.
    expect(sniffImageKind(bytes(MAGIC.png.slice(0, 7), 0))).toBeUndefined();
    expect(sniffImageKind(bytes(MAGIC.jpg.slice(0, 2), 0))).toBeUndefined();
    expect(sniffImageKind(bytes(MAGIC.webp.slice(0, 11), 0))).toBeUndefined();
  });

  it('does not accept a RIFF container that is not WebP', () => {
    const wav = [...MAGIC.webp.slice(0, 8), 0x57, 0x41, 0x56, 0x45];
    expect(sniffImageKind(bytes(wav))).toBeUndefined();
  });
});

describe('the object key', () => {
  it('has exactly the shape the database column allows', () => {
    const key = avatarObjectKey(USER, 'webp', randomHex());
    expect(isAvatarPathFor(key, USER)).toBe(true);
    // The same expression as the CHECK constraint in the migration.
    expect(key).toMatch(new RegExp(`^users/${USER}/avatar/[0-9a-f]{32}\\.webp$`));
  });

  it('is not valid for any other user', () => {
    const key = avatarObjectKey(USER, 'png', randomHex());
    expect(isAvatarPathFor(key, OTHER)).toBe(false);
  });

  it('treats every regex metacharacter in the user id literally', () => {
    const userId = 'user.+*?^${}()|[]\\';
    const key = avatarObjectKey(userId, 'png', 'a'.repeat(32));
    expect(isAvatarPathFor(key, userId)).toBe(true);
    expect(isAvatarPathFor(key, `${userId}other`)).toBe(false);
  });

  it('does not treat a dot in the user id as a wildcard', () => {
    const name = 'a'.repeat(32);
    expect(isAvatarPathFor(avatarObjectKey('team.member', 'png', name), 'team.member')).toBe(true);
    expect(isAvatarPathFor(avatarObjectKey('teamXmember', 'png', name), 'team.member')).toBe(false);
  });

  it('does not treat a character class or quantifier as part of the user id pattern', () => {
    const name = 'a'.repeat(32);
    const userId = 'team[0-9]+';
    expect(isAvatarPathFor(avatarObjectKey(userId, 'webp', name), userId)).toBe(true);
    expect(isAvatarPathFor(avatarObjectKey('team123', 'webp', name), userId)).toBe(false);
  });

  it('keeps the whole avatar path constrained when the user id contains alternation', () => {
    const name = 'a'.repeat(32);
    const userId = 'alice|bob';
    const key = avatarObjectKey(userId, 'png', name);
    expect(isAvatarPathFor(key, userId)).toBe(true);
    expect(isAvatarPathFor('users/alice', userId)).toBe(false);
    expect(isAvatarPathFor(`bob/avatar/${name}.png`, userId)).toBe(false);
    expect(isAvatarPathFor(`${key}/extra`, userId)).toBe(false);
  });

  it.each(['png', 'jpg', 'jpeg', 'webp'])(
    'continues accepting existing avatar paths with the %s extension',
    (extension) => {
      expect(isAvatarPathFor(`users/${USER}/avatar/${'a'.repeat(32)}.${extension}`, USER)).toBe(
        true,
      );
    },
  );

  it('refuses names that were not generated, other prefixes, and traversal', () => {
    expect(isAvatarPathFor(`users/${USER}/avatar/photo.png`, USER)).toBe(false);
    expect(isAvatarPathFor(`users/${OTHER}/avatar/${randomHex()}.png`, USER)).toBe(false);
    expect(
      isAvatarPathFor(`users/${USER}/avatar/../../${OTHER}/avatar/${randomHex()}.png`, USER),
    ).toBe(false);
    expect(isAvatarPathFor(`https://example.com/photo.png`, USER)).toBe(false);
    // Uppercase hex is not what the generator produces and not what the column
    // accepts, so it must not be treated as acceptable here either.
    expect(isAvatarPathFor(`users/${USER}/avatar/${randomHex().toUpperCase()}.png`, USER)).toBe(
      false,
    );
  });

  it('reads the format back off the extension', () => {
    expect(avatarPathKind(`users/${USER}/avatar/${randomHex()}.png`)).toBe('png');
    expect(avatarPathKind(`users/${USER}/avatar/${randomHex()}.jpeg`)).toBe('jpg');
    expect(avatarPathKind(`users/${USER}/avatar/${randomHex()}.webp`)).toBe('webp');
    expect(avatarPathKind('nothing.png')).toBe('png');
    expect(avatarPathKind('no-extension')).toBeUndefined();
  });
});

describe('randomHex', () => {
  it('is the length the column requires, and lowercase hex', () => {
    expect(randomHex()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('does not repeat', () => {
    const names = new Set(Array.from({ length: 200 }, () => randomHex()));
    expect(names.size).toBe(200);
  });
});

describe('prepareAvatar', () => {
  it('refuses an empty file', async () => {
    const result = await prepareAvatar(new Blob([]));
    expect(result).toEqual({ ok: false, problem: 'empty' });
  });

  it('refuses a file larger than this app will decode', async () => {
    const big = new Blob([bytes(MAGIC.png), new Uint8Array(12 * 1024 * 1024)]);
    const result = await prepareAvatar(big);
    expect(result).toEqual({ ok: false, problem: 'too-large' });
  });

  it('refuses bytes that are not an image, before decoding anything', async () => {
    const dom = stubDom();
    const result = await prepareAvatar(new Blob([bytes([0x25, 0x50, 0x44, 0x46])]));

    expect(result).toEqual({ ok: false, problem: 'unsupported' });
    expect(dom.createImageBitmap).not.toHaveBeenCalled();
  });

  it('re-encodes to WebP and names the object from what was produced', async () => {
    stubDom();
    const result = await prepareAvatar(imageBlob('png'));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe('webp');
  });

  it('believes the produced bytes when the browser cannot encode WebP', async () => {
    // Safari historically answered a WebP request with a PNG. Naming the object
    // from the requested type rather than the produced one would store a file
    // whose extension lies about it, and the bucket's MIME allow-list would then
    // disagree with the name.
    stubDom({ encoded: imageBlob('png') });

    const result = await prepareAvatar(imageBlob('png'));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe('png');
  });

  it('refuses an image the browser cannot decode', async () => {
    stubDom();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('not an image');
      }),
    );

    expect(await prepareAvatar(imageBlob('png'))).toEqual({ ok: false, problem: 'unreadable' });
  });

  it('refuses an image with no area', async () => {
    stubDom({ dims: [0, 0] });
    expect(await prepareAvatar(imageBlob('png'))).toEqual({ ok: false, problem: 'unreadable' });
  });

  it('refuses when the canvas has no 2D context', async () => {
    stubDom({ context: false });
    expect(await prepareAvatar(imageBlob('png'))).toEqual({ ok: false, problem: 'encode-failed' });
  });

  it('refuses when the encoder produces nothing', async () => {
    stubDom({ encoded: null });
    expect(await prepareAvatar(imageBlob('png'))).toEqual({ ok: false, problem: 'encode-failed' });
  });

  it('refuses when the encoder produces something that is not an image', async () => {
    stubDom({ encoded: new Blob([bytes([0x00, 0x01, 0x02, 0x03])]) });
    expect(await prepareAvatar(imageBlob('png'))).toEqual({ ok: false, problem: 'encode-failed' });
  });

  it('scales down to the longest edge an avatar is displayed at', async () => {
    const dom = stubDom({ dims: [4000, 3000] });
    const result = await prepareAvatar(imageBlob('png'));

    expect(result.ok).toBe(true);
    expect(dom.canvas.width).toBe(AVATAR_MAX_EDGE);
    expect(dom.canvas.height).toBe(Math.round(3000 * (AVATAR_MAX_EDGE / 4000)));
    expect(dom.drawImage).toHaveBeenCalledWith(
      expect.anything(),
      0,
      0,
      dom.canvas.width,
      dom.canvas.height,
    );
    // The decoded frame is released rather than left for the collector.
    expect(dom.close).toHaveBeenCalled();
  });

  it('leaves an image that is already small enough alone', async () => {
    const dom = stubDom({ dims: [120, 120] });
    await prepareAvatar(imageBlob('png'));

    expect(dom.canvas.width).toBe(120);
    expect(dom.canvas.height).toBe(120);
  });

  it('refuses an encoded image that the bucket would refuse', async () => {
    const tooBig = new Blob([bytes(MAGIC.webp), new Uint8Array(AVATAR_MAX_STORED_BYTES)]);
    stubDom({ encoded: tooBig });

    expect(await prepareAvatar(imageBlob('png'))).toEqual({ ok: false, problem: 'too-large' });
  });
});

describe('uploadAvatar', () => {
  it('stores under the caller’s own prefix, in the profile bucket, without upsert', async () => {
    stubDom();
    uploadMock.mockResolvedValue({ error: null });

    const result = await uploadAvatar(USER, imageBlob('png'));

    expect(fromMock).toHaveBeenCalledWith(AVATAR_BUCKET);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(isAvatarPathFor(result.value.path, USER)).toBe(true);
    expect(uploadMock).toHaveBeenCalledTimes(1);

    const [path, , options] = uploadMock.mock.calls[0] as [string, Blob, Record<string, unknown>];
    expect(path).toBe(result.value.path);
    expect(options['contentType']).toBe('image/webp');
    // The name is random, so a collision would mean the randomness is broken
    // rather than that a replacement was intended.
    expect(options['upsert']).toBe(false);
  });

  it('reports a storage failure as a value rather than throwing', async () => {
    stubDom();
    uploadMock.mockResolvedValue({ error: { message: 'policy denied' } });

    expect(await uploadAvatar(USER, imageBlob('png'))).toEqual({
      ok: false,
      problem: 'upload-failed',
    });
  });

  it('does not reach storage for a file that could not be prepared', async () => {
    uploadMock.mockResolvedValue({ error: null });

    const result = await uploadAvatar(USER, new Blob([bytes([0x47, 0x49, 0x46])]));

    expect(result).toEqual({ ok: false, problem: 'unsupported' });
    expect(uploadMock).not.toHaveBeenCalled();
  });
});

describe('removeAvatar', () => {
  it('removes exactly the one object', async () => {
    removeMock.mockResolvedValue({ error: null });
    const path = `users/${USER}/avatar/${randomHex()}.webp`;

    expect(await removeAvatar(path)).toEqual({ ok: true, value: undefined });
    expect(fromMock).toHaveBeenCalledWith(AVATAR_BUCKET);
    expect(removeMock).toHaveBeenCalledWith([path]);
  });

  it('reports a failure as a value', async () => {
    removeMock.mockResolvedValue({ error: { message: 'denied' } });
    expect(await removeAvatar(`users/${USER}/avatar/${randomHex()}.webp`)).toEqual({
      ok: false,
      problem: 'remove-failed',
    });
  });

  it('does not ask storage to remove nothing', async () => {
    expect(await removeAvatar('')).toEqual({ ok: false, problem: 'remove-failed' });
    expect(removeMock).not.toHaveBeenCalled();
  });
});

describe('avatarSignedUrl', () => {
  it('returns the signed URL', async () => {
    signMock.mockResolvedValue({ data: { signedUrl: 'https://example.test/signed' }, error: null });

    const result = await avatarSignedUrl(`users/${USER}/avatar/${randomHex()}.webp`);

    expect(result).toEqual({ ok: true, value: 'https://example.test/signed' });
  });

  it('reports a denial as a value, because a missing photo is not a broken page', async () => {
    signMock.mockResolvedValue({ data: null, error: { message: 'denied' } });
    expect(await avatarSignedUrl(`users/${OTHER}/avatar/${randomHex()}.webp`)).toEqual({
      ok: false,
      problem: 'sign-failed',
    });
  });

  it('reports a response with no URL as a failure rather than an empty string', async () => {
    signMock.mockResolvedValue({ data: {}, error: null });
    expect(await avatarSignedUrl(`users/${USER}/avatar/${randomHex()}.webp`)).toEqual({
      ok: false,
      problem: 'sign-failed',
    });
  });
});

describe('avatarProblemMessage', () => {
  it('has a sentence for every problem, and none of them are empty', () => {
    const problems = [
      'empty',
      'too-large',
      'unsupported',
      'unreadable',
      'encode-failed',
      'upload-failed',
      'remove-failed',
      'sign-failed',
    ] as const;

    for (const problem of problems) {
      const message = avatarProblemMessage(problem);
      expect(message.length).toBeGreaterThan(0);
      expect(message.endsWith('.')).toBe(true);
    }
  });
});

describe('replaceAvatar', () => {
  const OLD_PATH = `users/${USER}/avatar/${'a'.repeat(32)}.webp`;

  async function replaceWith(
    write: (path: string) => Promise<unknown>,
    current: string | null = OLD_PATH,
  ) {
    stubDom();
    uploadMock.mockResolvedValue({ error: null });
    removeMock.mockResolvedValue({ error: null });
    return replaceAvatar(USER, imageBlob('png'), current, write);
  }

  it('on a failed write removes the just-uploaded object and rethrows', async () => {
    const writeError = new Error('PATCH /me failed');
    const write = vi.fn().mockRejectedValue(writeError);

    await expect(replaceWith(write)).rejects.toBe(writeError);

    // The new object is gone; the old one is untouched because the profile
    // still points at it.
    expect(removeMock).toHaveBeenCalledTimes(1);
    const [removed] = removeMock.mock.calls[0] as [string[]];
    expect(removed).toHaveLength(1);
    expect(removed[0]).not.toBe(OLD_PATH);
    expect(isAvatarPathFor(removed[0] as string, USER)).toBe(true);
  });

  it('on success removes the replaced object and returns the new path', async () => {
    const write = vi.fn().mockResolvedValue(undefined);

    const result = await replaceWith(write);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isAvatarPathFor(result.value.path, USER)).toBe(true);

    // Exactly one removal: the old photo. The new one stays.
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith([OLD_PATH]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toBe(result.value.path);
  });

  it('with no previous photo removes nothing on success', async () => {
    const write = vi.fn().mockResolvedValue(undefined);

    const result = await replaceWith(write, null);

    expect(result.ok).toBe(true);
    expect(removeMock).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('with empty string previous photo removes nothing on success', async () => {
    const write = vi.fn().mockResolvedValue(undefined);

    const result = await replaceWith(write, '');

    expect(result.ok).toBe(true);
    expect(removeMock).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('preserves the write error even if cleanup removal fails', async () => {
    const writeError = new Error('PATCH /me failed');
    const write = vi.fn().mockRejectedValue(writeError);

    stubDom();
    uploadMock.mockResolvedValue({ error: null });
    removeMock.mockRejectedValue(new Error('Storage S3 timeout'));

    await expect(replaceAvatar(USER, imageBlob('png'), OLD_PATH, write)).rejects.toBe(writeError);
    expect(removeMock).toHaveBeenCalledTimes(1);
  });

  it('reports an upload failure as a value without writing or removing', async () => {
    stubDom();
    uploadMock.mockResolvedValue({ error: { message: 'policy denied' } });
    const write = vi.fn();

    const result = await replaceAvatar(USER, imageBlob('png'), OLD_PATH, write);

    expect(result).toEqual({ ok: false, problem: 'upload-failed' });
    expect(write).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });
});
