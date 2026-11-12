import { authManager } from '#lib/managers/auth-manager.svelte.ts';
import { uploadManager } from '#lib/managers/upload-manager.svelte.ts';
import { addAssetsToAlbumsMutation } from '#lib/queries/album.query.ts';
import { executeMutation } from '#lib/queries/client.ts';
import { uploadAssetsStore } from '#lib/stores/upload.ts';
import { UploadState } from '#lib/types.ts';
import { ApiError, uploadRequest } from '#lib/utils.ts';
import { ExecutorQueue } from '#lib/utils/executor-queue.ts';
import { asQueryString } from '#lib/utils/shared-links.ts';
import {
  AssetMediaStatus,
  AssetUploadAction,
  AssetVisibility,
  checkBulkUpload,
  getBaseUrl,
  type AssetMediaResponseDto,
} from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { tick } from 'svelte';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import { handleError } from './handle-error';

export const uploadExecutionQueue = new ExecutorQueue({ concurrency: 2 });

type FilePickerParam = { multiple?: boolean; extensions?: string[] };
type FileUploadParam = { multiple?: boolean; albumId?: string };

export const openFilePicker = async (options: FilePickerParam = {}) => {
  const { multiple = true, extensions } = options;

  return new Promise<File[]>((resolve, reject) => {
    try {
      const fileSelector = document.createElement('input');

      fileSelector.type = 'file';
      fileSelector.multiple = multiple;

      if (extensions) {
        fileSelector.accept = extensions.join(',');
      }

      fileSelector.addEventListener(
        'change',
        (e: Event) => {
          fileSelector.remove();

          const target = e.target as HTMLInputElement;
          if (!target.files) {
            return;
          }

          const files = Array.from(target.files);
          resolve(files);
        },
        { passive: true },
      );

      fileSelector.addEventListener('cancel', () => fileSelector.remove(), { passive: true });

      // Safari requires the file selector to be mounted
      fileSelector.hidden = true;
      document.body.append(fileSelector);
      fileSelector.click();
    } catch (error) {
      console.log('Error selecting file', error);
      reject(error);
    }
  });
};

export const openFileUploadDialog = async (options: FileUploadParam = {}) => {
  const { albumId, multiple = true } = options;
  const extensions = uploadManager.getExtensions();
  const files = await openFilePicker({
    multiple,
    extensions,
  });

  return fileUploadHandler({ files, albumId });
};

type FileUploadHandlerParams = Omit<FileUploaderParams, 'deviceAssetId' | 'assetFile'> & {
  files: File[];
};

export const fileUploadHandler = async ({
  files,
  albumId,
  isLockedAssets = false,
}: FileUploadHandlerParams): Promise<string[]> => {
  const extensions = uploadManager.getExtensions();
  const promises = [];
  for (const file of files) {
    const name = file.name.toLowerCase();
    if (extensions.some((extension) => name.endsWith(extension))) {
      const deviceAssetId = getDeviceAssetId(file);
      uploadAssetsStore.addItem({ id: deviceAssetId, file, albumId });
      promises.push(
        uploadExecutionQueue.addTask(() => fileUploader({ deviceAssetId, assetFile: file, albumId, isLockedAssets })),
      );
    } else {
      toastManager.warning(get(t)('unsupported_file_type', { values: { file: file.name, type: file.type } }), {
        timeout: 10_000,
      });
    }
  }

  const results = await Promise.all(promises);
  return results.filter((result): result is string => !!result);
};

function getDeviceAssetId(asset: File) {
  return 'web-' + asset.name + '-' + asset.lastModified;
}

function hashFile(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(new URL('../workers/hash-file.ts', import.meta.url), { type: 'module' });

    worker.addEventListener('message', ({ data }: MessageEvent<{ result?: string; error?: string }>) => {
      worker.terminate();

      if (data.error) {
        reject(new Error(data.error));
      } else {
        resolve(data.result!);
      }
    });

    worker.addEventListener('error', (event) => {
      worker.terminate();

      reject(new Error(event.message));
    });

    worker.postMessage(file);
  });
}

type FileUploaderParams = {
  assetFile: File;
  albumId?: string;
  replaceAssetId?: string;
  isLockedAssets?: boolean;
  // TODO rework the asset uploader and remove this
  deviceAssetId: string;
};

