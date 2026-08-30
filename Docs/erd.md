# Tibbou database schema

```mermaid
erDiagram
  AUTH_USERS ||--o{ ORGANIZATION_MEMBERSHIPS : belongs_to
  ORGANIZATIONS ||--o{ ORGANIZATION_MEMBERSHIPS : has
  ORGANIZATIONS ||--o{ DATASETS : owns
  ORGANIZATIONS ||--o{ SYNC_RUNS : owns
  ORGANIZATIONS ||--o{ SNOWFLAKE_CONNECTIONS : owns
  ORGANIZATIONS ||--o{ RAW_INGESTIONS : owns
  ORGANIZATIONS ||--o{ QUERY_USAGE : owns
  DATASETS ||--o{ LINEAGE_EDGES : upstream
  DATASETS ||--o{ LINEAGE_EDGES : downstream
  DATASETS ||--o{ COST_SNAPSHOTS : has
  SNOWFLAKE_CONNECTIONS ||--o{ SYNC_RUNS : runs
  SYNC_RUNS ||--o{ RAW_INGESTIONS : stages
  SYNC_RUNS ||--o{ QUERY_USAGE : collects
  QUERY_USAGE ||--o{ QUERY_DATASET_ALLOCATIONS : allocates
  DATASETS ||--o{ QUERY_DATASET_ALLOCATIONS : receives

  ORGANIZATIONS { uuid id PK text name text slug UK }
  ORGANIZATION_MEMBERSHIPS { uuid id PK uuid organization_id FK uuid user_id FK text role }
  DATASETS { uuid id PK uuid organization_id FK text system text source_unique_id text relation_name boolean is_active }
  LINEAGE_EDGES { uuid id PK uuid organization_id FK uuid upstream_dataset_id FK uuid downstream_dataset_id FK text provenance numeric confidence boolean is_active }
  SNOWFLAKE_CONNECTIONS { uuid id PK uuid organization_id FK text auth_method text secret_reference jsonb capabilities jsonb watermarks }
  SYNC_RUNS { uuid id PK uuid organization_id FK uuid connection_id FK uuid requested_by text status text idempotency_key }
  RAW_INGESTIONS { uuid id PK uuid organization_id FK uuid sync_run_id FK text artifact_hash jsonb raw_payload }
  QUERY_USAGE { uuid id PK uuid organization_id FK uuid sync_run_id FK uuid connection_id FK text snowflake_query_id text query_hash numeric compute_credits }
  QUERY_DATASET_ALLOCATIONS { uuid id PK uuid query_usage_id FK uuid dataset_id FK numeric allocation_weight text evidence_source }
```

Tenant-owned tables include `organization_id`; `query_dataset_allocations` derives tenant scope through its `query_usage` and `dataset` foreign keys. RLS and explicit FastAPI filters enforce the same boundary. `auth.users` remains Supabase-managed. The legacy application `users` table is retained only until existing rows can be reviewed safely and is not part of the active identity model.
