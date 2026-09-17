# Deployment Notes — Capstone AWS Hosting (2026-09-16 / 2026-09-17)

This documents the first deployment of Tibbou to AWS: what was provisioned, why, and how to
operate it going forward. Everything below lives in AWS account `767397853032`, under a
dedicated IAM user (`tibbou-capstone-deploy`) so this work stays isolated from any other
work happening in that account.

## Summary

- **Frontend**: static Vite build hosted on S3 + CloudFront.
  Live at: `https://d3ds9xfujeetf5.cloudfront.net`
- **Backend**: FastAPI app hosted on Elastic Beanstalk (single instance).
  Live at: `http://tibbou-backend-env.eba-fu7hjdww.us-east-1.elasticbeanstalk.com`
  (not called directly by the frontend — see API routing below)
- **Database**: Supabase Postgres (project `Tibbou`, ref `dulvpwykcbctfiffxbsn`) — unchanged,
  already existed and was already migrated to head (`20260910_120000`) before this work began.
- **Auth**: Supabase Auth (Azure/Entra SSO + email/password) — unchanged, existing project.

## AWS access

A scoped IAM user, `tibbou-capstone-deploy`, was created specifically for this project rather
than reusing any other credentials in the account. It has:

- A custom policy (`TibbouCapstoneDeployPolicy`) limited to S3 buckets named `tibbou-*`,
  plus CloudFront and ACM.
- The AWS-managed `AdministratorAccess-AWSElasticBeanstalk` policy (needed because Elastic
  Beanstalk orchestrates EC2, security groups, autoscaling, and its own S3 bucket under the
  hood).

Two account-wide IAM roles were also created (required by every Elastic Beanstalk environment,
not specific to this project): `aws-elasticbeanstalk-ec2-role` and
`aws-elasticbeanstalk-service-role`.

Anyone continuing this work should use `aws <command> --profile capstone` (after running
`aws configure --profile capstone` with their own access key) rather than any other profile.

## Frontend hosting (S3 + CloudFront)

- **S3 bucket**: `tibbou-capstone-frontend` — fully private (all public access blocked), us-east-1.
- **CloudFront distribution**: `E1X8N3SX2NYCQR` (`d3ds9xfujeetf5.cloudfront.net`)
  - Reads the S3 bucket via **Origin Access Control** (OAC) — the bucket policy only allows
    `s3:GetObject` from this specific distribution's ARN, nothing public.
  - A **CloudFront Function** (`tibbou-spa-rewrite`) rewrites any request without a file
    extension (e.g. `/datasets`, `/lineage`) to `/index.html` *before* it reaches S3, so
    React Router can handle client-side routes. This runs only on the default (S3) behavior —
    it explicitly skips `/api/*`.
  - Deliberately **not** using CloudFront's built-in "custom error responses" (403/404 →
    index.html) for SPA fallback, because that rewrites *any* unmatched path — including
    failed `/api/*` calls — into a 200 response containing HTML. That broke the frontend
    (see "Incident: blank page after merge" below) and was replaced with the Function above.

### Deploying frontend changes

```bash
cd Frontend/tibbou-data-flow
npm ci
npm run build
aws s3 sync dist/ s3://tibbou-capstone-frontend/ --delete --profile capstone
aws cloudfront create-invalidation --distribution-id E1X8N3SX2NYCQR --paths "/*" --profile capstone
```

`.env.production` (gitignored, not committed) contains `VITE_API_BASE_URL=/api`,
`VITE_SUPABASE_URL`, and `VITE_SUPABASE_PUBLISHABLE_KEY`. Whoever redeploys needs their own
copy of this file — ask a teammate who's deployed before, or pull the values from the
Supabase dashboard (Project Settings → Data API for the URL, → API Keys → Publishable key).

## Backend hosting (Elastic Beanstalk)

- **Application**: `tibbou-backend`, **Environment**: `tibbou-backend-env`
- Platform: Python 3.12 on Amazon Linux 2023, single-instance tier (no load balancer — keeps
  this cheap and simple, appropriate for a capstone demo, not meant to be a production-grade
  HA setup).
- Instance type: `t3.micro`.
- Started via `Procfile` (`web: uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2`) —
  no Dockerfile was added; Elastic Beanstalk's native Python platform runs this directly.
- Environment variables (set directly on the EB environment, not committed to git):
  `DATABASE_URL`, `DATABASE_POOL_SIZE`, `DATABASE_MAX_OVERFLOW`, `SUPABASE_URL`,
  `SUPABASE_JWT_AUDIENCE`, `CORS_ORIGINS`, `MAX_DBT_MANIFEST_BYTES`,
  `MAX_DBT_MANIFEST_NODES`, `SNOWFLAKE_STATEMENT_TIMEOUT_SECONDS`.
