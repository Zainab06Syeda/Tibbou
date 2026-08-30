# Tibbou frontend

React and Vite client for the Tibbou API. Phase 1 uses Supabase email and password authentication, then sends the access token to protected FastAPI routes. Microsoft Entra ID and Okta appear as roadmap options but remain disabled and make no authentication requests.

Copy `.env.example` to `.env`, configure only the Supabase project URL and publishable key, then run `npm install` and `npm run dev`. Never expose a Supabase secret or service-role key through a `VITE_` variable.

In the Supabase Dashboard, confirm that email authentication is enabled. Keep email confirmation on and create controlled users from **Authentication > Users**. If you temporarily allow public sign-up without confirmation, remember that the hosted Auth endpoint remains public even when this frontend is unpublished. Use that setting only long enough to create test accounts, then restore confirmation or disable public sign-up.

Set the Supabase Site URL to `http://localhost:5173` and allow `http://localhost:5173/auth/callback`. Start the app with `npm run dev` and open the URL Vite prints. `VITE_ENABLE_ENTRA_SSO` and `VITE_ENABLE_OKTA_SSO` only control the UI. Missing values default to false, and neither flag proves that a provider is securely configured.

Quality checks:

```powershell
npm run typecheck
npm run lint
npm run build
npm audit
```

The OAuth/PKCE callback route is retained for a future provider phase. Password reset, MFA, invitations, CAPTCHA, and provider configuration are intentionally outside Phase 1.

See the repository root README for backend, database, worker, RLS, and Snowflake context. Database changes are not part of Phase 1.
