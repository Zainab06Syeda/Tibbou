import re

FREE_EMAIL_DOMAINS = frozenset(
    {
        "gmail.com",
        "outlook.com",
        "hotmail.com",
        "yahoo.com",
        "icloud.com",
        "proton.me",
        "protonmail.com",
    }
)

_SLUG_INVALID_CHARS = re.compile(r"[^a-z0-9]+")
_SLUG_EDGE_HYPHENS = re.compile(r"^-+|-+$")


def email_domain(email: str | None) -> str | None:
    if not email or "@" not in email:
        return None
    domain = email.strip().lower().rsplit("@", 1)[-1]
    return domain or None


def is_free_email_domain(domain: str | None) -> bool:
    return domain in FREE_EMAIL_DOMAINS if domain else False


def slugify(name: str) -> str:
    base = _SLUG_EDGE_HYPHENS.sub("", _SLUG_INVALID_CHARS.sub("-", name.strip().lower()))
    return base or "organization"


# NOTE: we deliberately don't pre-check slug uniqueness with a SELECT here.
# organizations_read RLS only lets a session see orgs it already belongs to
# or created, so a brand-new user's pre-check would always see zero rows
# regardless of how many other organizations already exist -- it would give
# false confidence, not real collision avoidance. The actual uniqueness
# constraint is enforced by the DB (organizations.slug is UNIQUE); callers
# should catch the IntegrityError and retry with a suffixed slug instead.
