import os
from dataclasses import dataclass
from functools import lru_cache
from urllib.parse import urlparse
from uuid import UUID

import jwt
from fastapi import Depends, HTTPException, Path, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWKClient
from jwt.exceptions import PyJWKClientConnectionError
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.organization_memberships import OrganizationMembership

bearer_scheme = HTTPBearer(auto_error=False)
ALLOWED_JWT_ALGORITHMS = ("RS256", "ES256")
ORGANIZATION_ROLES = frozenset({"owner", "admin", "operator", "viewer"})


@dataclass(frozen=True)
class CurrentUser:
    id: UUID
    email: str | None
    session_id: UUID | None


@dataclass(frozen=True)
class OrganizationAccess:
    organization_id: UUID
    user: CurrentUser
    role: str


def _auth_error(detail: str = "Invalid or expired access token") -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def _auth_service_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Authentication service temporarily unavailable",
    )


@lru_cache(maxsize=1)
def _supabase_auth_settings() -> tuple[str, str, str]:
    supabase_url = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
    if not supabase_url:
        raise RuntimeError("SUPABASE_URL is not set")

    parsed = urlparse(supabase_url)
    if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1"}:
        raise RuntimeError("SUPABASE_URL must use HTTPS")

    issuer = f"{supabase_url}/auth/v1"
    audience = os.getenv("SUPABASE_JWT_AUDIENCE", "authenticated").strip()
    return issuer, audience, f"{issuer}/.well-known/jwks.json"


@lru_cache(maxsize=1)
def _jwk_client() -> PyJWKClient:
    _, _, jwks_url = _supabase_auth_settings()
    # Supabase Edge caches JWKS for ten minutes; do not retain signing keys longer.
    return PyJWKClient(jwks_url, cache_jwk_set=True, lifespan=600, timeout=5)


def _decode_access_token(token: str) -> dict:
    try:
        header = jwt.get_unverified_header(token)
        algorithm = header.get("alg")
        if algorithm not in ALLOWED_JWT_ALGORITHMS:
            raise _auth_error("Unsupported access-token signing algorithm")

        issuer, audience, _ = _supabase_auth_settings()
        signing_key = _jwk_client().get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=[algorithm],
            audience=audience,
            issuer=issuer,
            options={"require": ["exp", "iat", "sub", "iss", "aud"]},
        )
    except HTTPException:
        raise
    except PyJWKClientConnectionError as exc:
        raise _auth_service_error() from exc
    except (jwt.PyJWTError, ValueError, RuntimeError) as exc:
        raise _auth_error() from exc

    if claims.get("role") != "authenticated":
        raise _auth_error("An authenticated user session is required")
    return claims


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> CurrentUser:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise _auth_error("Bearer access token required")

    claims = _decode_access_token(credentials.credentials)
    try:
        user_id = UUID(claims["sub"])
        session_id = UUID(claims["session_id"]) if claims.get("session_id") else None
    except (KeyError, TypeError, ValueError) as exc:
        raise _auth_error("Access token has invalid identity claims") from exc

    return CurrentUser(id=user_id, email=claims.get("email"), session_id=session_id)


def set_request_user_context(db: Session, user_id: UUID) -> None:
    db.execute(
        text("select set_config('app.current_user_id', :user_id, true)"),
        {"user_id": str(user_id)},
    )


def require_organization_role(*allowed_roles: str):
    invalid = set(allowed_roles) - ORGANIZATION_ROLES
    if invalid:
        raise ValueError(f"Unknown organization roles: {sorted(invalid)}")

    def dependency(
        organization_id: UUID = Path(...),
        user: CurrentUser = Depends(get_current_user),
        db: Session = Depends(get_db),
    ) -> OrganizationAccess:
        set_request_user_context(db, user.id)
        membership = (
            db.query(OrganizationMembership)
            .filter(
                OrganizationMembership.organization_id == organization_id,
                OrganizationMembership.user_id == user.id,
            )
            .one_or_none()
        )
        if membership is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Organization not found")
        if membership.role not in allowed_roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permission")

        db.execute(
            text("select set_config('app.current_organization_id', :organization_id, true)"),
            {"organization_id": str(organization_id)},
        )
        return OrganizationAccess(
            organization_id=organization_id, user=user, role=membership.role
        )

    return dependency


require_viewer = require_organization_role("owner", "admin", "operator", "viewer")
require_operator = require_organization_role("owner", "admin", "operator")
require_admin = require_organization_role("owner", "admin")
