# cloudflare-cors-anywhere

Cloudflare CORS proxy in a worker. This worker enables cross-origin requests by acting as a proxy, automatically adding the necessary CORS headers to responses.

**Quick Start**: Use `?url={targetUrl}` format:
```
https://your-worker.workers.dev/?url=https://api.example.com/data
```

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

You can customize the worker name in `wrangler.toml` if desired. The observability section enables free logging with:
- **Free Tier**: 200,000 log events per day with 3-day retention
- **Sampling Rate**: 100% (all requests are logged)

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

**Alternative: Environment Variables (wrangler.toml)**

For non-sensitive configuration, you can use the `[vars]` section in `wrangler.toml`:

```toml
[vars]
BLACKLIST_URLS = '["^https?://malicious\\.com"]'
WHITELIST_ORIGINS = '["^https://example\\.com$"]'
```

**Note:** Secrets take precedence over `[vars]` if both are set.

### Deploy to Cloudflare

1. **Deploy the worker**:

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

### Usage Example

```javascript
// Using the URL parameter format (recommended)
fetch("https://test.cors.workers.dev/?url=https://httpbin.org/post", {
    method: "post",
    headers: {
        "x-foo": "bar",
        "x-bar": "foo",
        "x-cors-headers": JSON.stringify({
            // allows to send forbidden headers
            // https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_header_name
            cookies: "x=123"
        })
    }
})
    .then(res => {
        // allows to read all headers (even forbidden headers like set-cookies)
        const headers = JSON.parse(res.headers.get("cors-received-headers"));
        console.log(headers);
        return res.json();
    })
    .then(console.log);

// Using the legacy format (still supported)
fetch("https://test.cors.workers.dev/?https://httpbin.org/post", {
    method: "post",
    headers: {
        "x-foo": "bar",
        "x-bar": "foo"
    }
})
    .then(res => res.json())
    .then(console.log);
```

### Features

- **Header Exposure**: All received headers are returned in the `cors-received-headers` header for easy access
- **Custom Headers**: Use the `x-cors-headers` header to send custom headers (including forbidden headers like cookies)
- **CORS Support**: Automatically handles CORS preflight (OPTIONS) requests
- **Browser Fingerprint Rotation**: Automatically rotates between realistic browser fingerprints to reduce bot detection

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