const MIN_CHUNK_BYTES = 5 * 1024 * 1024;

const quoteStructured = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

const hexToBase64 = (hex: string) => {
  const bytes = hex.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [];
  return btoa(String.fromCodePoint(...bytes));
};

const getMaxAppendSize = async (url: string) => {
  try {
    const response = await fetch(url, { method: 'OPTIONS' });
    if (!response.ok) {
      return;
    }
    const match = /(?:^|,)\s*max-append-size=(\d+)/.exec(response.headers.get('upload-limit') ?? '');
    return match ? Number(match[1]) : undefined;
  } catch {
    return;
  }
};

type ResumableUploadOptions = {
  assetFile: File;
  deviceAssetId: string;
  fileCreatedAt: string;
  checksum?: string;
  onProgress: (loaded: number, total: number) => void;
};

const resumableUpload = async ({
  assetFile,
  deviceAssetId,
  fileCreatedAt,
  checksum,
  onProgress,
}: ResumableUploadOptions): Promise<{ id: string } | undefined> => {
  const size = assetFile.size;
  if (size <= MIN_CHUNK_BYTES) {
    return;
  }

  const queryParams = asQueryString(authManager.params);
  const withQuery = (url: string) => (queryParams ? `${url}${url.includes('?') ? '&' : '?'}${queryParams}` : url);
  const uploadUrl = withQuery(getBaseUrl() + '/upload');
  let chunkSize = await getMaxAppendSize(uploadUrl);
  if (!chunkSize || size <= chunkSize) {
    return;
  }

  const digest = hexToBase64(checksum ?? (await hashFile(assetFile)));
  const assetData = [
    `device-asset-id=${quoteStructured(deviceAssetId)}`,
    `device-id=${quoteStructured('web')}`,
    `filename=${quoteStructured(assetFile.name)}`,
    `file-created-at=${quoteStructured(fileCreatedAt)}`,
    `file-modified-at=${quoteStructured(new Date(assetFile.lastModified).toISOString())}`,
    'is-favorite=?0',
  ].join(', ');

  let offset = 0;
  let url = uploadUrl;
  while (offset < size) {
    const end = Math.min(offset + chunkSize, size);
    const complete = end === size;
    const headers: Record<string, string> = {
      'content-type': offset === 0 ? 'application/octet-stream' : 'application/partial-upload',
      'upload-draft-interop-version': '6',
      'upload-complete': complete ? '?1' : '?0',
      'upload-length': String(size),
    };
    if (offset === 0) {
      headers['repr-digest'] = `sha=:${digest}:`;
      headers['x-immich-asset-data'] = assetData;
    } else {
      headers['upload-offset'] = String(offset);
    }

    try {
      const response = await uploadRequest<{ id?: string }>({
        url,
        method: offset === 0 ? 'POST' : 'PATCH',
        data: assetFile.slice(offset, end),
        headers,
        onUploadProgress: (event) => onProgress(offset + event.loaded, size),
      });

      const location = response.headers['location'];
      if (offset === 0 && location) {
        url = withQuery(new URL(location, globalThis.location.origin).href);
      }
      const reportedOffset = Number(response.headers['upload-offset']);
      offset = Number.isSafeInteger(reportedOffset) && reportedOffset > offset ? reportedOffset : end;
      onProgress(offset, size);

      if (response.data?.id) {
        return { id: response.data.id };
      }
      if (complete) {
        throw new Error('Upload completed without an asset id');
      }
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 413) {
        const next = Math.max(MIN_CHUNK_BYTES, Math.floor(chunkSize / 2));
        if (next >= end - offset) {
          throw error;
        }
        chunkSize = next;
        continue;
      }
      if (error instanceof ApiError && error.statusCode === 409) {
        const serverOffset = Number(error.headers['upload-offset']);
        if (Number.isSafeInteger(serverOffset) && serverOffset !== offset) {
          offset = serverOffset;
          const location = error.headers['location'];
          if (location) {
            url = withQuery(new URL(location, globalThis.location.origin).href);
          }
          continue;
        }
      }
      throw error;
    }
  }

  throw new Error('Upload did not finish');
};

