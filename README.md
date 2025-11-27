# cloudflare-cors-anywhere

Cloudflare CORS proxy in a worker.

CLOUDFLARE-CORS-ANYWHERE

Authors:

-   rozx (maintainer)
-   Zibri (original author)

Source:
https://github.com/rozx/cloudflare-cors-anywhere

Original source:
https://github.com/Zibri/cloudflare-cors-anywhere

Demo:
https://test.cors.workers.dev

Donate:
https://paypal.me/Zibri/5

Post:
http://www.zibri.org/2019/07/your-own-cors-anywhere-proxy-on.html

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

You can customize the worker name in `wrangler.toml` if desired.

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

You should see the CORS proxy information page. Then test with an actual request:

```bash
curl "https://YOUR_WORKER_NAME.YOUR_SUBDOMAIN.workers.dev/?https://httpbin.org/get"
```

### Updating the Worker

To update your worker after making changes:

```bash
wrangler deploy
```

### Troubleshooting

-   **Authentication issues**: Run `wrangler login` again
-   **Deployment errors**: Check that your `wrangler.toml` is valid
-   **Worker not responding**: Verify the worker is active in the Cloudflare dashboard

## Usage Example

```javascript
fetch("https://test.cors.workers.dev/?https://httpbin.org/post", {
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
```

Note:

All received headers are also returned in "cors-received-headers" header.

Note about the DEMO url:

Abuse (other than testing) of the demo will result in a ban.  
The demo accepts only fetch and xmlhttprequest.

To create your own is very easy, you just need to set up a cloudflare account and upload the worker code.
