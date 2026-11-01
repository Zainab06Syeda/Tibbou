const assert = require('node:assert/strict');
const { test, before, after, afterEach } = require('node:test');
const { start, fixture, until, deferred, providerId, organization, storageKey } = require('./fixture.cjs');

let runtime;
const openFixtures = [];
before(async () => { runtime = await start(); });
after(async () => { if (runtime) await runtime.close(); });
afterEach(async () => { while (openFixtures.length) await openFixtures.pop().close(); });

async function app(options = {}, enabled = true) {
  const current = await fixture(runtime.browser, enabled ? runtime.enabled : runtime.disabled, options);
  openFixtures.push(current);
  return current;
}
const waitingForInvitation = 'Ask your organization administrator to invite this SSO account, then refresh this page.';
const recovery = page => page.getByRole('heading', { name: 'Unable to load your workspace' });

test('password login restores its session and logs out', async () => {
  const f = await app({ provider: 'email' });
  await f.page.goto(runtime.enabled + '/login');
  await f.page.getByLabel('Work email').fill('member@example.invalid');
  await f.page.getByLabel('Password', { exact: true }).fill('Synthetic fixture password');
  await f.page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await f.page.getByRole('button', { name: 'Create a new organization' }).waitFor();
  const request = f.calls.find(call => call.path.endsWith('/token'));
  assert.equal(request.query.get('grant_type'), 'password');
  assert.equal(request.body.email, 'member@example.invalid');
  await f.page.reload();
  await f.page.getByRole('button', { name: 'Create a new organization' }).waitFor();
  await f.page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await f.page.getByRole('heading', { name: 'Welcome back' }).waitFor();
  await f.page.reload();
  await f.page.getByRole('heading', { name: 'Welcome back' }).waitFor();
});

test('password signup asks for email confirmation without creating a session', async () => {
  const f = await app({ provider: 'email' });
  await f.page.goto(runtime.enabled + '/login');
  await f.page.getByRole('button', { name: 'Create account', exact: true }).first().click();
  await f.page.getByLabel('Work email').fill('member@example.invalid');
  await f.page.getByLabel('Password', { exact: true }).fill('Synthetic fixture password');
  await f.page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await f.page.getByRole('status').filter({ hasText: 'Check your email' }).waitFor();
  assert.equal(f.count('/auth/v1/signup'), 1);
  assert.equal(f.count('/api/v1/organizations'), 0);
});

test('Microsoft uses Azure, email scope and the existing PKCE callback', async () => {
  const f = await app();
  await f.page.goto(runtime.enabled + '/login');
  await f.page.getByRole('button', { name: 'Continue with Microsoft' }).click();
  await f.page.getByRole('heading', { name: 'Synthetic Microsoft provider' }).waitFor();
  const request = f.calls.find(call => call.path.endsWith('/authorize'));
  assert.equal(request.query.get('provider'), 'azure');
  assert.equal(request.query.get('scopes'), 'email');
  assert.equal(request.query.get('redirect_to'), runtime.enabled + '/auth/callback');
  assert.ok(request.query.get('code_challenge'));
});

test('disabled provider controls make no discovery or authentication requests', async () => {
  const f = await app({}, false);
  await f.page.goto(runtime.disabled + '/login');
  const okta = f.page.getByRole('button', { name: 'Okta — Coming soon' });
  await okta.waitFor();
  assert.equal(await okta.isDisabled(), true);
  assert.equal(await f.page.getByRole('button', { name: 'Microsoft Entra ID — Not enabled' }).isDisabled(), true);
  assert.equal(f.calls.length, 0);
  assert.equal(await f.page.getByLabel('Organization slug').count(), 0);
  assert.equal(await f.page.getByText(/Forgot password/i).count(), 0);
});

