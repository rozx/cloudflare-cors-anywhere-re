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

The proxy sends a consistent browser identity upstream: the client's own `User-Agent`, `Sec-Ch-*`, `Sec-Fetch-*` and `Upgrade-Insecure-Requests` headers are not forwarded. To use a specific User-Agent, send it in the `x-cors-headers` JSON header (for example `{"User-Agent":"MyApp/1.0"}`); the browser identity headers are then omitted.

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

Backups, persistent KV caching, and automatic retries are disabled by default. Anonymous GET responses with status 200 are cached for 10 minutes per Cloudflare location, keyed by target URL, `x-cors-headers`, `Accept` and `Accept-Language`; requests with credentials or other custom headers bypass the cache. The `x-cors-cache` response header reports `HIT` or `MISS`. Workers Logs are enabled in `wrangler.toml` and record target URLs, including query strings; set `[observability] enabled = false` to turn them off. Enabling a third-party backup can incur separate charges. Write requests are never replayed, and upstream 429 responses are never retried.

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

Deployment reads the release version from `package.json`. Dashboard variables are preserved because `wrangler.toml` defines no `[vars]`; when unset, backups, KV, and retries default to off.

## Configuration

Set these environment variables in Cloudflare or in `wrangler.toml` under `[vars]`:

| Variable | Format / default |
| --- | --- |
| `ALLOWED_TARGET_HOSTS` | Exact hostnames, e.g. `'["api.example.com"]'`. Empty allows any otherwise permitted domain. |
| `WHITELIST_ORIGINS` | Regex array, e.g. `'["^https://app\\.example$"]'`. Default: `'[".*"]'`. |
| `BLACKLIST_URLS` | Regex array of blocked URLs. Default: `'[]'`. |

Origin rules are browser policy, not authentication: non-browser clients can spoof `Origin`. Invalid access rules fail closed. Change rate thresholds in the `[[ratelimits]]` sections; use namespace IDs unique to your account.

Optional backup settings are defined in [src/config.js](src/config.js). Set `ENABLE_BACKUP_FALLBACK`, `ENABLE_BACKUP_KV` and `MAX_RETRY_ATTEMPTS` in the Cloudflare Dashboard, not in `wrangler.toml` `[vars]`, which would overwrite the Dashboard values on every deploy. With `ENABLE_BACKUP_FALLBACK = "true"`, blocked GET/HEAD requests (403/502/503) fail over to up to two `BACKUP_CORS_SERVERS`; each failover is an extra billable subrequest. After a successful failover, that domain goes to the backup first for up to 15 minutes (per isolate, in memory), with direct as the last resort. Keep `ENABLE_BACKUP_KV` off for the public, free deployment.

## Development

```sh
npm test
npx wrangler dev
```

## Credits

Maintained by [rozx](https://github.com/rozx), based on [Zibri's original](https://github.com/Zibri/cloudflare-cors-anywhere). [MIT license](LICENSE_MIT).
