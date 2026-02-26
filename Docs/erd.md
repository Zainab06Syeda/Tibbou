# Tibbou Database Schema

config:
    title: Tibbou Database Schema

```mermaid
erDiagram
  USERS {
    uuid id PK
    text email "UNIQUE, NOT NULL"
    text password_hash "NOT NULL"
    timestamptz created_at
    timestamptz last_login_at
    boolean is_active
  }

  DATASETS {
    uuid id PK
    text name "NOT NULL"
    text system "NOT NULL"
    text namespace
    timestamptz created_at
  }

  LINEAGE_EDGES {
    uuid id PK
    uuid upstream_dataset_id FK
    uuid downstream_dataset_id FK
    text relationship_type
    timestamptz created_at
  }

  COST_SNAPSHOTS {
    uuid id PK
    uuid dataset_id FK
    timestamptz period_start "NOT NULL"
    timestamptz period_end "NOT NULL"
    numeric cost_amount "NOT NULL"
    text currency "DEFAULT USD"
    text usage_unit
    numeric usage_amount
    timestamptz collected_at "NOT NULL"
  }

  RAW_INGESTIONS {
    uuid id PK
    text source_system "NOT NULL"
    text ingestion_type "NOT NULL"
    text status "NOT NULL"
    timestamptz ingested_at "NOT NULL"
    jsonb raw_payload "NOT NULL"
    text error
  }

  SYNC_RUNS {
    uuid id PK
    text run_type "NOT NULL"
    text status "NOT NULL"
    timestamptz started_at "NOT NULL"
    timestamptz finished_at
    jsonb details
    text error
  }

  DATASETS ||--o{ COST_SNAPSHOTS : "has"
  DATASETS ||--o{ LINEAGE_EDGES : "upstream"
  DATASETS ||--o{ LINEAGE_EDGES : "downstream"