test('Okta disclosure waits for submission and routes the exact provider', async () => {
  const f = await app();
  await f.page.goto(runtime.enabled + '/login');
  assert.equal(await f.page.getByLabel('Organization slug').isVisible(), false);
  await f.page.getByRole('button', { name: 'Continue with Okta', exact: true }).click();
  assert.equal(await f.page.getByLabel('Organization slug').evaluate(input => input === document.activeElement), true);
  assert.equal(f.calls.length, 0);
  await f.page.getByLabel('Organization slug').fill('acme');
  await f.page.getByRole('button', { name: 'Sign in with Okta', exact: true }).click();
  await f.page.getByText(waitingForInvitation, { exact: true }).waitFor();
  const discovery = f.calls.find(call => call.path === '/api/v1/organizations/acme/sso');
  assert.equal(discovery.headers.authorization, undefined);
  const request = f.calls.find(call => call.path === '/auth/v1/sso');
  assert.equal(request.body.provider_id, providerId);
  assert.equal(request.body.redirect_to, runtime.enabled + '/auth/callback');
  assert.ok(request.body.code_challenge);
});

test('branded login disclosure and errors fit desktop, tablet and mobile', async () => {
  for (const [width, height] of [[1875, 915], [834, 1112], [320, 740]]) {
    const f = await app({ lookupStatus: 404, viewport: { width, height } });
    await f.login('missing');
    await f.page.getByRole('alert').waitFor();
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await f.page.getByLabel('Organization slug').isEnabled(), true);
    assert.deepEqual(await f.page.evaluate(() => document.getAnimations()
      .filter(animation => animation instanceof CSSAnimation && animation.playState === 'running')
      .map(animation => animation.animationName)), []);
    await f.capture(`login-${width}-expanded-error`);
  }
});

test('failed discovery never calls SSO and permits a successful retry', async () => {
  const f = await app({ lookupStatus: 404 });
  await f.login();
  await f.page.getByRole('alert').waitFor();
  assert.equal(f.count('/auth/v1/sso'), 0);
  assert.equal(await f.page.getByLabel('Organization slug').isDisabled(), false);
  f.state.lookupStatus = 200;
  await f.page.getByRole('button', { name: 'Sign in with Okta', exact: true }).click();
  await f.page.getByText(waitingForInvitation, { exact: true }).waitFor();
});

test('discovery timeout unlocks login and ignores a late response before retry', async () => {
  const gate = deferred();
  const f = await app({ lookupReply: async route => {
    await gate.promise;
    await route.fulfill({ json: { provider_id: providerId, idp: 'okta' } });
  } });
  try {
    await f.page.clock.install();
    await f.login('slow');
    await until(() => f.count('/api/v1/organizations/slow/sso') === 1);
    await f.page.clock.runFor(10_000);
    await f.page.getByRole('alert').filter({ hasText: 'took too long' }).waitFor();
    assert.equal(await f.page.getByLabel('Organization slug').isDisabled(), false);
    assert.equal(await f.page.getByRole('button', { name: 'Continue with Microsoft' }).isDisabled(), false);
    gate.resolve();
    await f.page.clock.runFor(100);
    assert.equal(f.count('/auth/v1/sso'), 0);
    f.state.lookupReply = null;
    await f.page.getByRole('button', { name: 'Sign in with Okta', exact: true }).click();
    await f.page.getByText(waitingForInvitation, { exact: true }).waitFor();
  } finally { gate.resolve(); }
});

test('cancelled discovery cannot start SSO and Microsoft remains available', async () => {
  const gate = deferred();
  const f = await app({ lookupReply: async route => { await gate.promise; await route.fulfill({ json: { provider_id: providerId, idp: 'okta' } }); } });
  try {
    await f.login('held');
    await until(() => f.count('/api/v1/organizations/held/sso') === 1);
    await f.page.getByRole('button', { name: 'Cancel organization sign-in' }).click();
    await f.page.getByRole('alert').filter({ hasText: 'cancelled' }).waitFor();
    gate.resolve();
    await f.page.getByRole('button', { name: 'Continue with Microsoft' }).click();
    await f.page.getByRole('heading', { name: 'Synthetic Microsoft provider' }).waitFor();
    assert.equal(f.count('/auth/v1/sso'), 0);
  } finally { gate.resolve(); }
});

