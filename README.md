# cloudflare-cors-anywhere-re

Cloudflare CORS proxy in a worker. This worker enables cross-origin requests by acting as a proxy, automatically adding the necessary CORS headers to responses.

**Quick Start**: Use `?url={targetUrl}` format:
```
https://your-worker.workers.dev/?url=https://api.example.com/data
```

Access the worker without a target URL to see the info page with usage instructions, version information, and request details.

CLOUDFLARE-CORS-ANYWHERE

Authors:

-   rozx (maintainer)
-   Zibri (original author)

Source:
https://github.com/rozx/cloudflare-cors-anywhere

Original source:
https://github.com/Zibri/cloudflare-cors-anywhere

## Public access and cost protection

This is a public proxy. It cannot guarantee that nobody abuses it. The no-usage-charge deployment assumes the **Cloudflare account is on Workers Free**, not merely that the domain is on a Free website plan. The plan is an account setting and cannot be pinned in this repository. Workers Free has an account-wide 100,000-request daily quota; exceeding it produces errors, not paid Worker overages. An attacker can still exhaust that quota and affect other Workers on the account. Configure Worker routes to **fail closed** so quota exhaustion cannot send traffic to an underlying origin. See [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/) and [pricing](https://developers.cloudflare.com/workers/platform/pricing/).

The checked-in public deployment has these protections:

| Protection | Default |
| --- | --- |
| Per-client throttle | 60 requests/minute per IPv4 address or IPv6 /64, per Cloudflare location |
| Shared throttle | 300 requests/minute per Cloudflare location |
| Upload / response size | 1 MiB / 10 MiB, counting streamed bytes |
| Total request duration | 30 seconds, including uploads and response streaming |
| Upstream fetch budget | 3 total, including redirects, retries and backups |
| Automatic retries | Off; only GET/HEAD can be retried when enabled |
| Backup providers / persistent KV cache | Both off, with separate explicit opt-ins |
| Retained Worker logs | Off |

Rate limits cover preflights and the info page too. Missing or failed rate-limit bindings return 503. These counters are approximate and local to each Cloudflare location, **not a global quota or spending cap**. Shared networks may hit the client limit together, and distributed attacks may reach several locations. Assign the two `namespace_id` values uniquely within your account to avoid sharing counters with another Worker. See [rate-limit binding behavior](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

Only HTTP(S) DNS names on standard ports are accepted. IP literals, obvious local hostnames, URL credentials, direct self-proxy calls, and unsafe redirects are rejected. Redirects are checked at every hop; credentials are stripped on cross-origin redirects. This is URL validation, not DNS pinning or a complete SSRF boundary: arbitrary domains and aliases remain available by design. To restrict destinations, set `ALLOWED_TARGET_HOSTS` to a JSON array of exact hostnames. Do not give this Worker private-network/VPC bindings or access to internal services.

Writes are never replayed to another server, upstream 429 responses are returned without retrying, and backup redirects are blocked. Proxied pages are sandboxed and cannot set cookies on the proxy origin. Responses are not cached. Streams exceeding the byte/time limit fail midstream after headers have been sent; long SSE sessions must reconnect within 30 seconds.

Before deploying, verify Workers Free in the account dashboard, remove any paid backup credentials, and review retained Dashboard variables because `keep_vars = true` preserves them. Keep `ENABLE_BACKUP_FALLBACK` and `ENABLE_BACKUP_KV` unset or `false`. `workers_dev` and preview URLs are disabled; configure a custom domain or route and add an edge rate-limiting rule there to reject excess traffic before it invokes the Worker. The rule's availability and thresholds depend on the zone plan. Repository changes do not configure that rule or verify the live account.

If the account is upgraded to Workers Paid, this project no longer provides a no-charge boundary. Worker-level rejections still execute the Worker; CPU limits and rate limits do not cap total request charges. [Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/) notify but do not stop spending. Third-party backups have their own billing independently of the Cloudflare plan.

## Deployment

This project is written in [Cloudflare Workers](https://workers.cloudflare.com/), and can be easily deployed with [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/).

### Prerequisites

1. **Cloudflare Account**: Sign up for a free account at [cloudflare.com](https://www.cloudflare.com/)
2. **Node.js**: Ensure you have Node.js installed (v16 or higher recommended)
3. **Wrangler CLI**: Install Wrangler globally or use it via npm scripts

### Installation

1. **Install dependencies**:

    ```bash
    npm install
    ```

2. **Install Wrangler CLI** (if not already installed):
    ```bash
    npm install -g wrangler
    ```
    Or use it via npx without global installation:
    ```bash
    npx wrangler
    ```

### Authentication

1. **Login to Cloudflare**:

    ```bash
    wrangler login
    ```

    This will open your browser to authenticate with Cloudflare.

2. **Verify your account**:
    ```bash
    wrangler whoami
    ```

### Configuration

The `wrangler.toml` file contains the basic configuration:

-   `name`: Your worker name (currently "cloudflare-cors-anywhere")
-   `main`: Entry point file (index.js)
-   `compatibility_date`: Cloudflare Workers API version
-   `observability`: Retained logging disabled for the public deployment
-   `ratelimits`: Required client and shared throttling bindings
-   `version_metadata`: Version metadata binding for deployment tracking

You can customize the worker name and rate-limit thresholds in `wrangler.toml`. These settings do not select the account's billing plan.

#### Version Information

The worker automatically tracks version information from multiple sources (in priority order):
1. **Cloudflare Version Metadata** (if using Workers Versions API)
2. **VERSION environment variable** (set via `wrangler.toml` [vars] or `wrangler secret put VERSION`)
3. **Package version** (from `package.json`)

Version information is displayed in:
- Logs (for debugging and tracking)
- Info page (when accessing the worker without a target URL)

The deployment script (`npm run deploy`) automatically sets the VERSION environment variable from `package.json`.

#### Whitelist and Blacklist Configuration

You can configure URL blacklists and origin whitelists using **Cloudflare Secrets** (recommended) or environment variables.

**Using Cloudflare Secrets (Recommended):**

Secrets are secure, encrypted, and not stored in your codebase. Set them using the Wrangler CLI:

```bash
# Set blacklist URLs (JSON array of regex patterns)
wrangler secret put BLACKLIST_URLS
# When prompted, paste: ["^https?://malicious\\.com", "^https?://.*\\.spam\\.com"]

# Set whitelist origins (JSON array of regex patterns)
wrangler secret put WHITELIST_ORIGINS
# When prompted, paste: ["^https://example\\.com$", "^https://.*\\.example\\.com$"]

# Set backup CORS servers (JSON array of backup proxy URLs/config objects)
wrangler secret put BACKUP_CORS_SERVERS
# When prompted, paste: [{"url":"https://backup-1.workers.dev/?url={url}","headers":{"x-cors-api-key":"YOUR_BACKUP_TOKEN"}},"https://backup-2.workers.dev/?url={url}"]

# Set retry attempts after first try (non-negative integer)
wrangler secret put MAX_RETRY_ATTEMPTS
# When prompted, paste: 0
```

**View/Update Secrets:**

```bash
# View list of all secrets (names only, not values)
wrangler secret list

# Update a secret
wrangler secret put BLACKLIST_URLS

# Delete a secret
wrangler secret delete BLACKLIST_URLS
```

**Configuration Format:**

- **BLACKLIST_URLS**: JSON array of regex patterns for URLs to block
  - Example: `["^https?://malicious\\.com", "^https?://.*\\.phishing\\.net"]`
  - Empty array `[]` means no URLs are blacklisted (default)

- **WHITELIST_ORIGINS**: JSON array of regex patterns for allowed origins
  - Example: `["^https://myapp\\.com$", "^https://.*\\.myapp\\.com$"]`
  - Default: `[".*"]` (all origins, including requests without Origin, allowed)
  - Invalid access-rule JSON or regexes reject requests with 503
  - A restrictive list also rejects a missing Origin unless a rule explicitly matches the empty string
  - Origin headers are spoofable outside browsers; this is a CORS policy, not authentication

- **ALLOWED_TARGET_HOSTS**: Optional JSON array of exact allowed destination hostnames (also checked on redirects)
  - Example: `["api.example.com"]`
  - Default: `[]` (any otherwise permitted public DNS name)

- **ENABLE_BACKUP_FALLBACK**: Must be the string `true` to use configured backup servers
  - Default: disabled, even if `BACKUP_CORS_SERVERS` exists in the Dashboard
  - Enabling it exposes the owner's backup quota/credits to every public caller

- **ENABLE_BACKUP_KV**: Must be the string `true` to use a `BACKUP_SERVER_CACHE` KV binding
  - Default: disabled; the checked-in deployment has no KV binding

- **BACKUP_CORS_SERVERS**: JSON array of backup CORS proxy server URL templates or config objects
  - Format: backup URL template must include `{url}` placeholder
  - String example: `"https://backup.server.com/?url={url}"`
  - Object example (with backup-specific headers): `{"url":"https://backup.server.com/?url={url}","headers":{"x-cors-api-key":"YOUR_BACKUP_TOKEN"}}`
  - Header behavior: object `headers` apply only when routing through that backup server
  - Also supports URL-encoded placeholder form: `%7Burl%7D`
  - Runtime behavior: worker replaces `{url}` with the actual target URL
  - Accepted input formats:
    - JSON array (recommended): `["https://a/?url={url}",{"url":"https://b/?url={url}","headers":{"x-cors-api-key":"token"}}]`
    - Quoted list: `"https://a/?url={url}","https://b/?url={url}"`
    - Comma/newline-separated URLs
  - Smart routing: caches the preferred server in memory for 15 minutes; persistence requires explicit KV opt-in
  - Auto cleanup: stale preferred entries are cleared when the cached server is removed from `BACKUP_CORS_SERVERS` or when that preferred server fails (network error / retryable status)
  - Used when direct destination fetch fails or returns retryable status (`403`, `502`, `503`) for GET/HEAD only
  - Backup servers and the KV lookup are only touched after the direct attempt fails
  - Default: `[]` (disabled)
  - Legacy compatibility: `DEFAULT_BACKUP_CORS_SERVERS` is also accepted, but deprecated

- **MAX_RETRY_ATTEMPTS**: Non-negative integer for retry count after the first direct attempt
  - Example: `1`
  - Default: `0`; values are clamped to at most `2`
  - At most two configured backups participate. All redirects, backups and retries share a hard budget of three upstream fetches
  - Only GET/HEAD may be retried or failed over. A 403 is never repeated against the same target; 429 is never retried

**Alternative: Environment Variables (wrangler.toml)**

For non-sensitive configuration, you can use the `[vars]` section in `wrangler.toml`:

```toml
[vars]
BLACKLIST_URLS = '["^https?://malicious\\.com"]'
WHITELIST_ORIGINS = '["^https://example\\.com$"]'
BACKUP_CORS_SERVERS = '[{"url":"https://backup-1.workers.dev/?url={url}","headers":{"x-cors-api-key":"YOUR_BACKUP_TOKEN"}},"https://backup-2.workers.dev/?url={url}"]'
MAX_RETRY_ATTEMPTS = '0'
```

Only if you deliberately enable persistent backup caching, add an existing KV namespace binding and set `ENABLE_BACKUP_KV=true`:

```toml
[[kv_namespaces]]
binding = "BACKUP_SERVER_CACHE"
id = "YOUR_EXISTING_NAMESPACE_ID"
```

**Note:** Secrets take precedence over `[vars]` if both are set.

### Deploy to Cloudflare

1. **Deploy the worker**:

    ```bash
    npm run deploy
    ```

    This command automatically:
    - Updates the version file from `package.json`
    - Sets the VERSION environment variable during deployment
    - Deploys to Cloudflare Workers

    Alternatively, you can use Wrangler directly:

    ```bash
    wrangler deploy
    ```

    Or if using the older command:

    ```bash
    wrangler publish
    ```

2. **Configure a custom domain or route.** The checked-in configuration disables `workers.dev` and preview URLs. If you explicitly enable `workers.dev`, Wrangler provides a URL like:
    ```
    https://cloudflare-cors-anywhere.YOUR_SUBDOMAIN.workers.dev
    ```

### Custom Domain (Optional)

If you want to use a custom domain:

1. Add your domain to Cloudflare
2. Update `wrangler.toml` with route configuration:
    ```toml
    routes = [
      { pattern = "cors.yourdomain.com", custom_domain = true }
    ]
    ```
3. Deploy again with `wrangler deploy`

### Verify Deployment

Test your configured custom-domain URL in a browser. The `workers.dev` examples below apply only if that endpoint is explicitly enabled:

```
https://YOUR_WORKER_NAME.YOUR_SUBDOMAIN.workers.dev
```

You should see the CORS proxy information page. Then test with an actual request using either URL format:

```bash
# Using the new URL parameter format (recommended)
curl "https://YOUR_WORKER_NAME.YOUR_SUBDOMAIN.workers.dev/?url=https://httpbin.org/get"

# Or using the legacy format (still supported)
curl "https://YOUR_WORKER_NAME.YOUR_SUBDOMAIN.workers.dev/?https://httpbin.org/get"
```

### Updating the Worker

To update your worker after making changes:

```bash
npm run deploy
```

This will automatically update the version and deploy. Alternatively:

```bash
wrangler deploy
```

### Logging

Retained observability is disabled by default. Temporary live diagnostics are available with `npm run logs` or `npm run logs:json`. Application logs include blocked requests, backup selection, and upstream connection failures. Known secret-looking URL parameters are redacted, but arbitrary query values can still contain private data; avoid recording public traffic unnecessarily. Do not assume retained logging is always free on every account plan.

### Troubleshooting

-   **Authentication issues**: Run `wrangler login` again
-   **Deployment errors**: Check that your `wrangler.toml` is valid
-   **Worker not responding**: Verify the worker is active in the Cloudflare dashboard

## Usage

### URL Formats

The worker supports two URL formats for specifying the target URL:

1. **URL Parameter Format (Recommended)**: `?url={targetUrl}`
   - More explicit and easier to use
   - Example: `https://your-worker.workers.dev/?url=https://api.example.com/data`

2. **Legacy Format (Backward Compatible)**: `?{targetUrl}`
   - Original format, still fully supported
   - Example: `https://your-worker.workers.dev/?https://api.example.com/data`

Both formats are fully supported and can be used interchangeably.

**Note**: URLs without a protocol (e.g., `api.example.com/data`) will automatically have `https://` prepended.

### HTTP Methods

All standard HTTP methods are supported:
- `GET` - Retrieve data
- `POST` - Send data
- `PUT` - Update/replace data
- `DELETE` - Delete data
- `PATCH` - Partial update
- `HEAD` - Get headers only
- `OPTIONS` - CORS preflight (handled automatically)

### Usage Examples

#### Basic GET Request

```javascript
// Simple GET request
fetch("https://your-worker.workers.dev/?url=https://api.example.com/data")
    .then(res => res.json())
    .then(console.log);
```

#### POST Request with Custom Headers

```javascript
// Using the URL parameter format (recommended)
fetch("https://your-worker.workers.dev/?url=https://httpbin.org/post", {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        "x-foo": "bar",
        "x-bar": "foo",
        "x-cors-headers": JSON.stringify({
            // allows to send forbidden headers
            // https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_header_name
            Cookie: "session=abc123"
        })
    },
    body: JSON.stringify({ key: "value" })
})
    .then(res => {
        // allows to read all headers (even forbidden headers like set-cookie)
        const headers = JSON.parse(res.headers.get("cors-received-headers"));
        console.log("Response headers:", headers);
        return res.json();
    })
    .then(console.log);
```

#### Using Legacy Format

```javascript
// Using the legacy format (still supported)
fetch("https://your-worker.workers.dev/?https://httpbin.org/post", {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        "x-foo": "bar"
    },
    body: JSON.stringify({ data: "test" })
})
    .then(res => res.json())
    .then(console.log);
```

#### URL Without Protocol (Auto-prepends https://)

```javascript
// URL without protocol - automatically prepends https://
fetch("https://your-worker.workers.dev/?url=api.example.com/data")
    .then(res => res.json())
    .then(console.log);
// This is equivalent to: ?url=https://api.example.com/data
```

#### PUT/PATCH/DELETE Requests

```javascript
// PUT request
fetch("https://your-worker.workers.dev/?url=https://api.example.com/resource/123", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Updated Name" })
})
    .then(res => res.json())
    .then(console.log);

// DELETE request
fetch("https://your-worker.workers.dev/?url=https://api.example.com/resource/123", {
    method: "DELETE"
})
    .then(res => res.json())
    .then(console.log);
```

### Features

- **Header Exposure**: All received headers are returned in the `cors-received-headers` header for easy access (including forbidden headers like `set-cookie`)
- **Custom Headers**: Use the `x-cors-headers` header to send custom headers (including forbidden headers like `Cookie`)
- **CORS Support**: Automatically handles CORS preflight (OPTIONS) requests with 24-hour caching
- **Browser Fingerprint Rotation**: Automatically rotates between realistic browser fingerprints (Chrome, Firefox, Safari) to reduce bot detection
- **URL Auto-normalization**: Automatically prepends `https://` to URLs without a protocol
- **URL Validation**: Validates and normalizes target URLs before making requests
- **Request Body Forwarding**: Properly forwards request bodies for POST, PUT, PATCH, and other methods
- **Streaming Responses**: Upstream bodies are streamed straight through (never buffered), so SSE, AI streaming APIs and large downloads work with low latency
- **Backup CORS Failover**: Retries with backup CORS servers when direct requests fail or return retryable status (`403`, `502`, `503`) for GET/HEAD only
- **Backup Security Guard**: If request contains sensitive headers (`Cookie`, `Authorization`, `Proxy-Authorization`, `X-API-Key`, `Api-Key`, `X-Auth-Token`, `X-Access-Token`), backup servers are skipped and only the direct target is used
  - Override: append `?allowSensitive=true` to allow backup usage even when sensitive headers exist
- **All HTTP Methods**: Supports GET, POST, PUT, DELETE, PATCH, HEAD, and OPTIONS
- **Preflight Caching**: Caches CORS preflight responses for 24 hours to reduce overhead

## Bot Detection & Limitations

### Why Some Sites Block Requests

Some websites (like Google) use advanced bot detection that can block requests from Cloudflare Workers. This happens because:

1. **IP Reputation**: Cloudflare Workers use data center IPs that are often flagged
2. **TLS Fingerprinting**: Cloudflare's TLS signature can be detected
3. **No JavaScript Execution**: Workers can't execute JavaScript challenges
4. **No Headless Browsers**: Can't use Puppeteer/Playwright to simulate real browsers

### Solutions for Blocked Sites

If you encounter bot detection (e.g., Cloudflare challenges, reCAPTCHA, or "unusual traffic" messages):

#### Option 1: Use External Scraping Services (Recommended)
Chain requests through services that handle bot detection:

```javascript
// Example: Using ScrapingBee
const scrapingBeeUrl = `https://app.scrapingbee.com/api/v1/?api_key=YOUR_KEY&url=${encodeURIComponent(targetUrl)}`;
fetch(`https://your-worker.workers.dev/?url=${encodeURIComponent(scrapingBeeUrl)}`);

// Example: Using ScraperAPI
const scraperApiUrl = `http://api.scraperapi.com?api_key=YOUR_KEY&url=${encodeURIComponent(targetUrl)}`;
fetch(`https://your-worker.workers.dev/?url=${encodeURIComponent(scraperApiUrl)}`);
```

**Popular Services:**
- [ScrapingBee](https://www.scrapingbee.com/) - Handles JavaScript rendering and bot detection
- [ScraperAPI](https://www.scraperapi.com/) - Residential proxies and browser automation
- [Bright Data](https://brightdata.com/) - Enterprise-grade proxy network
- [Oxylabs](https://oxylabs.io/) - Premium proxy and scraping solutions

#### Option 2: Use Official APIs
For Google and other major services, use their official APIs:
- [Google Custom Search API](https://developers.google.com/custom-search/v1/overview)
- [Google Search API](https://serpapi.com/) (third-party)
- Check the target website's developer documentation

#### Option 3: Deploy on Different Platform
For sites requiring headless browsers, deploy on platforms that support them:
- **Vercel/Netlify Functions** with Puppeteer
- **AWS Lambda** with headless Chrome
- **Railway/Render** with full Node.js environment

### Current Bot Detection Mitigations

This worker includes several techniques to reduce bot detection:
- ✅ Realistic browser headers (Chrome, Firefox, Safari)
- ✅ Proper `Sec-Fetch-*` headers
- ✅ Referer header simulation
- ✅ Browser fingerprint rotation
- ✅ Platform-specific headers

However, these may not be sufficient for sites with advanced detection (like Google).

Note about the DEMO url:

Abuse (other than testing) of the demo will result in a ban.  
The demo accepts only fetch and xmlhttprequest.

To create your own is very easy, you just need to set up a cloudflare account and upload the worker code.
