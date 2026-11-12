const playwrightPath =
  process.env.PLAYWRIGHT_MODULE ?? new URL('../../web/node_modules/playwright/index.mjs', import.meta.url).href;
const { chromium } = await import(playwrightPath);

const BASE = process.env.BASE ?? 'http://127.0.0.1:23284';
const API = `${BASE}/api`;
const EMAIL = 'test@example.com';
const PASSWORD = 'password1234';
const FILE = process.argv[2] ?? 'sample.mp4';

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const uploadEvents = [];
const failures = [];

const login = await context.request.post(`${API}/auth/login`, { data: { email: EMAIL, password: PASSWORD } });
if (!login.ok()) {
  await context.request.post(`${API}/auth/admin-sign-up`, { data: { email: EMAIL, password: PASSWORD, name: 'Test' } });
  await context.request.post(`${API}/auth/login`, { data: { email: EMAIL, password: PASSWORD } });
}

page.on('response', (response) => {
  const url = response.url();
  if (url.includes('/socket.io')) return;
  if (url.includes('/api/upload')) {
    uploadEvents.push(`${response.request().method()} ${response.status()} ${url}`);
  }
  if (response.status() >= 400) {
    failures.push(`${response.status()} ${response.request().method()} ${url}`);
  }
});
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('socket.io')) {
    console.log(`console: ${message.text()}`);
  }
});

await page.goto(BASE, { waitUntil: 'networkidle' });

const chooser = page.waitForEvent('filechooser', { timeout: 15_000 }).catch(() => undefined);
await page.getByRole('button', { name: 'Upload', exact: true }).first().click();
const fileChooser = await chooser;
if (fileChooser) {
  await fileChooser.setFiles(FILE);
} else {
  await page.locator('input[type=file]').first().setInputFiles(FILE);
}

await page
  .waitForResponse(
    (response) =>
      response.url().includes('/api/upload') &&
      response.request().method() === 'PATCH' &&
      response.status() >= 200 &&
      response.status() < 300,
    { timeout: 300_000 },
  )
  .catch(() => console.log('no successful PATCH observed'));
await page.waitForTimeout(5000);

console.log(`upload requests: ${uploadEvents.length}`);
for (const event of uploadEvents) console.log(`  ${event}`);
console.log(`failed requests: ${failures.length}`);
for (const failure of failures) console.log(`  ${failure}`);
await browser.close();
process.exitCode = failures.length === 0 && uploadEvents.some((event) => event.startsWith('PATCH')) ? 0 : 1;