test('cancelling an in-flight SDK response prevents its late redirect', async () => {
  const gate = deferred();
  const f = await app({ ssoReply: async route => { await gate.promise; await route.fulfill({ json: { url: runtime.enabled + '/late-idp' } }); } });
  try {
    await f.login();
    await until(() => f.count('/auth/v1/sso') === 1);
    await f.page.getByRole('button', { name: 'Cancel organization sign-in' }).click();
    await f.page.getByRole('alert').filter({ hasText: 'cancelled' }).waitFor();
    const finished = f.page.waitForResponse(response => response.url().endsWith('/auth/v1/sso'));
    gate.resolve();
    await finished;
    await f.page.waitForTimeout(100);
    assert.equal(new URL(f.page.url()).pathname, '/login');
    assert.equal(f.count('/auth/v1/token'), 0);
  } finally { gate.resolve(); }
});

test('unmount cancels discovery before a late result can authenticate', async () => {
  const gate = deferred();
  const f = await app({ lookupReply: async route => { await gate.promise; await route.fulfill({ json: { provider_id: providerId, idp: 'okta' } }); } });
  try {
    await f.login('unmount');
    await until(() => f.count('/api/v1/organizations/unmount/sso') === 1);
    await f.page.evaluate(() => { history.pushState({}, '', '/missing-test-page'); dispatchEvent(new PopStateEvent('popstate')); });
    await f.page.getByRole('heading', { name: /not found/i }).waitFor();
    gate.resolve();
    await f.page.waitForTimeout(100);
    assert.equal(f.count('/auth/v1/sso'), 0);
  } finally { gate.resolve(); }
});

test('callback under React Strict Mode exchanges the PKCE code once', async () => {
  const f = await app({ strict: true });
  await f.login();
  await f.page.getByText(waitingForInvitation, { exact: true }).waitFor();
  assert.equal(f.count('/auth/v1/token'), 1);
  assert.equal(f.calls.find(call => call.path === '/auth/v1/token').query.get('grant_type'), 'pkce');
});

test('callback rejects missing, duplicate and provider-error codes without exchange', async () => {
  const f = await app();
  for (const suffix of ['', '?code=a&code=b', '?code=a&error=denied', '?code=a#error=denied']) {
    await f.page.goto(runtime.enabled + '/auth/callback' + suffix);
    await f.page.getByRole('alert').waitFor();
    await f.page.getByRole('link', { name: 'Return to sign in' }).waitFor();
    assert.equal(f.count('/auth/v1/token'), 0);
  }
});

test('callback handles a rejected code without exposing provider details', async () => {
  const f = await app({ tokenStatus: 400 });
  await f.login();
  await f.page.getByRole('alert').waitFor();
  assert.equal(f.count('/auth/v1/token'), 1);
  assert.equal(await f.page.getByText('Synthetic rejected code').count(), 0);
  await f.page.getByRole('link', { name: 'Return to sign in' }).click();
  await f.page.getByRole('heading', { name: 'Welcome back' }).waitFor();
});

test('restored SAML session remains invitation-only and can sign out', async () => {
  const f = await app({ savedSession: true });
  await f.page.goto(runtime.enabled);
  await f.page.getByText(waitingForInvitation, { exact: true }).waitFor();
  assert.equal(await f.page.getByRole('button', { name: 'Create a new organization' }).count(), 0);
  assert.equal(f.count('/api/v1/organizations/domain-match'), 0);
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
  await f.page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await f.page.getByRole('heading', { name: 'Welcome back' }).waitFor();
  await f.page.reload();
  await f.page.getByRole('heading', { name: 'Welcome back' }).waitFor();
});

