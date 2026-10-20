"""recover interrupted ingestion runs

Revision ID: 20260922_120000
Revises: 20260921_120000
Create Date: 2026-09-22 20:05:09.843149
"""
from alembic import op


# revision identifiers, used by Alembic.
revision = '20260922_120000'
down_revision = '20260921_120000'
branch_labels = None
depends_on = None


def _claim_sync_run_sql(retry_filter: str) -> str:
    return f"""
        create or replace function private.claim_sync_run()
        returns table (id uuid, organization_id uuid, requested_by uuid)
        language plpgsql security definer set search_path = ''
        as $$
        begin
          if not pg_catalog.pg_has_role(session_user, 'tibbou_worker', 'member') then
            raise exception 'worker role required';
          end if;
          return query
          update public.sync_runs as target
          set status = 'running', started_at = pg_catalog.now(),
              attempt_count = attempt_count + 1, error = null
          where target.id = (
            select candidate.id from public.sync_runs candidate
            where candidate.status = 'queued'
              and candidate.queued_at <= pg_catalog.now()
              and candidate.organization_id is not null
              and candidate.requested_by is not null
              {retry_filter}
            order by candidate.queued_at, candidate.id
            limit 1 for update skip locked
          )
          returning target.id, target.organization_id, target.requested_by;
        end $$
    """


def upgrade() -> None:
    op.execute(_claim_sync_run_sql("and candidate.attempt_count < 3"))
    op.execute(
        "revoke all on function private.claim_sync_run() "
        "from public, anon, authenticated, service_role, tibbou_runtime"
    )
    op.execute("grant execute on function private.claim_sync_run() to tibbou_worker")
    op.execute(
        """
        create function private.recover_interrupted_sync_runs()
        returns integer language plpgsql security definer set search_path = ''
        as $$
        declare recovered_count integer;
        begin
          if not pg_catalog.pg_has_role(session_user, 'tibbou_worker', 'member') then
            raise exception 'worker role required';
          end if;
          with recovered as (
            update public.sync_runs as run
            set status = case when attempt_count < 3 then 'queued' else 'failed' end,
                queued_at = case when attempt_count < 3 then pg_catalog.now() else queued_at end,
                started_at = null,
                finished_at = case when attempt_count < 3 then null else pg_catalog.now() end,
                error = 'Processing interrupted; review restricted worker logs'
            where run.status = 'running'
              and not exists (
                select 1 from public.raw_ingestions as finished_artifact
                where finished_artifact.sync_run_id = run.id
                  and finished_artifact.organization_id = run.organization_id
                  and finished_artifact.status in ('success', 'partial')
              )
            returning id, organization_id, status
          ), artifacts as (
            update public.raw_ingestions as raw
            set status = recovered.status,
                error = 'Processing interrupted; review restricted worker logs'
            from recovered where raw.sync_run_id = recovered.id
              and raw.organization_id = recovered.organization_id
              and raw.status = 'running'
            returning raw.id
          )
          select count(*) into recovered_count from recovered;
          return recovered_count;
        end $$
        """
    )
    op.execute(
        "revoke all on function private.recover_interrupted_sync_runs() "
        "from public, anon, authenticated, service_role, tibbou_runtime"
    )
    op.execute(
        "grant execute on function private.recover_interrupted_sync_runs() to tibbou_worker"
    )


def downgrade() -> None:
    op.execute("drop function private.recover_interrupted_sync_runs()")
    op.execute(_claim_sync_run_sql(""))
