# Tibbou data flow

Diagram ID: `dfd-main`.

```mermaid
%%{init: {"theme":"base","themeVariables":{"primaryColor":"#ffffff","primaryTextColor":"#111111","primaryBorderColor":"#555555","lineColor":"#555555","secondaryColor":"#ffffff","tertiaryColor":"#ffffff","edgeLabelBackground":"#ffffff"},"flowchart":{"curve":"linear","nodeSpacing":55,"rankSpacing":75}}}%%
flowchart LR
    U["User or administrator"]
    Auth["Supabase Auth"]
    D2Access[("D2. Organization access data")]
    D1Lineage[("D1. Business data")]
    D1Cost[("D1. Business data")]
    Dbt["dbt"]
    Snowflake["Snowflake"]
    P1(("P1. Session and<br/>access check"))
    P2(("P2. Lineage view"))
    P3(("P3. Cost monitoring"))
    P4(("P4. Admin management"))
    P5(("P5. Data ingestion"))

    U -->|"User requests"| P1
    Auth -->|"Session information"| P1
    D2Access -->|"Membership and role"| P1
    P1 -->|"Authorized requests"| P2
    P1 -->|"Authorized requests"| P3
    P1 -->|"Authorized requests"| P4
    P1 -->|"Authorized requests"| P5
    D1Lineage -->|"Lineage data"| P2
    P2 -->|"Lineage results"| OUTLineage["User or administrator"]
    D1Cost -->|"Cost data"| P3
    P3 -->|"Cost results"| OUTCost["User or administrator"]
    P4 <-->|"Invitation changes and admin data"| D2Admin[("D2. Organization access data")]
    P4 -->|"Admin results"| OUTAdmin["User or administrator"]
    Dbt -->|"dbt metadata"| P5
    Snowflake -->|"Snowflake usage data"| P5
    P5 <-->|"Queued jobs and input"| D3[("D3. Jobs and staged input")]
    P5 -->|"Lineage and query usage"| D1Ingestion[("D1. Business data")]

```

P1 combines the signed-in session with organization membership and role checks. It sends allowed requests to the other process groups. P2 and P3 read stored lineage and cost data.

P4 supports the Admin Dashboard and invitation changes. P5 groups the API and worker steps that queue and process dbt metadata or Snowflake usage data. Repeated user and data-store boxes refer to the same actor or logical store; they keep the diagram readable.

The three data stores are logical groups inside the same PostgreSQL database. D1 contains datasets, lineage, cost, and query usage. D2 contains organizations, memberships, roles, and invitations. D3 contains queued runs and staged input.

## Supplemental detailed view: authentication and invitation onboarding

Diagram ID: `dfd-onboarding`.

This diagram expands the onboarding flow. It's just extra technical documentation and is not included in the current DDS.

```mermaid
%%{init: {"theme":"base","themeVariables":{"primaryColor":"#ffffff","primaryTextColor":"#111111","primaryBorderColor":"#555555","lineColor":"#555555","secondaryColor":"#ffffff","tertiaryColor":"#ffffff","edgeLabelBackground":"#ffffff"},"flowchart":{"curve":"linear","nodeSpacing":55,"rankSpacing":75}}}%%
flowchart TB
    Browser["React browser"]
    Auth["Supabase Auth"]
    Entra["Microsoft Entra"]
    Check(("FastAPI identity check"))
    Lookup(("Invitation lookup"))
    Accept(("Invitation acceptance"))
    D2[("Organization access data")]
    Workspace["User enters the organization"]
    Note["Signing in alone does not grant organization access"]

    Browser -->|"Sign-in request"| Auth
    Auth -->|"Microsoft sign-in"| Entra
    Entra -->|"Verified identity"| Auth
    Auth -->|"Session information"| Browser
    Browser -->|"Session and request"| Check
    Check -->|"Signed-in user"| Lookup
    Lookup -->|"Signed-in email"| D2
    D2 -->|"Matching invitation"| Lookup
    Lookup -->|"Available invitation"| Browser
    Browser -->|"Selected invitation"| Accept
    Accept -->|"Create membership and remove invitation"| D2
    D2 -->|"Membership created"| Accept
    Accept -->|"Organization and role"| Workspace
    Browser -.-> Note
```

Supabase Auth handles Microsoft sign-in and returns the browser session. FastAPI then checks the signed-in identity. Invitation lookup returns only an unexpired invitation for the signed-in user's email; an email domain or provider name never grants organization access.

When the user accepts an invitation, the backend checks the recipient again, creates the membership with the invited role, and removes the used invitation. React reloads the user's organizations and enters the workspace after membership exists.

## Detailed behavior kept out of the diagrams

- FastAPI validates the Supabase access token before any protected operation.
- Invitation lookup uses the signed-in user's full email and ignores expired invitations.
- Acceptance prevents duplicate membership and completes the membership creation and invitation removal together.
- Missing or invalid identity, unavailable invitations, and existing membership return safe API errors. Exact HTTP codes remain in the route and test documentation.
- dbt input is uploaded through the browser, while the worker reads Snowflake usage through the configured server-side connection.
- The worker claims queued runs, processes them, records the result, and retries failed work within its configured limit.

## Relevant API interfaces

| Method and path | Purpose | Access |
| --- | --- | --- |
| `GET /api/v1/organizations` | List organizations backed by membership | Signed-in user |
| `GET /api/v1/organizations/{organization_id}/admin` | Read Admin Dashboard data | Owner or administrator |
| `POST /api/v1/organizations/{organization_id}/invitations` | Create an invitation | Owner or administrator |
| `DELETE /api/v1/organizations/{organization_id}/invitations/{invitation_id}` | Revoke an invitation | Owner or administrator |
| `GET /api/v1/invitations` | List invitations for the signed-in email | Signed-in user with an email |
| `POST /api/v1/invitations/{invitation_id}/accept` | Join the invited organization | Matching invited user |
| `GET /api/v1/organizations/{organization_id}/datasets` and `/lineage` | Read datasets and active lineage | Any organization role |
| `GET /api/v1/organizations/{organization_id}/costs` | Read stored monetary cost snapshots | Any organization role |
| `POST /api/v1/organizations/{organization_id}/ingestion/dbt/manifest` | Queue dbt metadata | Owner, administrator, or operator |
| `POST /api/v1/organizations/{organization_id}/ingestion/snowflake/query-usage` | Queue Snowflake usage import | Owner, administrator, or operator |

## Sources

[Authentication settings](../../Frontend/tibbou-data-flow/src/lib/authConfig.js), [organization context](../../Frontend/tibbou-data-flow/src/contexts/OrganizationContext.jsx), [workspace gate](../../Frontend/tibbou-data-flow/src/components/WorkspaceGate.jsx), [identity checks](../../Backend/app/auth.py), [invitation routes](../../Backend/app/api/routes/invitations.py), [ingestion routes](../../Backend/app/api/routes/ingestion.py), and [worker](../../Backend/app/worker.py).
