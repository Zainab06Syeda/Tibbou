"""Offline contract tests; these do not establish hosted SSO behavior."""

import asyncio
import unittest
from unittest.mock import patch

import httpx

from app.auth_identity import AuthUnavailable, InvalidIdentity, create_auth_client, fetch_auth_user, resolve_identity

USER = "10000000-0000-0000-0000-000000000001"
PROVIDER = "30000000-0000-0000-0000-000000000001"
OTHER_PROVIDER = "30000000-0000-0000-0000-000000000002"


def auth_user(*providers, user_id=USER):
    return {
        "id": user_id,
        "email": "member@example.com",
        "identities": [{"user_id": user_id, "provider": provider} for provider in providers],
    }


class IdentityContractTests(unittest.TestCase):
    def test_password_entra_and_linked_identities_preserve_non_sso_classification(self):
        for providers in (("email",), ("azure",), ("email", "azure")):
            for amr in ([], [{"method": "oauth", "timestamp": 1}]):
                with self.subTest(providers=providers, amr=amr):
                    result = resolve_identity({"sub": USER, "amr": amr}, auth_user(*providers))
                    self.assertIsNone(result.sso_provider_id)

    def test_missing_or_incomplete_amr_never_removes_sso_binding(self):
        for amr in (None, [], [{"method": "sso/saml", "timestamp": 1}]):
            claims = {"sub": USER}
            if amr is not None:
                claims["amr"] = amr
            with self.subTest(amr=amr):
                result = resolve_identity(claims, auth_user(f"sso:{PROVIDER}"))
                self.assertEqual(str(result.sso_provider_id), PROVIDER)

    def test_mfa_refresh_and_duplicate_entries_preserve_binding_in_any_order(self):
        saml = {"method": "sso/saml", "timestamp": 1, "provider": PROVIDER}
        mfa = {"method": "totp", "timestamp": 2}
        refresh = {"method": "token_refresh", "timestamp": 3}
        for amr in ([saml, mfa, refresh], [refresh, mfa, saml], [saml, saml]):
            result = resolve_identity({"sub": USER, "amr": amr}, auth_user(f"sso:{PROVIDER}"))
            self.assertEqual(str(result.sso_provider_id), PROVIDER)

    def test_untrusted_metadata_does_not_control_binding_or_roles(self):
        claims = {"sub": USER, "user_metadata": {"provider": "email", "role": "owner"}}
        result = resolve_identity(claims, auth_user(f"sso:{PROVIDER}"))
        self.assertEqual(str(result.sso_provider_id), PROVIDER)

    def test_auth_owned_metadata_cannot_contradict_authoritative_identities(self):
        for metadata, providers in (({"provider": "email"}, (f"sso:{PROVIDER}",)),
                                    ({"providers": [f"sso:{PROVIDER}"]}, ("email",)),
                                    ({"provider": f"sso:{OTHER_PROVIDER}"}, (f"sso:{PROVIDER}",))):
            with self.subTest(metadata=metadata), self.assertRaises(InvalidIdentity):
                resolve_identity({"sub": USER, "app_metadata": metadata}, auth_user(*providers))

    def test_invalid_authoritative_identities_are_rejected(self):
        users = [None, {}, auth_user(), auth_user("email", user_id=OTHER_PROVIDER),
                 auth_user(f"sso:{PROVIDER}", "email"), auth_user(f"sso:{PROVIDER}", f"sso:{PROVIDER}"),
                 auth_user("sso:invalid"), auth_user("sso:00000000-0000-0000-0000-000000000000"),
                 auth_user("unknown"), {"id": USER, "identities": [{"provider": "email"}]}]
        for user in users:
            with self.subTest(user=user), self.assertRaises(InvalidIdentity):
                resolve_identity({"sub": USER}, user)

    def test_malformed_or_contradictory_amr_is_rejected(self):
        bad_amr = [None, {}, "sso/saml", ["password"], [{}],
                   [{"method": "password", "timestamp": True}],
                   [{"method": "", "timestamp": 1}],
                   [{"method": "sso/saml", "timestamp": 1, "provider": "bad"}],
                   [{"method": "sso/saml", "timestamp": 1, "provider": OTHER_PROVIDER}],
                   [{"method": "password", "timestamp": 1}],
                   [{"method": "oauth", "timestamp": 1}]]
        for amr in bad_amr:
            with self.subTest(amr=amr), self.assertRaises(InvalidIdentity):
                resolve_identity({"sub": USER, "amr": amr}, auth_user(f"sso:{PROVIDER}"))
        with self.assertRaises(InvalidIdentity):
            resolve_identity({"sub": USER, "amr": [{"method": "sso/saml", "timestamp": 1}]}, auth_user("email"))


