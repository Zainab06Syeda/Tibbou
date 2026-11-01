import json
import os
import unittest
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from sqlalchemy import MetaData, Uuid, create_engine, event, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

os.environ.setdefault("DATABASE_URL", "postgresql://tibbou_api_login@localhost:5432/tibbou")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")

from app.auth import get_current_user
from app.auth_identity import AuthUnavailable
from app.db import get_db
from app.main import app, create_app
from app.sso import sso_connections
from app.models.organizations import Organization
from app.models.organization_memberships import OrganizationMembership
from app.models.organization_invitations import OrganizationInvitation
from tests.test_auth_identity import auth_user

USER_A = "10000000-0000-0000-0000-000000000001"
USER_B = "10000000-0000-0000-0000-000000000002"
ORG_A = "20000000-0000-0000-0000-000000000001"
ORG_B = "20000000-0000-0000-0000-000000000002"
PROVIDER_A = "30000000-0000-0000-0000-000000000001"
PROVIDER_B = "30000000-0000-0000-0000-000000000002"
INVITATION = "40000000-0000-0000-0000-000000000001"
INVITATION_B = "40000000-0000-0000-0000-000000000002"


@contextmanager
def tenant_database():
    """Execute production query predicates in SQLite; not PostgreSQL/RLS evidence."""
    context = {}
    class FixtureSession(Session):
        def execute(self, statement, params=None, **kwargs):
            sql = str(statement)
            if "set_config(" in sql:
                context.update(params or {})
                return MagicMock()  # Transaction-local Postgres context is tested separately.
            if "pg_advisory_xact_lock" in sql:
                return MagicMock()  # SQLite does not establish lock/concurrency correctness.
            if "private.list_request_user_organization_invitations()" in sql:
                # Replace only the PostgreSQL set-returning function; keep the route's WHERE verbatim.
                summary = """(select i.id, i.organization_id, o.name as organization_name,
                    o.slug as organization_slug, i.role, i.expires_at
                    from organization_invitations i join organizations o on o.id = i.organization_id
                    where i.email = :request_email and i.expires_at > CURRENT_TIMESTAMP
                    and not exists (select 1 from organization_memberships m
                        where m.organization_id = i.organization_id and m.user_id = :request_user))"""
                statement = text(sql.replace("private.list_request_user_organization_invitations()", summary))
                params = {**(params or {}), "request_email": context["email"],
                          "request_user": UUID(context["user_id"]).hex}
                params = {name: value.hex if isinstance(value, UUID) else value for name, value in params.items()}
            return super().execute(statement, params=params, **kwargs)

    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    @event.listens_for(engine, "connect")
    def sqlite_functions(connection, _):
        connection.create_function("btrim", 1, lambda value: value.strip())
    metadata = MetaData()
    for model in (Organization, OrganizationMembership, OrganizationInvitation):
        model.__table__.to_metadata(metadata)
    for table in metadata.tables.values():
        for column in table.columns:
            if isinstance(column.type, Uuid):
                column.type = Uuid(native_uuid=False)  # Avoid SQLite numeric affinity for digit-only UUIDs.
    metadata.tables["organization_invitations"].c.expires_at.server_default = None
    metadata.create_all(engine)
    previous = app.dependency_overrides[get_db]
    try:
        with FixtureSession(engine, autoflush=False, expire_on_commit=False) as session:
            now = datetime.now(timezone.utc)
            for org, slug, name in ((ORG_A, "acme", "Customer A"), (ORG_B, "other", "Customer B")):
                session.add(Organization(id=UUID(org), name=name, slug=slug, created_at=now))
            session.flush()
            for invitation, org, role in ((INVITATION, ORG_A, "viewer"), (INVITATION_B, ORG_B, "operator")):
                session.add(OrganizationInvitation(id=UUID(invitation), organization_id=UUID(org),
                    email="member@example.com", role=role, invited_by=UUID(USER_A),
                    created_at=now, expires_at=now + timedelta(days=7)))
            session.commit()
            db = MagicMock(wraps=session)
            app.dependency_overrides[get_db] = lambda: db
            yield db
    finally:
        app.dependency_overrides[get_db] = previous
        engine.dispose()


