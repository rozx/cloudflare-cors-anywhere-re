# Cloudflare CORS Anywhere

A public CORS proxy running on Cloudflare Workers. It forwards HTTP requests and adds the headers browsers need for cross-origin access.

## Usage

Pass a URL-encoded destination to `?url=`:

```js
const target = "https://example.com/";
const response = await fetch(
    `https://your-worker.example/?url=${encodeURIComponent(target)}`
);
const text = await response.text();
```

Use the target API's normal method, headers, and body for POST, PUT, PATCH, or DELETE requests. CORS preflights are handled automatically. The legacy `?{targetUrl}` format is also supported.

Replace `https://your-worker.example` with your own deployment URL. Open that URL for usage instructions and the current release version. Browser-restricted request headers can be supplied as a JSON object in `x-cors-headers`.

## Limits and costs

| Limit | Default |
| --- | --- |
| Upload / response | 1 MiB / 10 MiB |
| Total duration, including streaming | 30 seconds |
| Requests per client | 60/minute per IPv4 address or IPv6 /64 |
| Requests shared across clients | 300/minute |
| Upstream calls, including redirects | 3 per request |

Rate limits are approximate and apply per Cloudflare location, not globally. HTTP 429 means retry later; follow the `Retry-After` header. Oversized or slow responses may end early. Only HTTP(S) domains on standard ports are accepted; IP literals and obvious local targets are blocked.

**For no Worker usage charges, keep the account on Workers Free.** Its 100,000-request daily quota is shared across the account. Abuse can exhaust that quota and cause downtime. Paid plans can incur usage charges; these rate limits are not a spending cap. See [Cloudflare's limits](https://developers.cloudflare.com/workers/platform/limits/).

Backups, persistent KV caching, automatic retries, and retained logs are disabled by default. Enabling a third-party backup can incur separate charges. Write requests are never replayed, and upstream 429 responses are never retried.

## Deploy your own

```sh
npm install
npx wrangler login
```

Set your Worker name in `wrangler.toml`. Configure a custom domain in the Cloudflare dashboard, or add a route at the top of the file, before any `[section]`:

```toml
routes = [{ pattern = "cors.example.com", custom_domain = true }]
```

`workers.dev` and preview URLs are disabled. For an origin-backed route, select **fail closed** in Cloudflare. An edge rate-limit rule can reject traffic before it reaches the Worker.

```sh
npm run deploy
```

Deployment reads the release version from `package.json`. Existing dashboard variables are preserved; the checked-in safety flags explicitly disable backups, KV, and retries.

## Configuration

Set these environment variables in Cloudflare or in `wrangler.toml` under `[vars]`:

| Variable | Format / default |
| --- | --- |
| `ALLOWED_TARGET_HOSTS` | Exact hostnames, e.g. `'["api.example.com"]'`. Empty allows any otherwise permitted domain. |
| `WHITELIST_ORIGINS` | Regex array, e.g. `'["^https://app\\.example$"]'`. Default: `'[".*"]'`. |
| `BLACKLIST_URLS` | Regex array of blocked URLs. Default: `'[]'`. |

Origin rules are browser policy, not authentication: non-browser clients can spoof `Origin`. Invalid access rules fail closed. Change rate thresholds in the `[[ratelimits]]` sections; use namespace IDs unique to your account.

Optional backup settings are defined in [src/config.js](src/config.js). Keep `ENABLE_BACKUP_FALLBACK` and `ENABLE_BACKUP_KV` off for the public, free deployment.

## Development

```sh
npm test
npx wrangler dev
```

## Credits

Maintained by [rozx](https://github.com/rozx), based on [Zibri's original](https://github.com/Zibri/cloudflare-cors-anywhere). [MIT license](LICENSE_MIT).
