"""Operator-reviewed SAML routing. Connections never confer membership."""

import json
import os
from functools import lru_cache
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, StrictBool, TypeAdapter, field_validator


class SsoConnection(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    organization_id: UUID
    organization_slug: str
    provider_id: UUID
    idp: Literal["okta", "entra"]
    enabled: StrictBool = False

    @field_validator("organization_id", "provider_id")
    @classmethod
    def nonzero_uuid(cls, value):
        if value.int == 0:
            raise ValueError("A nonzero UUID is required")
        return value

    @field_validator("organization_slug")
    @classmethod
    def exact_slug(cls, value):
        if not value or value != value.strip() or "/" in value or "\\" in value:
            raise ValueError("Use the existing organization's exact slug")
        return value


def _unique_json_fields(pairs):
    result = {}
    for name, value in pairs:
        if name in result:
            raise ValueError("Duplicate configuration field")
        result[name] = value
    return result


@lru_cache(maxsize=1)
def sso_connections() -> tuple[SsoConnection, ...]:
    try:
        raw = json.loads(os.getenv("ENTERPRISE_SSO_CONNECTIONS", "[]"), object_pairs_hook=_unique_json_fields)
        rows = TypeAdapter(list[SsoConnection]).validate_python(raw)
        provider_ids, organization_providers = set(), set()
        slugs, organizations = {}, {}
        for row in rows:
            pair = (row.organization_id, row.idp)
            if row.provider_id in provider_ids or pair in organization_providers:
                raise ValueError("Duplicate connection")
            if row.organization_slug in slugs and slugs[row.organization_slug] != row.organization_id:
                raise ValueError("Conflicting slug")
            if row.organization_id in organizations and organizations[row.organization_id] != row.organization_slug:
                raise ValueError("Conflicting organization")
            provider_ids.add(row.provider_id)
            organization_providers.add(pair)
            slugs[row.organization_slug] = row.organization_id
            organizations[row.organization_id] = row.organization_slug
        return tuple(rows)
    except (ValueError, TypeError):
        # Do not put configuration values into startup errors or logs.
        raise RuntimeError("Invalid ENTERPRISE_SSO_CONNECTIONS configuration") from None


def connection_for_provider(provider_id: UUID) -> SsoConnection | None:
    return next((row for row in sso_connections() if row.provider_id == provider_id and row.enabled), None)


def connection_for_slug(slug: str, idp: str) -> SsoConnection | None:
    return next((row for row in sso_connections() if row.organization_slug == slug and row.idp == idp and row.enabled), None)