def connection(organization=ORG_A, provider=PROVIDER_A, slug="acme", **changes):
    return {"organization_id": organization, "provider_id": provider,
            "organization_slug": slug, "idp": "okta", "enabled": True, **changes}


class RegistryTests(unittest.TestCase):
    def tearDown(self):
        sso_connections.cache_clear()

    def test_empty_default_and_explicit_disabled_default(self):
        for raw, expected in (("[]", 0), (json.dumps([connection(enabled=False)]), 1)):
            with patch.dict(os.environ, {"ENTERPRISE_SSO_CONNECTIONS": raw}):
                sso_connections.cache_clear()
                self.assertEqual(len(sso_connections()), expected)
        row = connection()
        row.pop("enabled")
        with patch.dict(os.environ, {"ENTERPRISE_SSO_CONNECTIONS": json.dumps([row])}):
            sso_connections.cache_clear()
            self.assertFalse(sso_connections()[0].enabled)

    def test_registry_rejects_duplicates_conflicts_and_malformed_input_atomically(self):
        cases = ["not-json", "{}", '[{"enabled":true,"enabled":false}]']
        rows = [[connection(), connection(ORG_B, PROVIDER_A, "other")],
                [connection(), connection(ORG_A, PROVIDER_B, "acme")],
                [connection(), connection(ORG_B, PROVIDER_B, "acme")],
                [connection(), connection(ORG_A, PROVIDER_B, "renamed", idp="entra")],
                [connection(enabled="true")], [connection(provider_id="bad")],
                [connection(organization_slug=" acme")], [connection(idp="unsupported")],
                [connection(secret="must-not-be-accepted")]]
        for raw in cases + [json.dumps(value) for value in rows]:
            with self.subTest(raw=raw), patch.dict(os.environ, {"ENTERPRISE_SSO_CONNECTIONS": raw}):
                sso_connections.cache_clear()
                with self.assertRaisesRegex(RuntimeError, "^Invalid ENTERPRISE_SSO_CONNECTIONS configuration$"):
                    create_app()


class SsoApiTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            "SUPABASE_URL": "https://example.supabase.co",
            "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_test",
            "ENTERPRISE_SSO_CONNECTIONS": json.dumps([
                connection(), connection(ORG_B, PROVIDER_B, "other"),
            ]),
        })
        self.env.start()
        sso_connections.cache_clear()
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.jwks = patch("app.auth._jwk_client")
        self.jwks.start().return_value.get_signing_key_from_jwt.return_value = SimpleNamespace(key=self.key.public_key())
        self.settings = patch("app.auth._supabase_auth_settings", return_value=(
            "https://example.supabase.co/auth/v1", "authenticated", "unused"
        ))
        self.settings.start()
        self.requests = []
        self.provider = None
        self.auth_status = 200
        self.db = MagicMock()
        app.dependency_overrides[get_db] = lambda: self.db
        client = httpx.AsyncClient(transport=httpx.MockTransport(self.auth_request))
        self.factory = patch("app.main.create_auth_client", return_value=client)
        self.factory.start()
        self.client = TestClient(app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        app.dependency_overrides.pop(get_db, None)
        self.factory.stop()
        self.settings.stop()
        self.jwks.stop()
        self.env.stop()
        sso_connections.cache_clear()

    def auth_request(self, request):
        self.requests.append(request)
        token = request.headers["authorization"].removeprefix("Bearer ")
        # The application validates the signature; this stub only selects its fixture.
        sub = jwt.decode(token, options={"verify_signature": False})["sub"]
        provider = self.provider or (f"sso:{PROVIDER_A}" if sub == USER_A else f"sso:{PROVIDER_B}")
        return httpx.Response(self.auth_status, json=auth_user(provider, user_id=sub))

    def headers(self, sub=USER_A, **changes):
        now = datetime.now(timezone.utc)
        claims = {"sub": sub, "iss": "https://example.supabase.co/auth/v1",
                  "aud": "authenticated", "role": "authenticated", "iat": now,
                  "exp": now + timedelta(minutes=5), **changes}
        return {"Authorization": "Bearer " + jwt.encode(claims, self.key, algorithm="ES256", headers={"kid": "offline"})}

    def test_public_lookup_returns_only_routing_and_never_calls_auth_or_database(self):
        response = self.client.get("/api/v1/organizations/acme/sso")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"provider_id": PROVIDER_A, "idp": "okta"})
        self.assertEqual(response.headers["cache-control"], "no-store")
        missing = self.client.get("/api/v1/organizations/missing/sso")
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.headers["cache-control"], "no-store")
        self.assertFalse(self.requests)
        self.db.execute.assert_not_called()

    def test_all_organization_routes_deny_cross_tenant_before_any_business_effect(self):
        with patch("app.api.routes.connections.generate_key_pair") as keys, patch("app.api.routes.invitations.send_invitation_email") as email:
            for sub, forbidden_org in ((USER_A, ORG_B), (USER_B, ORG_A)):
                for route in app.routes:
                    if not isinstance(route, APIRoute) or "{organization_id}" not in route.path:
                        continue
                    path = route.path.replace("{organization_id}", forbidden_org)
                    for parameter in ("connection_id", "dataset_id", "edge_id", "cost_id", "invitation_id", "sync_run_id", "user_id", "request_id"):
                        path = path.replace("{" + parameter + "}", INVITATION)
                    for method in route.methods:
                        with self.subTest(sub=sub, route=route.path, method=method):
                            self.db.reset_mock()
                            response = self.client.request(method, path, headers=self.headers(sub), json={} if method in {"POST", "PATCH"} else None)
                            self.assertEqual(response.status_code, 404, response.text)
                            self.db.query.assert_not_called()
                            self.db.execute.assert_not_called()
                            self.db.add.assert_not_called()
                            self.db.commit.assert_not_called()
            keys.assert_not_called()
            email.assert_not_called()

    def test_sso_cannot_create_org_or_request_domain_join_and_domain_match_is_empty(self):
        for path, body in (("/api/v1/organizations", {"name": "Forged workspace"}),
                           ("/api/v1/organizations/domain-join-requests", {})):
            response = self.client.post(path, json=body, headers=self.headers())
            self.assertEqual(response.status_code, 403, response.text)
        response = self.client.get("/api/v1/organizations/domain-match", headers=self.headers())
        self.assertEqual(response.json(), {"organization": None, "allow_domain_join": False, "already_requested": False})
        self.db.execute.assert_not_called()
        self.db.add.assert_not_called()

    def test_disabled_removed_unknown_and_misbound_providers_fail_closed(self):
        for rows in ([], [connection(enabled=False)], [connection(provider_id=PROVIDER_B)],
                     [connection(ORG_B, PROVIDER_A, "other")]):
            with self.subTest(rows=rows), patch.dict(os.environ, {"ENTERPRISE_SSO_CONNECTIONS": json.dumps(rows)}):
                sso_connections.cache_clear()
                response = self.client.get(f"/api/v1/organizations/{ORG_A}/admin", headers=self.headers())
                self.assertIn(response.status_code, (403, 404))
                self.db.query.assert_not_called()
        sso_connections.cache_clear()

    def test_invalid_jwt_is_rejected_before_auth_lookup(self):
        for changes in ({"iss": "https://okta.example"}, {"aud": "wrong"},
                        {"exp": datetime.now(timezone.utc) - timedelta(minutes=1)}, {"sub": "not-a-uuid"}):
            with self.subTest(changes=changes):
                response = self.client.get("/api/v1/organizations", headers=self.headers(**changes))
                self.assertEqual(response.status_code, 401)
        self.assertFalse(self.requests)

    def test_malformed_and_contradictory_sso_claims_are_rejected(self):
        for amr in ({}, ["sso/saml"], [{"method": "sso/saml", "timestamp": 1, "provider": PROVIDER_B}],
                    [{"method": "oauth", "timestamp": 1}]):
            with self.subTest(amr=amr):
                response = self.client.get("/api/v1/organizations", headers=self.headers(amr=amr))
                self.assertEqual(response.status_code, 401)
        self.db.execute.assert_not_called()

    def test_password_and_entra_still_reach_their_membership_queries(self):
        for provider in ("email", "azure"):
            self.provider = provider
            query = MagicMock()
            query.join.return_value = query
            query.filter.return_value = query
            query.order_by.return_value = query
            query.all.return_value = []
            self.db.query.return_value = query
            with self.subTest(provider=provider):
                response = self.client.get("/api/v1/organizations", headers=self.headers())
                self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(self.requests), 2)

    def test_missing_amr_remains_bound_even_if_membership_mock_grants_another_org(self):
        self.db.query.return_value.filter.return_value.one_or_none.return_value = SimpleNamespace(role="owner")
        response = self.client.get(f"/api/v1/organizations/{ORG_B}/admin", headers=self.headers())
        self.assertEqual(response.status_code, 404)
        self.db.query.assert_not_called()

    def test_own_provider_still_requires_membership_and_preserves_roles(self):
        for sub, organization in ((USER_A, ORG_A), (USER_B, ORG_B)):
            for membership, expected in ((None, 404), (SimpleNamespace(role="viewer"), 403)):
                with self.subTest(sub=sub, role=membership):
                    self.db.query.return_value.filter.return_value.one_or_none.return_value = membership
                    response = self.client.get(f"/api/v1/organizations/{organization}/admin", headers=self.headers(sub))
                    self.assertEqual(response.status_code, expected, response.text)

    def test_organization_discovery_requires_both_user_membership_and_provider_scope(self):
        with tenant_database() as db:
            # Deliberate foreign memberships prove provider scope is independent of membership.
            for sub in (USER_A, USER_B):
                for org in (ORG_A, ORG_B):
                    db.add(OrganizationMembership(user_id=UUID(sub), organization_id=UUID(org), role="viewer"))
            db.commit()
            db.reset_mock()
            for sub, organization, name in ((USER_A, ORG_A, "Customer A"), (USER_B, ORG_B, "Customer B")):
                response = self.client.get("/api/v1/organizations", headers=self.headers(sub))
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual([(row["id"], row["name"]) for row in response.json()], [(organization, name)])
            db.add.assert_not_called()
            db.commit.assert_not_called()

    def test_own_organization_invitation_grants_only_its_approved_role(self):
        with tenant_database() as db, patch("app.api.routes.invitations.send_invitation_email") as email:
            for sub, foreign in ((USER_A, INVITATION_B), (USER_B, INVITATION)):
                response = self.client.post(f"/api/v1/invitations/{foreign}/accept", headers=self.headers(sub))
                self.assertEqual(response.status_code, 404, response.text)
            db.add.assert_not_called()
            db.delete.assert_not_called()
            db.commit.assert_not_called()
            self.assertEqual(db.query(OrganizationInvitation).count(), 2)
            for sub, org, invitation, role in ((USER_A, ORG_A, INVITATION, "viewer"), (USER_B, ORG_B, INVITATION_B, "operator")):
                response = self.client.post(f"/api/v1/invitations/{invitation}/accept", headers=self.headers(sub))
                self.assertEqual(response.status_code, 201, response.text)
                self.assertEqual((response.json()["id"], response.json()["role"]), (org, role))
            memberships = db.query(OrganizationMembership).all()
            self.assertEqual({(str(row.user_id), str(row.organization_id), row.role) for row in memberships},
                             {(USER_A, ORG_A, "viewer"), (USER_B, ORG_B, "operator")})
            self.assertEqual(db.query(OrganizationInvitation).count(), 0)
            self.assertEqual(db.commit.call_count, 2)
            email.assert_not_called()

    def test_matching_email_invitations_are_scoped_by_provider_not_email(self):
        with tenant_database() as db:
            for sub, org, invitation in ((USER_A, ORG_A, INVITATION), (USER_B, ORG_B, INVITATION_B)):
                response = self.client.get("/api/v1/invitations", headers=self.headers(sub))
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual([(row["id"], row["organization_id"]) for row in response.json()], [(invitation, org)])
            db.add.assert_not_called()
            db.delete.assert_not_called()
            db.commit.assert_not_called()

    def test_real_invitation_query_rejects_wrong_email_and_expiry_without_writes(self):
        with tenant_database() as db:
            invitation = db.query(OrganizationInvitation).filter(OrganizationInvitation.id == UUID(INVITATION)).one()
            for email, expired in (("someone-else@example.com", False), ("member@example.com", True)):
                invitation.email = email
                invitation.created_at = datetime.now(timezone.utc) - timedelta(days=7)
                invitation.expires_at = datetime.now(timezone.utc) + timedelta(days=-1 if expired else 1)
                db.commit()
                db.reset_mock()
                response = self.client.post(f"/api/v1/invitations/{INVITATION}/accept", headers=self.headers())
                self.assertEqual(response.status_code, 404, response.text)
                db.add.assert_not_called()
                db.delete.assert_not_called()
                db.commit.assert_not_called()

    def test_other_org_invitation_cannot_be_accepted_or_consumed(self):
        query = MagicMock()
        query.filter.return_value = query
        query.one_or_none.return_value = SimpleNamespace(organization_id=UUID(ORG_B))
        self.db.query.return_value = query
        response = self.client.post(f"/api/v1/invitations/{INVITATION}/accept", headers=self.headers())
        self.assertEqual(response.status_code, 404, response.text)
        self.db.add.assert_not_called()
        self.db.delete.assert_not_called()
        self.db.commit.assert_not_called()

    def test_auth_failure_is_safe_and_never_reaches_organization_data(self):
        for status, expected in ((401, 401), (403, 401), (429, 503), (500, 503)):
            self.auth_status = status
            response = self.client.get("/api/v1/organizations", headers=self.headers())
            self.assertEqual(response.status_code, expected)
            self.assertNotIn("sb_publishable", response.text)
        self.db.execute.assert_not_called()

    def test_missing_configuration_fails_closed_without_auth_request(self):
        with patch.dict(os.environ, {"SUPABASE_PUBLISHABLE_KEY": ""}):
            response = self.client.get("/api/v1/organizations", headers=self.headers())
        self.assertEqual(response.status_code, 503)
        self.assertFalse(self.requests)
        self.db.execute.assert_not_called()

    def test_auth_timeout_returns_safe_503_without_business_queries(self):
        with patch("app.auth.fetch_auth_user", new=AsyncMock(side_effect=AuthUnavailable("private detail"))):
            response = self.client.get("/api/v1/organizations", headers=self.headers())
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"detail": "Authentication service temporarily unavailable"})
        self.db.execute.assert_not_called()


