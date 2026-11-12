import { authManager } from '#lib/managers/auth-manager.svelte.ts';
import { uploadManager } from '#lib/managers/upload-manager.svelte.ts';
import { uploadAssetsStore } from '#lib/stores/upload.ts';
import { UploadState } from '#lib/types.ts';
import { ApiError, uploadRequest } from '#lib/utils.ts';
import { factory } from '#test/unit/factories.ts';
import { test } from '#test/unit/fixtures.ts';
import { AssetMediaStatus, type AssetMediaResponseDto } from '@immich/sdk';
import { get } from 'svelte/store';
import { beforeEach, describe, expect, vi } from 'vitest';
import { fileUploadHandler, openFilePicker } from './file-uploader';

vi.mock('#lib/utils.ts', { spy: true });

describe('fileUploader error handling', () => {
  const newFile = () => new File(['content'], `${crypto.randomUUID()}.jpg`, { type: 'image/jpeg' });
  const mockUserObject = factory.user();
  const mockError = new Error('Upload failed');
  const mockUploadResponse = { id: 'mock-id', status: AssetMediaStatus.Created } as AssetMediaResponseDto;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(uploadManager, 'getExtensions').mockReturnValue(['.jpg']);
    uploadAssetsStore.reset();
    authManager.reset();
  });

  for (const [name, mockUser] of [
    ['logged-in users', true],
    ['anonymous users', false],
  ] as const) {
    describe(`for ${name}`, () => {
      beforeEach(() => {
        if (mockUser) {
          authManager.setUser(mockUserObject);
        }
      });

      test(`should transition successful uploads to done`, async () => {
        vi.mocked(uploadRequest).mockResolvedValue({ status: 200, data: mockUploadResponse, headers: {} });

        await fileUploadHandler({ files: [newFile()] });

        const items = get(uploadAssetsStore);
        expect(items.length).toBe(1);
        expect(items[0].state).toBe(UploadState.DONE);
      });

      test('should capture errors', async ({ logger }) => {
        vi.mocked(uploadRequest).mockRejectedValue(mockError);

        await fileUploadHandler({ files: [newFile()] });

        const items = get(uploadAssetsStore);
        expect(items.length).toBe(1);
        expect(items[0].state).toBe(UploadState.ERROR);
        expect(logger.error).toHaveBeenCalledWith(/Upload failed/);
      });
    });
  }

  test('should suppress errors on logout', async () => {
    authManager.setUser(mockUserObject);
    authManager.setPreferences(factory.preferences());
    vi.mocked(uploadRequest).mockImplementationOnce(() => {
      authManager.reset();
      return Promise.reject(mockError);
    });

    await fileUploadHandler({ files: [newFile()] });

    const items = get(uploadAssetsStore);
    expect(items.length).toBe(1);
    expect(items[0].state).toBe(UploadState.STARTED);
  });
});