class AuthLookupTests(unittest.IsolatedAsyncioTestCase):
    async def lookup(self, handler):
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False) as client:
            return await fetch_auth_user("https://example.supabase.co/auth/v1", "sb_publishable_test", "test-token", client)

    async def test_client_has_bounded_io_and_no_ambient_credentials_or_redirects(self):
        with patch("app.auth_identity.httpx.AsyncClient") as client:
            create_auth_client()
        client.assert_called_once_with(timeout=5.0, follow_redirects=False, trust_env=False)

    async def test_rest_contract_is_top_level_user_not_sdk_wrapper(self):
        def handler(request):
            self.assertEqual(str(request.url), "https://example.supabase.co/auth/v1/user")
            self.assertEqual(request.headers["apikey"], "sb_publishable_test")
            self.assertEqual(request.headers["authorization"], "Bearer test-token")
            return httpx.Response(200, json=auth_user(f"sso:{PROVIDER}"))
        self.assertEqual((await self.lookup(handler))["id"], USER)

    async def test_denied_token_is_not_a_service_failure(self):
        for status in (401, 403):
            with self.subTest(status=status), self.assertRaises(InvalidIdentity):
                await self.lookup(lambda request: httpx.Response(status))

    async def test_server_errors_redirects_and_invalid_json_fail_closed(self):
        for status in (301, 429, 500, 503):
            with self.subTest(status=status), self.assertRaises(AuthUnavailable):
                await self.lookup(lambda request: httpx.Response(status, headers={"location": "https://untrusted.example"}))
        for body in (b"not json", b"[]"):
            with self.subTest(body=body), self.assertRaises(AuthUnavailable):
                await self.lookup(lambda request: httpx.Response(200, content=body))

    async def test_transport_errors_and_timeouts_fail_closed(self):
        for error in (httpx.ConnectError("private detail"), httpx.ReadTimeout("private detail")):
            def handler(request):
                raise error
            with self.subTest(error=type(error).__name__), self.assertRaises(AuthUnavailable):
                await self.lookup(handler)

    async def test_total_deadline_cancels_a_stalled_request(self):
        cancelled = asyncio.Event()
        async def handler(request):
            try:
                await asyncio.sleep(10)
            finally:
                cancelled.set()
            return httpx.Response(200, json=auth_user("email"))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client, asyncio.timeout(1):
            start = asyncio.get_running_loop().time()
            with patch("app.auth_identity.AUTH_LOOKUP_TIMEOUT_SECONDS", 0.05), self.assertRaises(AuthUnavailable):
                await fetch_auth_user("https://example.supabase.co/auth/v1", "sb_publishable_test", "test-token", client)
            elapsed = asyncio.get_running_loop().time() - start
        self.assertTrue(cancelled.is_set())
        self.assertLess(elapsed, 0.5)

    async def test_unconfigured_key_makes_no_request(self):
        with unittest.mock.MagicMock() as client:
            with self.assertRaises(AuthUnavailable):
                await fetch_auth_user("https://example.supabase.co/auth/v1", "", "token", client)
        client.get.assert_not_called()

    async def test_pooled_client_never_reuses_another_users_bearer_header(self):
        tokens = []
        def handler(request):
            tokens.append(request.headers["authorization"])
            return httpx.Response(200, json=auth_user("email"))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await asyncio.gather(*(fetch_auth_user("https://example.supabase.co/auth/v1", "sb_publishable_test", token, client) for token in ("user-one", "user-two")))
            self.assertNotIn("authorization", client.headers)
        self.assertCountEqual(tokens, ["Bearer user-one", "Bearer user-two"])