class RouteCoverageTests(unittest.TestCase):
    def test_every_route_has_scope_enforcement_or_an_explicit_exception(self):
        exceptions = {
            ("GET", "/"), ("GET", "/health"),
            ("GET", "/api/v1/organizations/{organization_slug}/sso"),
            ("GET", "/api/v1/organizations"), ("POST", "/api/v1/organizations"),
            ("GET", "/api/v1/organizations/domain-match"),
            ("POST", "/api/v1/organizations/domain-join-requests"),
            ("GET", "/api/v1/invitations"), ("POST", "/api/v1/invitations/{invitation_id}/accept"),
            ("GET", "/db/ping"),
        }
        public = {("GET", "/"), ("GET", "/health"), ("GET", "/api/v1/organizations/{organization_slug}/sso")}
        def dependencies(node):
            return [node.call, *(call for child in node.dependencies for call in dependencies(child))]
        for route in app.routes:
            if not isinstance(route, APIRoute):
                continue
            calls = dependencies(route.dependant)
            scoped = any(getattr(call, "__qualname__", "").startswith("require_organization_role.<locals>.") for call in calls)
            for method in route.methods:
                with self.subTest(path=route.path, method=method):
                    self.assertTrue(scoped or (method, route.path) in exceptions)
                    if (method, route.path) not in public:
                        self.assertIn(get_current_user, calls)