- `DATABASE_URL` uses Supabase's **transaction pooler** (port 6543), per the existing
  `.env.example` guidance, not a direct connection.

### API routing: CloudFront → Elastic Beanstalk

The Elastic Beanstalk environment only serves plain HTTP, so the frontend (served over HTTPS)
can't call it directly — browsers block that as mixed content. Instead of adding a certificate
and load balancer to Elastic Beanstalk, the existing CloudFront distribution proxies API calls:

- A second CloudFront origin, `tibbou-backend-eb`, points at the EB environment's domain
  (HTTP-only origin protocol — CloudFront still serves HTTPS to the browser; only the
  CloudFront-to-backend hop is plain HTTP, which is the standard pattern for this).
- A cache behavior for path pattern `/api/*` routes to that origin, with caching disabled
  (API responses shouldn't be cached) and the AWS-managed "AllViewer" origin request policy
  (forwards the `Authorization` header and all other headers/cookies/query strings through).
- A second CloudFront Function, `tibbou-api-rewrite`, strips one leading `/api` segment from
  the request path before it's forwarded — because the frontend's API client already prefixes
  every call with `/api` (mirroring the local dev Vite proxy's `rewrite` behavior) while the
  FastAPI backend's own routes don't repeat that prefix.
- Because both the frontend and API are served from the same CloudFront domain, this is
  same-origin from the browser's perspective — no CORS issues in practice, even though
  `CORS_ORIGINS` is still set on the backend for safety/local dev.

### Deploying backend changes

```bash
cd Backend
$env:AWS_PROFILE = "capstone"   # PowerShell
.\.venv-eb\Scripts\eb.exe deploy
```

(`.venv-eb` is a local virtualenv with the `awsebcli` package installed — gitignored, not
shared. Anyone else deploying needs to `python -m venv .venv-eb` and
`.\.venv-eb\Scripts\pip install awsebcli` once, then `eb init tibbou-backend --platform "Python 3.12" --region us-east-1`
to link their local clone to the existing application.)

Database migrations (Alembic, in `Database/alembic`) were **not** re-run — the Supabase
database was already at the latest migration head when this work started, presumably from
prior local development against the same shared project.

## Login page background (this PR)

Added an animated background to the login page (`Frontend/tibbou-data-flow/src/pages/Login.jsx`),
matching the visual style of the Hayes GlobalFlow login page: three large, heavily-blurred,
low-opacity circles ("orbs") drifting slowly and independently behind the login card, using
Tibbou's own palette (cyan/emerald/amber) instead of Hayes' blue.

- `@keyframes floatOrb` added to `src/index.css` — a slow, subtle drift-and-scale animation.
- Three `<div>`s added to `Login.jsx`, each with a different size, blur radius, animation
  duration, and negative `animationDelay` so they don't move in sync (this staggering is what
  makes it read as organic rather than mechanical).

## Known gaps / things to revisit

- **Cost**: the Elastic Beanstalk environment runs a `t3.micro` EC2 instance continuously,
  unlike the frontend (S3 + CloudFront), which only costs based on usage. If the team pauses
  work for a while, consider `eb terminate tibbou-backend-env` and recreating it later.
- **Secrets**: the Supabase database password is currently stored as a plaintext Elastic
  Beanstalk environment variable (not committed to git, but visible to anyone with
  `elasticbeanstalk:DescribeConfigurationSettings` on the account). Fine for a capstone; worth
  moving to AWS Secrets Manager if this ever needs to be more locked down.
- **No custom domain yet** — still on the default `*.cloudfront.net` and
  `*.elasticbeanstalk.com` URLs. Adding one requires an ACM certificate in `us-east-1` and a
  DNS record; not done here since no domain was available.
- **Single instance, no autoscaling/HA** — acceptable for a capstone demo, not for real
  production traffic.

### Incident: blank page after merging SSO/admin dashboard work

Right after merging PR #2 (SSO + admin dashboard), the hosted frontend showed a blank page
with `T.find is not a function` for any signed-in user. Root cause: CloudFront's original SPA
fallback rewrote *any* 403/404 (including failed `/api/*` calls, since no backend existed yet)
into a 200 response containing `index.html`. The frontend's API client treated that 200 as
success and tried to call `.find()` on what it expected to be an array of organizations, but
was actually HTML. Fixed by replacing the error-code-based SPA fallback with the
`tibbou-spa-rewrite` CloudFront Function described above, which never touches `/api/*` — so a
missing backend now produces a real error status instead of a fake success.