for (const status of [403, 503]) {
  test(`workspace ${status} offers recovery and retry reloads organizations`, async () => {
    const f = await app({ savedSession: true, organizationStatus: status });
    await f.page.goto(runtime.enabled);
    await recovery(f.page).waitFor();
    assert.equal(await f.page.getByRole('button', { name: 'Retry', exact: true }).isEnabled(), true);
    assert.equal(await f.page.getByRole('button', { name: 'Sign out', exact: true }).isEnabled(), true);
    await f.page.getByText(status === 403 ? /Contact your administrator/ : /Authentication is temporarily unavailable/).waitFor();
    assert.equal(await f.page.getByText('Private fixture detail').count(), 0);
    assert.equal(f.count('/auth/v1/logout'), 0);
    const before = f.count('/api/v1/organizations');
    await f.capture(`workspace-${status}-recovery`);
    f.state.organizationStatus = 200;
    await f.page.getByRole('button', { name: 'Retry', exact: true }).click();
    await f.page.getByText(waitingForInvitation, { exact: true }).waitFor();
    assert.equal(f.count('/api/v1/organizations'), before + 1);
    assert.equal(f.count('/auth/v1/logout'), 0);
  });

  test(`workspace ${status} can sign out and reach login`, async () => {
    const f = await app({ savedSession: true, organizationStatus: status });
    await f.page.goto(runtime.enabled);
    await recovery(f.page).waitFor();
    await f.page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await f.page.getByRole('heading', { name: 'Welcome back' }).waitFor();
    assert.equal(new URL(f.page.url()).pathname, '/login');
    assert.equal(await f.page.evaluate(key => localStorage.getItem(key), storageKey), null);
  });
}

test('retry rejection stays safe and duplicate clicks issue only one refresh', async () => {
  const gate = deferred();
  const f = await app({ savedSession: true, organizationStatus: 503 });
  try {
    await f.page.goto(runtime.enabled);
    await recovery(f.page).waitFor();
    const before = f.count('/api/v1/organizations');
    f.state.organizationReply = async route => { await gate.promise; await route.abort('failed'); };
    await f.page.getByRole('button', { name: 'Retry', exact: true }).evaluate(button => { button.click(); button.click(); });
    await until(() => f.count('/api/v1/organizations') > before);
    assert.equal(f.count('/api/v1/organizations'), before + 1);
    gate.resolve();
    await recovery(f.page).waitFor();
    await f.page.getByText('Unable to reload your workspace. Try again.', { exact: true }).waitFor();
    assert.equal(await f.page.getByRole('button', { name: 'Retry', exact: true }).isEnabled(), true);
    assert.equal(f.count('/auth/v1/logout'), 0);
  } finally { gate.resolve(); }
});

test('failed server sign out shows an honest warning after local logout and prevents duplicates', async () => {
  const gate = deferred();
  const f = await app({ savedSession: true, organizationStatus: 403,
    logoutReply: async route => { await gate.promise; await route.fulfill({ status: 503, json: { msg: 'Private fixture detail' } }); } });
  try {
    await f.page.goto(runtime.enabled);
    await recovery(f.page).waitFor();
    await f.page.getByRole('button', { name: 'Sign out', exact: true }).evaluate(button => { button.click(); button.click(); });
    await until(() => f.count('/auth/v1/logout') === 1);
    assert.equal(await f.page.getByRole('button', { name: 'Retry', exact: true }).isDisabled(), true);
    assert.equal(await f.page.getByRole('button', { name: 'Sign out', exact: true }).isDisabled(), true);
    gate.resolve();
    await f.page.getByRole('heading', { name: 'Welcome back' }).waitFor();
    await f.page.getByRole('alert').filter({ hasText: 'Sign-out could not be confirmed on the server' }).waitFor();
    await f.capture('signout-server-warning');
    assert.equal(f.count('/auth/v1/logout'), 1);
    assert.equal(await f.page.evaluate(key => localStorage.getItem(key), storageKey), null);
    assert.equal(await f.page.getByText('Private fixture detail').count(), 0);
    await f.page.getByLabel('Work email').fill('member@example.invalid');
    await f.page.getByLabel('Password', { exact: true }).fill('Synthetic fixture password');
    await f.page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
    await recovery(f.page).waitFor();
  } finally { gate.resolve(); }
});

