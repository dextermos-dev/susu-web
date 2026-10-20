/**
 * Profile photos: what may be uploaded, where it goes, and how it is shown.
 *
 * THE SHAPE OF THIS FEATURE
 * The browser uploads and deletes directly against Supabase Storage, under
 * policies that allow a user to touch only their own `users/<uid>/avatar/`
 * prefix. The API never handles image bytes and never returns a URL: it stores
 * and validates an object *path*, which is what `PATCH /me` writes. So this
 * module is storage-side, and the only thing it tells the API is which key it
 * used.
 *
 * WHY THE FILES ARE RE-ENCODED
 * The bucket caps an object at 2 MiB, and a photo from a phone is routinely
 * larger than that, so uploading it unchanged would fail with an opaque storage
 * error on exactly the files users actually have. Re-encoding through a canvas
 * both resizes the image to something an avatar can use and drops the container's
 * metadata — EXIF, including location — which a re-encode cannot carry forward.
 * The cost is that the stored bytes are not the user's original file, which is
 * why `prepareAvatar` is explicit about producing them rather than uploading
 * directly.
 *
 * THE NAME IS GENERATED, AND THE PATH IS CONSTRAINED
 * The object name is 32 random hex characters, never anything the user chose. A
 * user-supplied name is where a second extension, a traversal, or an executable
 * MIME type comes from, and the database refuses the whole class:
 * `profiles.avatar_path` is checked against `users/<the row's own user_id>/avatar/<32 hex>.<ext>`.
 * `avatarObjectKey` below produces exactly that shape, and `isAvatarPathFor`
 * re-states it so the UI can tell a path it may render from one it may not.
 */
import { getSupabaseClient } from '../supabase';

/** The bucket the migration creates. Named here for the same reason it is named there. */
export const AVATAR_BUCKET = 'profile-images';

/**
 * What the bucket accepts, and therefore what this app may store.
 *
 * Mirrors `file_size_limit` in `drizzle/0004_profile_images.sql`. The API's CI
 * guard asserts the bucket's real limit, so a change there without a change here
 * fails a check rather than surfacing as a failed upload.
 */
export const AVATAR_MAX_STORED_BYTES = 2 * 1024 * 1024;

/**
 * The largest file this app will try to read.
 *
 * Larger than the stored limit on purpose: the file is decoded, shrunk and
 * re-encoded, so the input is allowed to be bigger than what results. 12 MiB
 * covers a modern phone photo with room to spare, and the ceiling matters because
 * the whole file is held in memory to decode it.
 */
export const AVATAR_MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/** The longest edge after resizing. An avatar is never displayed larger. */
export const AVATAR_MAX_EDGE = 512;

/** How long a signed URL is good for. Long enough to render, short enough to expire. */
export const AVATAR_SIGNED_URL_TTL_SECONDS = 60 * 60;

/** The encoded formats this app will accept and store. */
export type ImageKind = 'png' | 'jpg' | 'webp';

/**
 * The reason a photo could not be used, as a value.
 *
 * Modelled like `AuthOutcome`: the caller has to render something for every
 * outcome, and an exception forces a `try`/`catch` at each call site with a guess
 * about what went wrong.
 */
export type AvatarProblem =
  | 'empty'
  | 'too-large'
  | 'unsupported'
  | 'unreadable'
  | 'encode-failed'
  | 'upload-failed'
  | 'remove-failed'
  | 'sign-failed';

export type AvatarFailure = { readonly ok: false; readonly problem: AvatarProblem };
export type AvatarSuccess<T> = { readonly ok: true; readonly value: T };
export type AvatarOutcome<T> = AvatarSuccess<T> | AvatarFailure;

/** A sentence for a person. Kept here so the reasons have exactly one wording. */
export function avatarProblemMessage(problem: AvatarProblem): string {
  switch (problem) {
    case 'empty':
      return 'That file is empty.';
    case 'too-large':
      return `That image is too large. Choose one under ${Math.round(AVATAR_MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`;
    case 'unsupported':
      return 'That file is not a PNG, JPEG or WebP image.';
    case 'unreadable':
      return 'That image could not be read. It may be damaged or in a format this browser cannot decode.';
    case 'encode-failed':
      return 'That image could not be processed. Try a different file.';
    case 'upload-failed':
      return 'The photo could not be uploaded. Check your connection and try again.';
    case 'remove-failed':
      return 'The photo could not be removed. Try again.';
    case 'sign-failed':
      return 'The photo could not be displayed. Reload the page to try again.';
  }
}

