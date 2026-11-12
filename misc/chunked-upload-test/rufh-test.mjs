import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

const BASE = process.env.BASE ?? 'http://127.0.0.1:23284/api';
const EMAIL = 'test@example.com';
const PASSWORD = 'password1234';
const FILE = process.argv[2] ?? 'sample.mp4';
const MODE = process.argv[3] ?? 'rufh';

const json = (url, body, token) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

async function login() {
  let response = await json(`${BASE}/auth/login`, { email: EMAIL, password: PASSWORD });
  if (!response.ok) {
    await json(`${BASE}/auth/admin-sign-up`, { email: EMAIL, password: PASSWORD, name: 'Test' });
    response = await json(`${BASE}/auth/login`, { email: EMAIL, password: PASSWORD });
  }
  if (!response.ok) throw new Error(`login failed ${response.status} ${await response.text()}`);
  const { accessToken } = await response.json();
  return accessToken;
}

async function hashFile(path) {
  const handle = await open(path, 'r');
  const hash = createHash('sha1');
  const buffer = Buffer.alloc(4 * 1024 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  await handle.close();
  return hash.digest();
}

const quote = (value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const assetData = (name) =>
  [
    `device-asset-id=${quote(`test-${name}`)}`,
    `device-id=${quote('test')}`,
    `filename=${quote(name)}`,
    `file-created-at=${quote('2024-01-01T00:00:00Z')}`,
    `file-modified-at=${quote('2024-01-01T00:00:00Z')}`,
  ].join(', ');

async function readSlice(handle, start, end) {
  const length = end - start;
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, start);
  return buffer.subarray(0, bytesRead);
}

async function main() {
  const token = await login();
  const handle = await open(FILE, 'r');
  const { size } = await handle.stat();
  const checksum = await hashFile(FILE);
  const name = FILE.split(/[\\/]/).pop();

  if (MODE === 'bulk') {
    const form = new FormData();
    form.append('fileCreatedAt', '2024-01-01T00:00:00.000Z');
    form.append('fileModifiedAt', '2024-01-01T00:00:00.000Z');
    form.append('assetData', new Blob([await readSlice(handle, 0, size)]), name);
    const started = Date.now();
    const response = await fetch(`${BASE}/assets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    console.log(`single request: ${response.status} in ${Date.now() - started}ms ${await response.text()}`);
    await handle.close();
    return;
  }

  const options = await fetch(`${BASE}/upload`, { method: 'OPTIONS' });
  const limitHeader = options.headers.get('upload-limit') ?? '';
  console.log(`OPTIONS ${options.status} upload-limit="${limitHeader}"`);
  const limit = Number(/(?:^|,)\s*max-append-size=(\d+)/.exec(limitHeader)?.[1]);
  if (!limit) throw new Error('server did not advertise max-append-size');

  let offset = 0;
  let url = `${BASE}/upload`;
  let chunkSize = limit;
  const started = Date.now();
  let requests = 0;

  while (offset < size) {
    const end = Math.min(offset + chunkSize, size);
    const complete = end === size;
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': offset === 0 ? 'application/octet-stream' : 'application/partial-upload',
      'upload-draft-interop-version': '6',
      'upload-complete': complete ? '?1' : '?0',
      'upload-length': String(size),
      'content-length': String(end - offset),
      ...(offset === 0
        ? { 'repr-digest': `sha=:${checksum.toString('base64')}:`, 'x-immich-asset-data': assetData(name) }
        : { 'upload-offset': String(offset) }),
    };

    const response = await fetch(url, {
      method: offset === 0 ? 'POST' : 'PATCH',
      headers,
      body: await readSlice(handle, offset, end),
    });
    requests++;

    if (response.status === 413) {
      const serverLimit = Number(/(?:^|,)\s*max-append-size=(\d+)/.exec(response.headers.get('upload-limit') ?? '')?.[1]);
      chunkSize = serverLimit > 0 && serverLimit < chunkSize ? serverLimit : Math.max(5 * 1024 * 1024, chunkSize >> 1);
      console.log(`413 at offset ${offset}, shrinking chunk to ${chunkSize}`);
      continue;
    }
    if (response.status === 409) {
      const serverOffset = Number(response.headers.get('upload-offset'));
      offset = Number.isSafeInteger(serverOffset) ? serverOffset : offset;
      const location = response.headers.get('location');
      if (location) url = new URL(location, BASE).href;
      console.log(`409, resuming at ${offset}`);
      continue;
    }
    if (!response.ok) {
      console.log(`failed ${response.status} ${await response.text()}`);
      process.exitCode = 1;
      break;
    }

    const location = response.headers.get('location');
    if (offset === 0 && location) url = new URL(location, BASE).href;
    const reported = Number(response.headers.get('upload-offset'));
    offset = Number.isSafeInteger(reported) && reported > offset ? reported : end;
    const body = await response.json().catch(() => ({}));
    if (body.id) {
      console.log(`uploaded ${size} bytes in ${requests} requests, ${Date.now() - started}ms, asset ${body.id}`);
      break;
    }
  }
  await handle.close();
}

await main();