test('connection failures offer the same retry and sign-out recovery', async () => {
  const f = await app({ savedSession: true, organizations: [organization], connectionStatus: 503, viewport: { width: 390, height: 844 } });
  await f.page.goto(runtime.enabled);
  await recovery(f.page).waitFor();
  await f.page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  await f.page.keyboard.press('Tab');
  assert.equal(await f.page.getByRole('button', { name: 'Retry', exact: true }).evaluate(button => button === document.activeElement), true);
  await f.page.keyboard.press('Tab');
  assert.equal(await f.page.getByRole('button', { name: 'Sign out', exact: true }).evaluate(button => button === document.activeElement), true);
  await f.capture('connection-recovery-mobile');
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  f.state.connectionStatus = 200;
  await f.page.getByRole('button', { name: 'Retry', exact: true }).click();
  await f.page.getByRole('heading', { name: 'Understand how your data moves and what it costs.' }).waitFor();
  assert.equal(f.count('/api/v1/organizations'), 2);
});

test('a rejected sign-out promise keeps recovery available without claiming success', async () => {
  const f = await app({ savedSession: true, organizationStatus: 403 });
  await f.page.goto(runtime.enabled);
  await recovery(f.page).waitFor();
  await f.page.evaluate(key => {
    window.fixtureRemoveItem = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (item) {
      if (item === key) throw new Error('Private fixture detail');
      return window.fixtureRemoveItem.call(this, item);
    };
  }, storageKey);
  try {
    await f.page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await f.page.getByText('Unable to sign out. Try again.', { exact: true }).waitFor();
    assert.ok(await f.page.evaluate(key => localStorage.getItem(key), storageKey));
    assert.equal(await f.page.getByRole('button', { name: 'Retry', exact: true }).isEnabled(), true);
    assert.equal(await f.page.getByText('Private fixture detail').count(), 0);
  } finally {
    await f.page.evaluate(() => { Storage.prototype.removeItem = window.fixtureRemoveItem; delete window.fixtureRemoveItem; });
  }
  await f.page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await f.page.getByRole('heading', { name: 'Welcome back' }).waitFor();
});

for (const status of [403, 503]) {
  test(`retry preserves an ongoing ${status} denial without business access`, async () => {
    const f = await app({ savedSession: true, organizationStatus: status });
    await f.page.goto(runtime.enabled);
    await recovery(f.page).waitFor();
    await f.page.getByRole('button', { name: 'Retry', exact: true }).click();
    await f.page.getByText('Unable to reload your workspace. Try again.', { exact: true }).waitFor();
    assert.equal(f.count('/api/v1/organizations'), 2);
    assert.equal(f.count('/api/v1/invitations'), 0);
    assert.equal(f.count('/auth/v1/logout'), 0);
    assert.equal(f.calls.some(call => call.path.includes('/snowflake-connections')), false);
    assert.equal(await f.page.getByRole('button', { name: 'Retry', exact: true }).isEnabled(), true);
  });
}

test('restored Microsoft identity retains normal non-SAML onboarding', async () => {
  const f = await app({ savedSession: true, provider: 'azure' });
  await f.page.goto(runtime.enabled);
  await f.page.getByRole('button', { name: 'Create a new organization' }).waitFor();
  assert.equal(f.count('/api/v1/organizations/domain-match'), 1);
  await f.page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await f.page.getByRole('heading', { name: 'Welcome back' }).waitFor();
});

test('Strict Mode overlapping organization refresh ignores the stale response', async () => {
  const gate = deferred();
  let requests = 0;
  const f = await app({ savedSession: true, strict: true, organizationReply: async route => {
    requests++;
    if (requests === 1) { await gate.promise; return route.fulfill({ json: [organization] }); }
    return route.fulfill({ json: [] });
  } });
  try {
    await f.page.goto(runtime.enabled);
    await f.page.getByText(waitingForInvitation, { exact: true }).waitFor();
    assert.ok(requests >= 2);
    gate.resolve();
    await f.page.waitForTimeout(100);
    assert.equal(await f.page.getByText(waitingForInvitation, { exact: true }).isVisible(), true);
    assert.equal(await f.page.getByRole('combobox', { name: 'Organization' }).count(), 0);
  } finally { gate.resolve(); }
});