describe('fileUploader resumable uploads', () => {
  const LIMIT = 10 * 1024 * 1024;

  beforeEach(() => {
    uploadAssetsStore.reset();
    authManager.reset();
    authManager.setUser(factory.user());
  });

  test('splits a large file when the server advertises a max append size', async ({ api }) => {
    api.on({ getUploadOptions: () => ({ status: 204, headers: { 'upload-limit': `max-append-size=${LIMIT}` } }) });
    vi.mocked(uploadRequest).mockImplementation(async (options): Promise<{ data: unknown; status: number; headers: Record<string, string> }> => {
      if (options.method === 'POST') {
        return { status: 201, data: {} as never, headers: { location: '/api/upload/asset-id' } };
      }
      return { status: 200, data: { id: 'asset-id' } as never, headers: {} };
    });
    const file = new File([new Uint8Array(LIMIT + 1024)], 'big.jpg', { type: 'image/jpeg' });

    await fileUploadHandler({ files: [file] });

    const calls = vi.mocked(uploadRequest).mock.calls;
    expect(calls.map(([options]) => options.method)).toEqual(['POST', 'PATCH']);
    expect(calls[0][0].headers?.['upload-length']).toBe(String(file.size));
    expect(calls[0][0].headers?.['repr-digest']).toMatch(/^sha=:/);
    expect(calls[0][0].headers?.['x-immich-asset-data']).toContain('filename="big.jpg"');
    expect(calls[1][0].headers?.['upload-offset']).toBe(String(LIMIT));
    expect(calls[1][0].headers?.['upload-complete']).toBe('?1');
    expect(get(uploadAssetsStore)[0].state).toBe(UploadState.DONE);
  });

  test('shrinks the chunk when the proxy rejects the append size', async ({ api }) => {
    api.on({ getUploadOptions: () => ({ status: 204, headers: { 'upload-limit': `max-append-size=${LIMIT}` } }) });
    let posts = 0;
    vi.mocked(uploadRequest).mockImplementation(async (options): Promise<{ data: unknown; status: number; headers: Record<string, string> }> => {
      if (options.method === 'POST') {
        if (posts++ === 0) {
          throw new ApiError('Payload Too Large', 413, '');
        }
        return { status: 201, data: {} as never, headers: { location: '/api/upload/asset-id' } };
      }
      return { status: 200, data: { id: 'asset-id' } as never, headers: {} };
    });
    const file = new File([new Uint8Array(LIMIT + 1024)], 'big.jpg', { type: 'image/jpeg' });

    await fileUploadHandler({ files: [file] });

    const postsAndPatches = vi
      .mocked(uploadRequest)
      .mock.calls.map(([options]) => options)
      .filter((options) => options.method !== undefined);
    expect(posts).toBe(2);
    expect((postsAndPatches[1].data as Blob).size).toBe(LIMIT / 2);
    expect(get(uploadAssetsStore)[0].state).toBe(UploadState.DONE);
  });

  test('resumes a partial upload at the offset from a 409', async ({ api }) => {
    api.on({ getUploadOptions: () => ({ status: 204, headers: { 'upload-limit': `max-append-size=${LIMIT}` } }) });
    const file = new File([new Uint8Array(LIMIT + 1024)], 'big.jpg', { type: 'image/jpeg' });
    const location = '/api/upload/resumed-id';
    vi.mocked(uploadRequest).mockImplementation(async (options): Promise<{ data: unknown; status: number; headers: Record<string, string> }> => {
      if (options.method === 'POST') {
        throw new ApiError('Conflict', 409, '', { 'upload-offset': String(LIMIT), location });
      }
      return { status: 200, data: { id: 'resumed-id' } as never, headers: {} };
    });

    await fileUploadHandler({ files: [file] });

    const calls = vi.mocked(uploadRequest).mock.calls.map(([options]) => options);
    const patch = calls.find((options) => options.method === 'PATCH');
    expect(patch?.url).toContain(location);
    expect(patch?.headers?.['upload-offset']).toBe(String(LIMIT));
    expect(patch?.headers?.['upload-complete']).toBe('?1');
    expect(get(uploadAssetsStore)[0].state).toBe(UploadState.DONE);
  });

  test('uses the size the proxy reports on 413', async ({ api }) => {
    api.on({ getUploadOptions: () => ({ status: 204, headers: { 'upload-limit': `max-append-size=${LIMIT}` } }) });
    const file = new File([new Uint8Array(LIMIT + 1024)], 'big.jpg', { type: 'image/jpeg' });
    const proxyLimit = 6 * 1024 * 1024;
    let posts = 0;
    vi.mocked(uploadRequest).mockImplementation(async (options): Promise<{ data: unknown; status: number; headers: Record<string, string> }> => {
      if (options.method === 'POST') {
        if (posts++ === 0) {
          throw new ApiError('Payload Too Large', 413, '', { 'upload-limit': `max-append-size=${proxyLimit}` });
        }
        return { status: 201, data: {} as never, headers: { location: '/api/upload/asset-id' } };
      }
      return { status: 200, data: { id: 'asset-id' } as never, headers: {} };
    });

    await fileUploadHandler({ files: [file] });

    const retried = vi.mocked(uploadRequest).mock.calls[1][0];
    expect((retried.data as Blob).size).toBe(proxyLimit);
    expect(get(uploadAssetsStore)[0].state).toBe(UploadState.DONE);
  });
});

describe('openFilePicker', () => {
  test('attaches the file input to the document until files are chosen', async () => {
    const file = new File(['content'], 'photo.jpg', { type: 'image/jpeg' });
    const picked = openFilePicker({ extensions: ['.jpg'] });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');

    expect(input).not.toBeNull();
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input!.files = transfer.files;
    input!.dispatchEvent(new Event('change'));

    await expect(picked).resolves.toEqual([file]);
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});


