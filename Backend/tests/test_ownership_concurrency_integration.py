"""Opt-in real local Supabase ownership tests; never migrate or reset a database.

Set TIBBOU_OWNERSHIP_LOCAL_TEST=enabled and provide separate administrator/API
URLs in TIBBOU_OWNERSHIP_DATABASE_URL / TIBBOU_OWNERSHIP_API_DATABASE_URL.
Only new UUID-scoped synthetic organizations/memberships are written and retained.
Native Auth identities and all pre-existing application records are preserved.
"""
import json
import os
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import jwt
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.api.routes.organizations import (
    _lock_membership_changes, change_member_role, remove_member, transfer_ownership,
)
from app.auth import CurrentUser, require_organization_role
from app.db import get_db
from app.models.organization_memberships import OrganizationMembership
from app.schemas.organizations import MembershipRoleUpdate


@unittest.skipUnless(os.getenv('TIBBOU_OWNERSHIP_LOCAL_TEST') == 'enabled',
                     'explicit local ownership-test marker is absent')
class OwnershipConcurrencyIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        urls = [make_url(os.environ[name]) for name in
                ('TIBBOU_OWNERSHIP_DATABASE_URL', 'TIBBOU_OWNERSHIP_API_DATABASE_URL')]
        for url in urls:
            if (url.get_backend_name() != 'postgresql' or url.host not in ('127.0.0.1', 'localhost')
                    or url.port is None or not 54000 <= url.port <= 54999 or url.database != 'postgres'):
                raise ValueError('Ownership integration tests require explicit local Supabase URLs')
        if (urls[0].host, urls[0].port) != (urls[1].host, urls[1].port):
            raise ValueError('Administrator and restricted API must target the same local database')
        cls.admin = create_engine(urls[0], connect_args={'sslmode': 'disable'})
        cls.api = create_engine(urls[1], pool_size=3, max_overflow=0,
                                connect_args={'sslmode': 'disable'})
        with cls.admin.connect() as db:
            assert db.execute(text('show server_version_num')).scalar_one().startswith('17')
            assert db.execute(text('show default_transaction_isolation')).scalar_one() == 'read committed'
            assert db.execute(text('select version_num from public.alembic_version')).scalar_one() == '20261005_120000'
            assert db.execute(text("select count(*) from pg_extension where extname='supabase_vault'")).scalar_one() == 1
            rows = db.execute(text('select id,email from auth.users order by id limit 7')).all()
            assert len(rows) == 7, 'Create synthetic native Auth fixtures separately before opting in'
            cls.users = [CurrentUser(row.id, row.email, None) for row in rows]
        with cls.api.connect() as db:
            role, superuser, bypass = db.execute(text(
                'select current_user,rolsuper,rolbypassrls from pg_roles where rolname=current_user')).one()
            assert role != urls[0].username and not superuser and not bypass
            assert db.execute(text("select pg_has_role(session_user,'tibbou_runtime','member')")).scalar_one()

    @classmethod
    def tearDownClass(cls):
        cls.api.dispose()
        cls.admin.dispose()

    def setUp(self):
        self.org = self.new_org()
        self.foreign_org = self.new_org(foreign=True)

    def new_org(self, foreign=False):
        org = uuid4()
        with self.admin.begin() as db:
            db.execute(text('insert into organizations(id,name,slug,created_by) values (:id,:name,:slug,:user)'),
                       {'id': org, 'name': 'Ownership concurrency regression',
                        'slug': 'phase17-ownership-' + org.hex, 'user': self.users[0].id})
            members = zip(self.users[5:], ['owner', 'viewer']) if foreign else zip(
                self.users, ['owner', 'owner', 'admin', 'operator', 'viewer'])
            for user, role in members:
                db.execute(text('insert into organization_memberships(id,organization_id,user_id,role) '
                                'values (:id,:org,:user,:role)'),
                           {'id': uuid4(), 'org': org, 'user': user.id, 'role': role})
        return org

    def access(self, db, index, org=None):
        db.execute(text("set local statement_timeout='10s'"))
        return require_organization_role('owner', 'admin')(
            organization_id=org or self.org, user=self.users[index], db=db)

    @staticmethod
    def act(db, access, target, action):
        if action == 'remove':
            return remove_member(target, access, db)
        if action == 'owner':
            return transfer_ownership(target, access, db)
        return change_member_role(target, MembershipRoleUpdate(role=action), access, db)

    def rows(self, org=None):
        with self.admin.connect() as db:
            return dict(db.execute(text('select user_id,role from organization_memberships '
                                        'where organization_id=:org order by user_id'),
                                   {'org': org or self.org}).all())

    def wait_for_lock(self, waiter_pid, holder_pid):
        deadline = time.monotonic() + 10
        with self.admin.connect() as db:
            while time.monotonic() < deadline:
                blocked = db.execute(text('select :holder=any(pg_blocking_pids(:waiter))'),
                                     {'holder': holder_pid, 'waiter': waiter_pid}).scalar_one()
                if blocked:
                    return
                threading.Event().wait(0.01)
        self.fail('Independent session never waited on the organization transaction lock')

    def race(self, first_action, second_action, *, first_target=0, second_actor=1,
             second_target=1, expected=409, cache_target=False):
        ready, release, waiter_ready = threading.Event(), threading.Event(), threading.Event()
        pids = {}
        engine, test = self.api, self

        class PausedCommitSession(Session):
            def commit(self):
                self.flush()
                ready.set()
                if not release.wait(15):
                    raise AssertionError('Controlled transaction release timed out')
                super().commit()

        def first():
            with PausedCommitSession(engine, autoflush=False) as db:
                pids['holder'] = db.execute(text('select pg_backend_pid()')).scalar_one()
                return test.act(db, test.access(db, 0), test.users[first_target].id, first_action)

        def second():
            with Session(engine, autoflush=False) as db:
                pids['waiter'] = db.execute(text('select pg_backend_pid()')).scalar_one()
                access = test.access(db, second_actor)
                cached = None
                if cache_target:
                    cached = db.query(OrganizationMembership).filter_by(
                        organization_id=test.org, user_id=test.users[second_target].id).one()
                waiter_ready.set()
                try:
                    test.act(db, access, test.users[second_target].id, second_action)
                except HTTPException as exc:
                    db.rollback()
                    return exc.status_code
                finally:
                    # Retain the pre-wait ORM object, proving populate_existing refreshes it.
                    assert not cache_target or cached is not None
                return 200

        with ThreadPoolExecutor(max_workers=2) as pool:
            a = pool.submit(first)
            try:
                self.assertTrue(ready.wait(10))
                b = pool.submit(second)
                self.assertTrue(waiter_ready.wait(10))
                self.assertNotEqual(pids['holder'], pids['waiter'])
                self.wait_for_lock(pids['waiter'], pids['holder'])
            finally:
                release.set()
            a.result(timeout=10)
            self.assertEqual(b.result(timeout=10), expected)
        current = self.rows()
        self.assertGreaterEqual(list(current.values()).count('owner'), 1)
        print('PHASE17_LIVE ' + json.dumps({'first': first_action, 'second': second_action,
              'independent_sessions': True, 'wait_observed': True, 'rejected_status': expected,
              'remaining_owners': list(current.values()).count('owner')}), flush=True)
        return current

    def test_two_owner_demotions_serialize(self):
        rows = self.race('viewer', 'viewer')
        self.assertEqual((rows[self.users[0].id], rows[self.users[1].id]), ('viewer', 'owner'))

    def test_two_owner_removals_serialize(self):
        rows = self.race('remove', 'remove')
        self.assertNotIn(self.users[0].id, rows)
        self.assertEqual(rows[self.users[1].id], 'owner')

    def test_mixed_owner_reductions_serialize(self):
        self.race('viewer', 'remove')

    def test_waiting_actor_authorization_is_rechecked(self):
        # A stale access.role must not survive demotion or removal during the wait.
        for change, status in [('viewer', 403), ('admin', 403), ('remove', 404)]:
            with self.subTest(change=change):
                self.org = self.new_org()
                rows = self.race(change, 'owner', first_target=1, second_target=4, expected=status)
                self.assertEqual(rows[self.users[4].id], 'viewer')

    def test_waiting_administrator_reloads_new_owner_target(self):
        rows = self.race('owner', 'viewer', first_target=4, second_actor=2,
                         second_target=4, expected=403, cache_target=True)
        self.assertEqual(rows[self.users[4].id], 'owner')

    def test_different_organizations_and_transaction_lock_release(self):
        other = self.new_org()
        with Session(self.api, autoflush=False) as holder:
            access = self.access(holder, 0)
            _lock_membership_changes(holder, access, 'manage_members')
            def unrelated():
                with Session(self.api, autoflush=False) as db:
                    self.act(db, self.access(db, 0, other), self.users[4].id, 'operator')
            with ThreadPoolExecutor(max_workers=1) as pool:
                pool.submit(unrelated).result(timeout=5)
            self.assertEqual(self.rows(other)[self.users[4].id], 'operator')
            for finish in [holder.commit, holder.rollback]:
                _lock_membership_changes(holder, self.access(holder, 0), 'manage_members')
                finish()
                self.assertEqual(holder.execute(text("select nullif(current_setting('app.current_user_id',true),''),"
                    "nullif(current_setting('app.current_organization_id',true),'')")).one(), (None, None))
                with Session(self.api) as probe:
                    self.assertTrue(probe.execute(text('select pg_try_advisory_xact_lock(hashtextextended(:scope,0))'),
                        {'scope': f'tibbou:memberships:{self.org}'}).scalar_one())

    def test_sequential_management_transfer_and_last_owner(self):
        with Session(self.api, autoflush=False) as db:
            self.act(db, self.access(db, 0), self.users[1].id, 'viewer')
            for operation in ['viewer', 'remove']:
                with self.assertRaises(HTTPException) as raised:
                    self.act(db, self.access(db, 0), self.users[0].id, operation)
                self.assertEqual(raised.exception.status_code, 409)
                self.assertEqual(self.rows()[self.users[0].id], 'owner')
            self.act(db, self.access(db, 0), self.users[4].id, 'owner')
            self.act(db, self.access(db, 0), self.users[0].id, 'viewer')
            self.act(db, self.access(db, 4), self.users[3].id, 'admin')
            self.act(db, self.access(db, 2), self.users[1].id, 'operator')
            self.act(db, self.access(db, 2), self.users[1].id, 'remove')
        rows = self.rows()
        self.assertEqual(rows[self.users[4].id], 'owner')
        self.assertEqual(rows[self.users[3].id], 'admin')
        self.assertNotIn(self.users[1].id, rows)

    def test_signed_api_authorization_and_denied_write_preservation(self):
        # Controlled ES256 signing/JWKS only; real decoder/dependencies/RLS/routes.
        # This does not claim a native Supabase-issued JWT or deployed HTTP test.
        from app.main import app
        from app.auth import _supabase_auth_settings
        key = ec.generate_private_key(ec.SECP256R1())
        issuer, audience, _ = _supabase_auth_settings()
        def token(index):
            now = datetime.now(timezone.utc)
            return jwt.encode({'sub': str(self.users[index].id), 'email': self.users[index].email,
                'role': 'authenticated', 'iss': issuer, 'aud': audience,
                'iat': now - timedelta(seconds=1), 'exp': now + timedelta(minutes=5)},
                key, algorithm='ES256', headers={'kid': 'ownership-regression'})
        def sessions():
            with Session(self.api, autoflush=False) as db:
                yield db
        app.dependency_overrides[get_db] = sessions
        base = f'/api/v1/organizations/{self.org}/memberships/'
        try:
            with patch('app.auth._jwk_client') as client_keys, TestClient(app) as client:
                client_keys.return_value.get_signing_key_from_jwt.return_value = SimpleNamespace(key=key.public_key())
                cases = [(2, 'post', 4, '/transfer-ownership', None, 403),
                         (2, 'patch', 0, '', {'role':'viewer'}, 403),
                         (2, 'delete', 0, '', None, 403),
                         (2, 'patch', 4, '', {'role':'admin'}, 403),
                         (3, 'delete', 4, '', None, 403),
                         (4, 'patch', 3, '', {'role':'viewer'}, 403),
                         (5, 'delete', 0, '', None, 404)]
                for actor, method, target, suffix, body, expected in cases:
                    with self.subTest(actor=actor, method=method, target=target):
                        before = self.rows()
                        response = client.request(method, base+str(self.users[target].id)+suffix,
                            headers={'Authorization':'Bearer '+token(actor)}, **({'json': body} if body else {}))
                        self.assertEqual(response.status_code, expected)
                        self.assertEqual(self.rows(), before)
                stale_token = token(1)
                response = client.patch(base+str(self.users[1].id), json={'role':'viewer'},
                    headers={'Authorization':'Bearer '+token(0)})
                self.assertEqual(response.status_code, 200)
                before = self.rows()
                response = client.post(base+str(self.users[4].id)+'/transfer-ownership',
                    headers={'Authorization':'Bearer '+stale_token})
                self.assertEqual(response.status_code, 403)
                self.assertEqual(self.rows(), before)
        finally:
            app.dependency_overrides.pop(get_db, None)


if __name__ == '__main__':
    unittest.main()
