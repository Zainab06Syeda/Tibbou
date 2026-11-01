const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

let chromium;
try {
  ({ chromium } = require(process.env.TIBBOU_PLAYWRIGHT_MODULE || 'playwright'));
} catch {
  throw new Error('An installed Playwright runtime is required. See test/browser/README.md; no dependency is installed automatically.');
}

const frontend = path.resolve(__dirname, '../..');
const authOrigin = 'https://sso-test.supabase.invalid';
const storageKey = 'sb-sso-test-auth-token';
const providerId = '30000000-0000-0000-0000-000000000001';
const organization = { id: '20000000-0000-0000-0000-000000000001', name: 'Test workspace', slug: 'acme', role: 'viewer', created_at: '2026-01-01T00:00:00Z' };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(check) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'Expected fixture request did not arrive');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function user(provider) {
  return { id: '10000000-0000-0000-0000-000000000001', email: 'member@example.invalid',
    aud: 'authenticated', role: 'authenticated', app_metadata: { provider, providers: [provider] },
    identities: [{ user_id: '10000000-0000-0000-0000-000000000001', provider }],
    user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
}

// Generated only in memory: the fixtures never authenticate with a real service.
function session(provider) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const account = user(provider);
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return { access_token: `${encode({ alg: 'ES256', typ: 'JWT' })}.${encode({ sub: account.id, exp, role: 'authenticated' })}.synthetic`,
    refresh_token: 'synthetic-browser-fixture', token_type: 'bearer', expires_in: 3600, expires_at: exp, user: account };
}

