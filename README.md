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
-   `observability`: Logging configuration (enabled by default with 100% sampling rate)
-   `version_metadata`: Version metadata binding for deployment tracking

You can customize the worker name in `wrangler.toml` if desired. The observability section enables free logging with:
- **Free Tier**: 200,000 log events per day with 3-day retention
- **Sampling Rate**: 100% (all requests are logged)

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
# When prompted, paste: [{"url":"https://backup-1.workers.dev/?url={url}","headers":{"x-cors-api-key":"temp_cf7e8e6dd6b319e39385f2f9396804aa"}},"https://backup-2.workers.dev/?url={url}"]

# Set retry attempts after first try (non-negative integer)
wrangler secret put MAX_RETRY_ATTEMPTS
# When prompted, paste: 3
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
  - Default: `[".*"]` (all origins allowed)

- **BACKUP_CORS_SERVERS**: JSON array of backup CORS proxy server URL templates or config objects
  - Format: backup URL template must include `{url}` placeholder
  - String example: `"https://backup.server.com/?url={url}"`
  - Object example (with backup-specific headers): `{"url":"https://backup.server.com/?url={url}","headers":{"x-cors-api-key":"temp_cf7e8e6dd6b319e39385f2f9396804aa"}}`
  - Header behavior: object `headers` apply only when routing through that backup server
  - Also supports URL-encoded placeholder form: `%7Burl%7D`
  - Runtime behavior: worker replaces `{url}` with the actual target URL
  - Accepted input formats:
    - JSON array (recommended): `["https://a/?url={url}",{"url":"https://b/?url={url}","headers":{"x-cors-api-key":"token"}}]`
    - Quoted list: `"https://a/?url={url}","https://b/?url={url}"`
    - Comma/newline-separated URLs
  - Smart routing: when a backup server succeeds, worker stores it in KV for 15 minutes per target domain and prioritizes it first during that window
  - Auto cleanup: stale preferred entries are deleted when the cached server is removed from `BACKUP_CORS_SERVERS` or when that preferred server fails (network error / retryable status)
  - Used when direct destination fetch fails or returns retryable status (all `4xx` + `502`/`503`)
  - Default: `[]` (disabled)
  - Legacy compatibility: `DEFAULT_BACKUP_CORS_SERVERS` is also accepted, but deprecated

- **MAX_RETRY_ATTEMPTS**: Non-negative integer for retry count after the first direct attempt
  - Example: `3`
  - Default: `3`

**Alternative: Environment Variables (wrangler.toml)**

For non-sensitive configuration, you can use the `[vars]` section in `wrangler.toml`:

```toml
[vars]
BLACKLIST_URLS = '["^https?://malicious\\.com"]'
WHITELIST_ORIGINS = '["^https://example\\.com$"]'
BACKUP_CORS_SERVERS = '[{"url":"https://backup-1.workers.dev/?url={url}","headers":{"x-cors-api-key":"temp_cf7e8e6dd6b319e39385f2f9396804aa"}},"https://backup-2.workers.dev/?url={url}"]'
MAX_RETRY_ATTEMPTS = '3'
```

Also add a KV namespace binding (required for preferred-backup cache):

```toml
[[kv_namespaces]]
binding = "BACKUP_SERVER_CACHE"
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

2. **After deployment**, Wrangler will provide you with a URL like:
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

Test your deployed worker by accessing it in a browser:

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

This project includes comprehensive logging that is **completely free** using Cloudflare Workers' built-in console logging. Logging is enabled in `wrangler.toml` via the `observability` section, which is configured to log 100% of requests.

#### View Real-Time Logs

Use Wrangler's tail command to view real-time logs from your deployed worker:

```bash
npm run logs
```

Or view logs in JSON format:

```bash
npm run logs:json
```

#### What Gets Logged

The worker logs the following information:

- **Request Information**: Method, path, origin, IP address, country, datacenter location
- **Target URLs**: All proxy requests with target URLs
- **Success Logs**: Successful requests with status codes and response times
- **Error Logs**: Failed requests with detailed error messages and stack traces
- **Info Requests**: When users access the info page
- **Blocked Requests**: When requests are blocked by whitelist/blacklist rules

#### View Logs in Cloudflare Dashboard

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Navigate to **Workers & Pages**
3. Select your worker
4. Click on **Logs** tab to view historical logs

**Note**: Logs are available for free in the Cloudflare Dashboard. Real-time logs via `wrangler tail` are also free and show logs as they happen.

#### Log Format

Logs include timestamps (ISO format), emojis for easy visual scanning:
- ✅ Success
- ❌ Error
- ⚠️ Warning
- ℹ️ Info

Example log output:
```
[2024-01-15T10:30:45.123Z] GET /?url=https://api.example.com/data | Origin: https://example.com | IP: 192.168.1.1 | Country: US | Colo: LAX
[2024-01-15T10:30:45.456Z] Fetching target URL: https://api.example.com/data
[2024-01-15T10:30:45.789Z] ✅ Success: https://api.example.com/data | Status: 200 | Duration: 333ms | Method: GET
```

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
- **Backup CORS Failover**: Retries with backup CORS servers when direct requests fail or return retryable status (all `4xx` + `502`/`503`)
- **Backup Security Guard**: If request contains sensitive headers (e.g. `Authorization`, `Cookie`, `X-API-Key`), backup proxy path is blocked and returns `403`
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
