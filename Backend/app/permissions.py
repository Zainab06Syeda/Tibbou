"""Single source of truth for role -> capability permissions.

Both the backend and the frontend read the same Database/permissions.json so
the permission matrix never drifts between the two. This module only decides
WHICH roles a capability allows; request auth, membership lookup, and the
404-vs-403 behavior for hiding organization existence from non-members still
live in app.auth.require_organization_role, which this wraps.
"""

import json
from functools import lru_cache
from pathlib import Path
from typing import Callable

from app.auth import OrganizationAccess, require_organization_role

_PERMISSIONS_PATH = Path(__file__).resolve().parents[2] / "Database" / "permissions.json"


@lru_cache(maxsize=1)
def _load_matrix() -> dict:
    return json.loads(_PERMISSIONS_PATH.read_text(encoding="utf-8"))


def allowed_roles_for(capability: str) -> tuple[str, ...]:
    matrix = _load_matrix()
    try:
        return tuple(matrix["capabilities"][capability])
    except KeyError as exc:
        raise KeyError(f"Unknown permission capability: {capability!r}") from exc


def has_permission(role: str, capability: str) -> bool:
    return role in allowed_roles_for(capability)


def require_capability(capability: str) -> Callable[..., OrganizationAccess]:
    """FastAPI dependency factory: same behavior as require_admin/require_viewer/etc,
    except which roles qualify comes from the shared permission matrix instead of
    being hardcoded at the call site."""
    return require_organization_role(*allowed_roles_for(capability))