const failure = (problem: AvatarProblem): AvatarFailure => ({ ok: false, problem });

/**
 * Identifies an image from its leading bytes.
 *
 * The declared MIME type and the file name are both attacker-controlled strings,
 * so neither decides what is stored. These are the same signatures Storage itself
 * checks, and the reason a `.png` that is really something else is refused before
 * anything is decoded.
 */
export function sniffImageKind(bytes: Uint8Array): ImageKind | undefined {
  if (bytes.length >= 8) {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (png.every((byte, index) => bytes[index] === byte)) return 'png';
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'jpg';

  // `RIFF....WEBP`: the four bytes after RIFF are a little-endian length, so only
  // the tag at 8..12 is checked.
  if (bytes.length >= 12) {
    const riff = [0x52, 0x49, 0x46, 0x46];
    const webp = [0x57, 0x45, 0x42, 0x50];
    if (riff.every((byte, index) => bytes[index] === byte)) {
      if (webp.every((byte, index) => bytes[8 + index] === byte)) return 'webp';
    }
  }

  return undefined;
}

/** Lowercase hex. `crypto` is the platform's CSPRNG, not `Math.random`. */
export function randomHex(byteCount = 16): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * The object key for a photo.
 *
 * The shape here is the one the database enforces, so a key this function
 * produced is one `PATCH /me` will accept. The user id appears because the
 * Storage policies match on it — ownership is read from the path — and the name
 * is random because nothing about it should be guessable or meaningful.
 */
export function avatarObjectKey(userId: string, kind: ImageKind, name: string): string {
  return `users/${userId}/avatar/${name}.${kind}`;
}

/**
 * Whether a stored path is one this user's photo could legitimately occupy.
 *
 * The same expression as `profiles_avatar_path_shape` in the migration. It exists
 * so the UI can decide whether to render a path without asking Storage and
 * getting a denial, and so a mismatch between the two rules shows up in a test
 * rather than as a broken profile.
 */
export function isAvatarPathFor(path: string, userId: string): boolean {
  const escapedUserId = userId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^users/${escapedUserId}/avatar/[0-9a-f]{32}\\.(png|jpe?g|webp)$`).test(path);
}

/** The kind an object path names, from its extension. */
export function avatarPathKind(path: string): ImageKind | undefined {
  const match = /\.(png|jpe?g|webp)$/.exec(path);
  if (match === null) return undefined;
  const extension = match[1];
  if (extension === 'png') return 'png';
  if (extension === 'webp') return 'webp';
  return 'jpg';
}

/**
 * Redraws an image at avatar size and re-encodes it.
 *
 * Decoding is also the validation: `createImageBitmap` rejects bytes that are not
 * an image this browser can read, which is a stronger statement than any header
 * check could make. The output format is asked for as WebP and then *detected*
 * from the result, because a browser that cannot encode WebP silently falls back
 * (Safari historically produced PNG), and naming the object from what was
 * requested rather than from what was produced would store a file whose extension
 * lies about it.
 */
async function reencode(blob: Blob): Promise<AvatarOutcome<{ blob: Blob; kind: ImageKind }>> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return failure('unreadable');
  }

  try {
    const longestEdge = Math.max(bitmap.width, bitmap.height);
    if (longestEdge === 0) return failure('unreadable');

    const scale = Math.min(1, AVATAR_MAX_EDGE / longestEdge);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    if (context === null) return failure('encode-failed');

    // A transparent PNG keeps its transparency only if the canvas starts empty,
    // which it does — no background fill here on purpose.
    context.drawImage(bitmap, 0, 0, width, height);

    const encoded = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/webp', 0.9);
    });
    if (encoded === null) return failure('encode-failed');

    const head = new Uint8Array(await encoded.slice(0, 12).arrayBuffer());
    const kind = sniffImageKind(head);
    if (kind === undefined) return failure('encode-failed');

    return { ok: true, value: { blob: encoded, kind } };
  } finally {
    // Frees the decoded frame rather than leaving it to the collector.
    bitmap.close();
  }
}

/**
 * Turns a chosen file into the bytes that will be stored.
 *
 * Separated from the upload so a caller can show the result before storing it,
 * and so the whole pipeline is testable without a network or a bucket.
 */
export async function prepareAvatar(
  file: Blob,
): Promise<AvatarOutcome<{ blob: Blob; kind: ImageKind }>> {
  if (file.size === 0) return failure('empty');
  if (file.size > AVATAR_MAX_UPLOAD_BYTES) return failure('too-large');

  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (sniffImageKind(head) === undefined) return failure('unsupported');

  const encoded = await reencode(file);
  if (!encoded.ok) return encoded;

  if (encoded.value.blob.size > AVATAR_MAX_STORED_BYTES) return failure('too-large');

  return encoded;
}

/**
 * Stores a photo and returns the object key it was stored under.
 *
 * The key is not returned to be shown: it is what `PATCH /me` stores, and the
 * photo is rendered from a signed URL derived from it.
 *
 * A caller that replaces an existing photo owns the consequence: this does not
 * remove the old object, because a failure between here and the API write would
 * leave the account pointing at an object that no longer exists. The order that
 * avoids that is: upload, write the path, then remove the object that was
 * replaced; and if the write fails, remove what was just uploaded.
 */
export async function uploadAvatar(
  userId: string,
  file: Blob,
): Promise<AvatarOutcome<{ path: string; kind: ImageKind }>> {
  const prepared = await prepareAvatar(file);
  if (!prepared.ok) return prepared;

  const { blob, kind } = prepared.value;
  const path = avatarObjectKey(userId, kind, randomHex());

  const { error } = await getSupabaseClient()
    .storage.from(AVATAR_BUCKET)
    .upload(path, blob, {
      contentType: kind === 'jpg' ? 'image/jpeg' : `image/${kind}`,
      // Never `upsert`: the name is random, so a collision would mean something is
      // wrong with the randomness rather than that a replacement was intended.
      upsert: false,
    });

  if (error !== null) return failure('upload-failed');

  return { ok: true, value: { path, kind } };
}

/** Removes one object. Used when replacing a photo and when clearing it. */
export async function removeAvatar(path: string): Promise<AvatarOutcome<undefined>> {
  if (path === '') return failure('remove-failed');

  const { error } = await getSupabaseClient().storage.from(AVATAR_BUCKET).remove([path]);
  if (error !== null) return failure('remove-failed');

  return { ok: true, value: undefined };
}

/**
 * Replaces a user's photo: uploads the new object, writes its path using the
 * provided write callback, and removes the object that was replaced.
 *
 * If the write fails, the newly uploaded object is removed so it does not
 * become an orphan, and the original error is rethrown. If there was no
 * previous photo (or if it matched the new path), nothing is removed on success.
 *
 * Note: the three steps are not atomic. Callers must not invoke this
 * concurrently for the same user.
 */
export async function replaceAvatar(
  userId: string,
  file: Blob,
  current: string | null,
  write: (path: string) => Promise<unknown>,
): Promise<AvatarOutcome<{ path: string }>> {
  const uploaded = await uploadAvatar(userId, file);
  if (!uploaded.ok) return uploaded;

  const { path } = uploaded.value;

  try {
    await write(path);
  } catch (error) {
    // The profile write failed: remove what was just uploaded so it does not
    // orphan. A cleanup failure must not swallow the original error.
    try {
      await removeAvatar(path);
    } catch {
      // Best-effort cleanup
    }
    throw error;
  }

  // The profile was updated: remove the superseded object.
  if (current !== null && current !== '' && current !== path) {
    try {
      await removeAvatar(current);
    } catch {
      // Best-effort cleanup
    }
  }

  return { ok: true, value: { path } };
}

/**
 * A short-lived URL for one photo.
 *
 * The bucket is private and its select policy is owner-scoped, so this is the
 * only way a photo is displayed — and it is also why no screen may render another
 * member's avatar: signing one would be denied by policy, and a denial is not
 * something to paper over with a placeholder that looks like a photo.
 *
 * A failure is reported as a value: an avatar that cannot be signed is a missing
 * picture, not a broken page.
 */
export async function avatarSignedUrl(
  path: string,
  ttlSeconds = AVATAR_SIGNED_URL_TTL_SECONDS,
): Promise<AvatarOutcome<string>> {
  const { data, error } = await getSupabaseClient()
    .storage.from(AVATAR_BUCKET)
    .createSignedUrl(path, ttlSeconds);

  if (error !== null || data === null || typeof data.signedUrl !== 'string') {
    return failure('sign-failed');
  }

  return { ok: true, value: data.signedUrl };
}
