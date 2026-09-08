-- Run only after 20260818_120000 in an isolated Supabase-compatible database.
-- The externally supplied local-test marker, revision gate, and final ROLLBACK
-- are intentional. Standard local Supabase uses the database name `postgres`.
\set ON_ERROR_STOP on

begin;

do $$
begin
  if current_setting('app.phase2b_local_test', true) is distinct from 'enabled' then
    raise exception 'refusing tenancy scenario without the explicit local-test marker';
  end if;
  if not exists (
    select 1 from public.alembic_version
    where version_num = '20260818_120000'
  ) then
    raise exception 'candidate migration is not applied';
  end if;
end
$$;

grant tibbou_runtime to current_user;
insert into auth.users (id, aud, role)
values
  ('10000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated'),
  ('10000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated');

set local role tibbou_runtime;
select set_config('app.current_user_id', '10000000-0000-0000-0000-000000000001', true);
select set_config('app.current_organization_id', '', true);
insert into public.organizations (id, name, slug, created_by)
values (
  '20000000-0000-0000-0000-000000000001',
  'Synthetic One',
  'synthetic-one',
  '10000000-0000-0000-0000-000000000001'
);
insert into public.organization_memberships (id, organization_id, user_id, role)
values (
  '30000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'owner'
);
select set_config('app.current_organization_id', '20000000-0000-0000-0000-000000000001', true);
insert into public.datasets (id, organization_id, name, system)
values (
  '40000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  'Synthetic dataset',
  'test'
);

-- Bootstrap a second organization under a second validated identity.
select set_config('app.current_user_id', '10000000-0000-0000-0000-000000000002', true);
select set_config('app.current_organization_id', '', true);
insert into public.organizations (id, name, slug, created_by)
values (
  '20000000-0000-0000-0000-000000000002',
  'Synthetic Two',
  'synthetic-two',
  '10000000-0000-0000-0000-000000000002'
);
insert into public.organization_memberships (id, organization_id, user_id, role)
values (
  '30000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000002',
  'owner'
);
select set_config('app.current_organization_id', '20000000-0000-0000-0000-000000000002', true);

do $$
declare affected bigint;
begin
  if exists (
    select 1 from public.datasets
    where id = '40000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'cross-organization SELECT was allowed';
  end if;

  update public.datasets set name = 'forbidden'
  where id = '40000000-0000-0000-0000-000000000001';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'cross-organization UPDATE was allowed'; end if;

  delete from public.datasets
  where id = '40000000-0000-0000-0000-000000000001';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'cross-organization DELETE was allowed'; end if;

  begin
    insert into public.datasets (id, organization_id, name, system)
    values (
      '40000000-0000-0000-0000-000000000002',
      '20000000-0000-0000-0000-000000000001',
      'forbidden',
      'test'
    );
    raise exception 'cross-organization INSERT was allowed';
  exception when insufficient_privilege then
    null;
  end;
end
$$;

-- Owner one adds user two as a viewer; viewer writes must fail.
select set_config('app.current_user_id', '10000000-0000-0000-0000-000000000001', true);
select set_config('app.current_organization_id', '20000000-0000-0000-0000-000000000001', true);
insert into public.organization_memberships (id, organization_id, user_id, role)
values (
  '30000000-0000-0000-0000-000000000003',
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  'viewer'
);
select set_config('app.current_user_id', '10000000-0000-0000-0000-000000000002', true);
do $$
begin
  if not exists (
    select 1 from public.datasets
    where id = '40000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'same-organization viewer SELECT was denied';
  end if;
  begin
    insert into public.datasets (id, organization_id, name, system)
    values (
      '40000000-0000-0000-0000-000000000003',
      '20000000-0000-0000-0000-000000000001',
      'viewer write',
      'test'
    );
    raise exception 'viewer INSERT was allowed';
  exception when insufficient_privilege then
    null;
  end;
end
$$;

-- Missing context must reveal nothing.
select set_config('app.current_user_id', '', true);
select set_config('app.current_organization_id', '', true);
do $$
begin
  if exists (select 1 from public.datasets) then
    raise exception 'missing context did not fail closed';
  end if;
end
$$;

-- Direct Data API roles have no object privileges, independent of RLS.
reset role;
set local role anon;
do $$
begin
  begin
    perform count(*) from public.datasets;
    raise exception 'anon table access was allowed';
  exception when insufficient_privilege then
    null;
  end;
end
$$;
reset role;
set local role authenticated;
do $$
begin
  begin
    perform count(*) from public.datasets;
    raise exception 'authenticated table access was allowed';
  exception when insufficient_privilege then
    null;
  end;
end
$$;

rollback;
