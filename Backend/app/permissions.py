"""Single source of truth for role -> capability permissions.

The canonical copy lives at Database/permissions.json, read directly by the
frontend at build time (Frontend/.../lib/permissions.js). The backend keeps
a co-located copy at app/permissions.json (identical content -- see
tests/test_permissions.py, which asserts the two never drift) because a
deployment package only ever contains Backend/'s contents, not its sibling
Database/ folder: resolving the path via Path(__file__).parents[N] worked in
local dev (where Backend/ and Database/ really are siblings on disk) but
broke on Elastic Beanstalk, where there is no Database/ directory on the
instance at all. Reading a file next to this module instead of counting
parent directories works identically regardless of how the app is packaged.

This module only decides WHICH roles a capability allows; request auth,
membership lookup, and the 404-vs-403 behavior for hiding organization
existence from non-members still live in app.auth.require_organization_role,
which this wraps.
"""

import json
from functools import lru_cache
from pathlib import Path
from typing import Callable

from app.auth import OrganizationAccess, require_organization_role

_PERMISSIONS_PATH = Path(__file__).resolve().parent / "permissions.json"


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