// TODO: should probably use the @api SDK
async function fileUploader({
  assetFile,
  deviceAssetId,
  albumId,
  isLockedAssets = false,
}: FileUploaderParams): Promise<string | undefined> {
  const fileCreatedAt = new Date(assetFile.lastModified).toISOString();
  const $t = get(t);
  const wasInitiallyLoggedIn = !!authManager.authenticated;

  uploadAssetsStore.markStarted(deviceAssetId);

  try {
    const formData = new FormData();
    for (const [key, value] of Object.entries({
      fileCreatedAt,
      fileModifiedAt: new Date(assetFile.lastModified).toISOString(),
      isFavorite: 'false',
      assetData: new File([assetFile], assetFile.name),
    })) {
      formData.append(key, value);
    }

    if (isLockedAssets) {
      formData.append('visibility', AssetVisibility.Locked);
    }

    let responseData: { id: string; status: AssetMediaStatus; isTrashed?: boolean } | undefined;
    let checksum: string | undefined;
    if (!authManager.isSharedLink) {
      uploadAssetsStore.updateItem(deviceAssetId, { message: $t('asset_hashing') });
      await tick();
      try {
        checksum = await hashFile(assetFile);

        const {
          results: [checkUploadResult],
        } = await checkBulkUpload({ assetBulkUploadCheckDto: { assets: [{ id: assetFile.name, checksum }] } });
        if (checkUploadResult.action === AssetUploadAction.Reject && checkUploadResult.assetId) {
          responseData = {
            status: AssetMediaStatus.Duplicate,
            id: checkUploadResult.assetId,
            isTrashed: checkUploadResult.isTrashed,
          };
        }
      } catch (error) {
        console.error(`Error calculating sha1 file=${assetFile.name})`, error);
      }
    }

    if (!responseData && !isLockedAssets) {
      uploadAssetsStore.updateItem(deviceAssetId, { message: $t('asset_uploading') });
      const chunked = await resumableUpload({
        assetFile,
        deviceAssetId,
        fileCreatedAt,
        checksum,
        onProgress: (loaded, total) => uploadAssetsStore.updateProgress(deviceAssetId, loaded, total),
      });
      if (chunked) {
        responseData = { id: chunked.id, status: AssetMediaStatus.Created };
      }
    }

    if (!responseData) {
      const queryParams = asQueryString(authManager.params);

      uploadAssetsStore.updateItem(deviceAssetId, { message: $t('asset_uploading') });
      const response = await uploadRequest<AssetMediaResponseDto>({
        url: getBaseUrl() + '/assets' + (queryParams ? `?${queryParams}` : ''),
        data: formData,
        onUploadProgress: (event) => uploadAssetsStore.updateProgress(deviceAssetId, event.loaded, event.total),
      });

      if (![200, 201].includes(response.status)) {
        throw new Error($t('errors.unable_to_upload_file'));
      }

      responseData = response.data;
    }

    if (responseData.status === AssetMediaStatus.Duplicate) {
      uploadAssetsStore.track('duplicate');
    } else {
      uploadAssetsStore.track('success');
    }

    if (albumId && !authManager.isSharedLink) {
      uploadAssetsStore.updateItem(deviceAssetId, { message: $t('asset_adding_to_album') });
      await executeMutation(() => addAssetsToAlbumsMutation({ notify: false }), {
        albumIds: [albumId],
        assetIds: [responseData.id],
      });
      uploadAssetsStore.updateItem(deviceAssetId, { message: $t('asset_added_to_album') });
    }

    uploadAssetsStore.updateItem(deviceAssetId, {
      state: responseData.status === AssetMediaStatus.Duplicate ? UploadState.DUPLICATED : UploadState.DONE,
      assetId: responseData.id,
      isTrashed: responseData.isTrashed,
    });

    if (responseData.status !== AssetMediaStatus.Duplicate) {
      setTimeout(() => {
        uploadAssetsStore.removeItem(deviceAssetId);
      }, 1000);
    }

    return responseData.id;
  } catch (error) {
    // If the user store no longer holds a user, it means they have logged out
    // In this case don't bother reporting any errors.
    if (wasInitiallyLoggedIn && !authManager.authenticated) {
      return;
    }

    const errorMessage = handleError(error, $t('errors.unable_to_upload_file'));
    uploadAssetsStore.track('error');
    uploadAssetsStore.updateItem(deviceAssetId, { state: UploadState.ERROR, error: errorMessage });
    return;
  }
}
