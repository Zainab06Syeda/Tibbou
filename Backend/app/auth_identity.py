"""Resolve Auth-owned identities without trusting optional JWT provenance."""

import asyncio
from dataclasses import dataclass
from uuid import UUID

import httpx


AUTH_LOOKUP_TIMEOUT_SECONDS = 5.0


class InvalidIdentity(ValueError):
    """The token and authoritative identity cannot establish one principal."""


class AuthUnavailable(Exception):
    """Auth could not supply a usable authoritative response."""


@dataclass(frozen=True)
class AuthIdentity:
    email: str | None
    sso_provider_id: UUID | None


def _provider_uuid(value: object) -> UUID:
    if not isinstance(value, str):
        raise InvalidIdentity()
    try:
        provider_id = UUID(value)
    except ValueError as exc:
        raise InvalidIdentity() from exc
    if provider_id.int == 0:
        raise InvalidIdentity()
    return provider_id


def resolve_identity(claims: dict, user: object) -> AuthIdentity:
    if not isinstance(user, dict) or user.get("id") != claims["sub"]:
        raise InvalidIdentity()
    identities = user.get("identities")
    if not isinstance(identities, list) or not identities:
        raise InvalidIdentity()
    providers = []
    for identity in identities:
        if (
            not isinstance(identity, dict)
            or identity.get("user_id") != claims["sub"]
            or not isinstance(identity.get("provider"), str)
        ):
            raise InvalidIdentity()
        providers.append(identity["provider"])

    sso_providers = [value for value in providers if value.startswith("sso:")]
    if sso_providers:
        # Supabase SAML identities cannot be linked to other identities.
        if len(providers) != 1:
            raise InvalidIdentity()
        provider_id = _provider_uuid(sso_providers[0][4:])
    else:
        if not set(providers).issubset({"email", "azure"}):
            raise InvalidIdentity()
        provider_id = None

    for source in (claims, user):
        metadata = source.get("app_metadata", {})
        if not isinstance(metadata, dict):
            raise InvalidIdentity()
        declared = metadata.get("providers", [])
        if not isinstance(declared, list) or any(not isinstance(value, str) for value in declared):
            raise InvalidIdentity()
        if "provider" in metadata:
            if not isinstance(metadata["provider"], str):
                raise InvalidIdentity()
            declared = [*declared, metadata["provider"]]
        for value in declared:
            if value.startswith("sso:"):
                if _provider_uuid(value[4:]) != provider_id:
                    raise InvalidIdentity()
            elif provider_id is not None:
                raise InvalidIdentity()

    amr = claims.get("amr", [])
    if not isinstance(amr, list):
        raise InvalidIdentity()
    has_saml = False
    has_other_primary = False
    for entry in amr:
        if (
            not isinstance(entry, dict)
            or not isinstance(entry.get("method"), str)
            or not entry["method"].strip()
            or type(entry.get("timestamp")) is not int
            or entry["timestamp"] < 0
        ):
            raise InvalidIdentity()
        if entry["method"] == "sso/saml":
            has_saml = True
            if "provider" in entry and _provider_uuid(entry["provider"]) != provider_id:
                raise InvalidIdentity()
        else:
            if "provider" in entry:
                raise InvalidIdentity()
            if entry["method"] in {"password", "oauth", "email/signup", "otp", "magiclink", "recovery", "invite", "anonymous"}:
                has_other_primary = True
    if (has_saml and provider_id is None) or (provider_id is not None and has_other_primary):
        raise InvalidIdentity()

    email = user.get("email")
    if email is not None and not isinstance(email, str):
        raise InvalidIdentity()
    return AuthIdentity(email=email, sso_provider_id=provider_id)


def create_auth_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=AUTH_LOOKUP_TIMEOUT_SECONDS, follow_redirects=False, trust_env=False
    )


async def fetch_auth_user(
    issuer: str, publishable_key: str, token: str, client: httpx.AsyncClient
) -> dict:
    if not publishable_key:
        raise AuthUnavailable()
    try:
        # Pool connections, never identity responses or bearer headers.
        response = await asyncio.wait_for(
            client.get(
                f"{issuer}/user",
                headers={"apikey": publishable_key, "Authorization": f"Bearer {token}"},
            ),
            timeout=AUTH_LOOKUP_TIMEOUT_SECONDS,
        )
    except (httpx.HTTPError, TimeoutError) as exc:
        raise AuthUnavailable() from exc
    if response.status_code in {401, 403}:
        raise InvalidIdentity()
    if response.status_code != 200:
        raise AuthUnavailable()
    try:
        user = response.json()
    except ValueError as exc:
        raise AuthUnavailable() from exc
    if not isinstance(user, dict):
        raise AuthUnavailable()
    return user
