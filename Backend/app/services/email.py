"""Transactional email via Resend.

Deliberately not Snowflake's SYSTEM$SEND_EMAIL: that requires every recipient
to be pre-verified with Snowflake before it will send to them (fine for "alert
me when a task fails", useless for inviting someone who's never touched
Snowflake), and it would tie a platform-level concern -- Tibbou needs to email
people before any organization has even connected a warehouse -- to a specific
customer's own Snowflake credentials.

If RESEND_API_KEY or RESEND_FROM_EMAIL is unset, send_invitation_email logs
the invitation instead of sending it and returns sent=False; callers should
never treat that as an error; the invitation itself is still created and the
accept link is still shown in the admin UI regardless of email delivery.
"""

from html import escape
import logging
import os

import httpx

logger = logging.getLogger("app.email")

RESEND_API_URL = "https://api.resend.com/emails"


def _resend_settings() -> tuple[str, str] | None:
    api_key = os.getenv("RESEND_API_KEY", "").strip()
    from_email = os.getenv("RESEND_FROM_EMAIL", "").strip()
    if not api_key or not from_email:
        return None
    return api_key, from_email


def public_app_url() -> str:
    return os.getenv("PUBLIC_APP_URL", "http://localhost:5173").rstrip("/")


def invitation_accept_url() -> str:
    return f"{public_app_url()}/login"


def _invitation_email_html(organization_name: str, role: str, accept_url: str) -> str:
    organization_name, role, accept_url = map(escape, (organization_name, role, accept_url))
    return (
        f"<p>You've been invited to join <strong>{organization_name}</strong> on Tibbou"
        f" as <strong>{role}</strong>.</p>"
        f'<p><a href="{accept_url}">Sign in to accept</a> — if you don\'t have an account yet,'
        f" sign up with this email address and the invitation will be waiting for you.</p>"
    )


def send_invitation_email(
    *, to_email: str, organization_name: str, role: str, expires_at: str
) -> bool:
    """Returns True if an email was actually handed off to Resend, False if it
    was only logged (no provider configured) or the send failed. Never raises
    -- a failed or unconfigured email must never break invitation creation."""
    accept_url = invitation_accept_url()
    settings = _resend_settings()
    if settings is None:
        logger.info(
            "Email delivery not configured; invitation for %s to join %s (role=%s, "
            "expires=%s) logged instead of sent. Accept link: %s",
            to_email,
            organization_name,
            role,
            expires_at,
            accept_url,
        )
        return False

    api_key, from_email = settings
    try:
        response = httpx.post(
            RESEND_API_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "from": from_email,
                "to": [to_email],
                "subject": f"You've been invited to join {organization_name} on Tibbou",
                "html": _invitation_email_html(organization_name, role, accept_url),
            },
            timeout=10,
        )
        response.raise_for_status()
        return True
    except httpx.HTTPError as exc:
        logger.warning(
            "Failed to send invitation email to %s via Resend: %s. Accept link: %s",
            to_email,
            exc,
            accept_url,
        )
        return False