async function startServer(enabled) {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, [path.join(frontend, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: frontend, windowsHide: true,
    env: { ...process.env, VITE_SUPABASE_URL: authOrigin, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_browser_fixture',
      VITE_ENABLE_OKTA_SSO: String(enabled), VITE_ENABLE_ENTRA_SSO: String(enabled), VITE_API_BASE_URL: '/api',
      VITE_API_PROXY_TARGET: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output = (output + data).slice(-2000); });
  child.stderr.on('data', data => { output = (output + data).slice(-2000); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('Test Vite server exited: ' + output);
      try { if ((await fetch(base, { signal: AbortSignal.timeout(1000) })).ok) return { child, base }; }
      catch { /* Wait for this test server, never attach to another checkout. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Test Vite server did not start: ' + output);
  } catch (error) {
    child.kill();
    throw error;
  }
}

async function start() {
  const servers = [];
  let browser;
  try {
    servers.push(await startServer(true));
    servers.push(await startServer(false));
    browser = await chromium.launch({ headless: true, ...(process.env.TIBBOU_BROWSER_CHANNEL ? { channel: process.env.TIBBOU_BROWSER_CHANNEL } : {}) });
    return { browser, enabled: servers[0].base, disabled: servers[1].base,
      async close() { await browser.close(); servers.forEach(server => server.child.kill()); } };
  } catch (error) {
    if (browser) await browser.close();
    servers.forEach(server => server.child.kill());
    throw error;
  }
}

async function fixture(browser, base, options = {}) {
  const state = { provider: `sso:${providerId}`, organizations: [], invitations: [], lookupStatus: 200,
    organizationStatus: 200, connectionStatus: 200, tokenStatus: 200, logoutStatus: 200, ...options };
  const context = await browser.newContext({ viewport: options.viewport || { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const calls = [];
  const errors = [];
  const unexpected = [];
  let closing = false;
  if (options.savedSession) await context.addInitScript(({ key, value }) => {
    if (!sessionStorage.getItem('browser-fixture-seeded')) {
      localStorage.setItem(key, JSON.stringify(value));
      sessionStorage.setItem('browser-fixture-seeded', 'true');
    }
  }, { key: storageKey, value: session(state.provider) });

  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    try {
      if (url.origin === authOrigin) {
        calls.push({ path: url.pathname, query: url.searchParams, body: request.postDataJSON(), headers: request.headers() });
        if (url.pathname.endsWith('/sso')) {
          if (state.ssoReply) return await state.ssoReply(route);
          return await route.fulfill({ json: { url: `${base}/auth/callback?code=synthetic-code` } });
        }
        if (url.pathname.endsWith('/token')) return await route.fulfill({ status: state.tokenStatus,
          json: state.tokenStatus === 200 ? session(state.provider) : { msg: 'Synthetic rejected code', code: 'bad_code_verifier' } });
        if (url.pathname.endsWith('/signup')) return await route.fulfill({ json: user(state.provider) });
        if (url.pathname.endsWith('/user')) return await route.fulfill({ json: user(state.provider) });
        if (url.pathname.endsWith('/logout')) {
          if (state.logoutReply) return await state.logoutReply(route);
          return await route.fulfill({ status: state.logoutStatus, json: state.logoutStatus === 200 ? {} : { msg: 'Private fixture detail', code: 'unexpected_failure' } });
        }
        if (url.pathname.endsWith('/authorize')) return await route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic Microsoft provider</h1>' });
      } else if (url.origin === base) {
        if (url.pathname.startsWith('/api/')) {
          const apiPath = url.pathname.slice(4);
          calls.push({ path: apiPath, method: request.method(), headers: request.headers() });
          if (apiPath.endsWith('/sso')) {
            if (state.lookupReply) return await state.lookupReply(route);
            return await route.fulfill({ status: state.lookupStatus,
              json: state.lookupStatus === 200 ? { provider_id: providerId, idp: 'okta' } : { detail: 'Organization sign-in is unavailable' } });
          }
          if (apiPath === '/api/v1/organizations') {
            if (state.organizationReply) return await state.organizationReply(route);
            return await route.fulfill({ status: state.organizationStatus,
              json: state.organizationStatus === 200 ? state.organizations : { detail: 'Private fixture detail' } });
          }
          if (apiPath === '/api/v1/invitations') return await route.fulfill({ json: state.invitations });
          if (apiPath === '/api/v1/organizations/domain-match') return await route.fulfill({ json: { organization: null, allow_domain_join: false, already_requested: false } });
          if (apiPath.endsWith('/snowflake-connections')) return await route.fulfill({ status: state.connectionStatus,
            json: state.connectionStatus === 200 ? [] : { detail: 'Private fixture detail' } });
          if (apiPath === '/health') return await route.fulfill({ json: { status: 'ok' } });
          if (['/datasets', '/lineage', '/costs'].some(suffix => apiPath === `/api/v1/organizations/${organization.id}${suffix}`)) return await route.fulfill({ json: [] });
        } else if (state.strict && request.isNavigationRequest()) {
          const response = await route.fetch();
          const body = await response.text();
          assert.ok(body.includes('/src/main.jsx'), 'Strict Mode test must replace the real application entry');
          return await route.fulfill({ response, body: body.replace('/src/main.jsx', '/test/browser/strict-entry.jsx') });
        } else {
          return await route.continue();
        }
      } else if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) {
        return await route.abort();
      }
      unexpected.push(url.origin + url.pathname);
      await route.abort();
    } catch (error) {
      if (!closing) unexpected.push(error.message);
      await route.abort().catch(() => {});
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  page.on('pageerror', error => errors.push(error.message));
  return { state, page, context, calls,
    count: suffix => calls.filter(call => call.path === suffix).length,
    async login(slug = 'acme') {
      await page.goto(base + '/login');
      await page.getByRole('button', { name: 'Continue with Okta', exact: true }).click();
      await page.getByLabel('Organization slug').fill(slug);
      await page.getByRole('button', { name: 'Sign in with Okta', exact: true }).click();
    },
    async capture(name) {
      if (!process.env.TIBBOU_BROWSER_ARTIFACTS) return;
      fs.mkdirSync(process.env.TIBBOU_BROWSER_ARTIFACTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.TIBBOU_BROWSER_ARTIFACTS, name + '.png'), fullPage: true });
    },
    async close() {
      closing = true;
      await context.close();
      assert.deepEqual(errors, [], 'Unexpected browser errors');
      assert.deepEqual(unexpected, [], 'Unexpected or unmocked requests');
    },
  };
}

module.exports = { start, fixture, until, deferred, providerId, organization, storageKey };
