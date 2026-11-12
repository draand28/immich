# Chunked upload test harness

Runs the resumable upload path against a local stack that refuses request bodies over 100 MB, the way Cloudflare does.

```
docker compose up -d          # postgres, redis, immich, machine learning, nginx on :23284
node rufh-test.mjs sample.mp4 bulk   # single request, expect 413 from the proxy
node rufh-test.mjs sample.mp4 rufh   # OPTIONS then POST/PATCH, expect success
node browser-upload.mjs sample2.mp4  # same flow through the web UI in headless Chromium
```

`rufh-test.mjs` creates the admin account on first run. Use a different file for the browser run: an already uploaded checksum is rejected as a duplicate before any upload starts.

`browser-upload.mjs` needs the Playwright browsers (`pnpm exec playwright install chromium` inside `web/`). It resolves Playwright from `web/node_modules`; set `PLAYWRIGHT_MODULE` to override.

The proxy only limits the body size. `proxy_request_buffering off` keeps it streaming to the server, like Cloudflare Tunnel.

Build the image first from the repository root: `docker build -f server/Dockerfile -t immich-chunked:local .`

Set TEST_EMAIL and TEST_PASSWORD to override the throwaway admin account the scripts create.
