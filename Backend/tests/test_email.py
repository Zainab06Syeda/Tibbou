import os
import unittest
from unittest.mock import MagicMock, patch

os.environ.setdefault("DATABASE_URL", "postgresql://localhost:5432/tibbou")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")

import httpx

from app.services import email as email_module
from app.services.email import invitation_accept_url, send_invitation_email


class SendInvitationEmailTests(unittest.TestCase):
    def test_unconfigured_provider_logs_and_reports_not_sent(self):
        with patch.dict(os.environ, {"RESEND_API_KEY": "", "RESEND_FROM_EMAIL": ""}):
            with self.assertLogs("app.email", level="INFO") as logs:
                sent = send_invitation_email(
                    to_email="invitee@example.com",
                    organization_name="Acme",
                    role="viewer",
                    expires_at="2026-10-01T00:00:00+00:00",
                )
        self.assertFalse(sent)
        self.assertTrue(any("invitee@example.com" in message for message in logs.output))
        self.assertTrue(any("logged instead of sent" in message for message in logs.output))

    def test_configured_provider_sends_via_resend(self):
        fake_response = MagicMock()
        fake_response.raise_for_status.return_value = None
        with (
            patch.dict(
                os.environ,
                {"RESEND_API_KEY": "re_test_key", "RESEND_FROM_EMAIL": "invites@tibbou.dev"},
            ),
            patch.object(email_module.httpx, "post", return_value=fake_response) as post,
        ):
            sent = send_invitation_email(
                to_email="invitee@example.com",
                organization_name="Acme",
                role="admin",
                expires_at="2026-10-01T00:00:00+00:00",
            )

        self.assertTrue(sent)
        post.assert_called_once()
        _url, kwargs = post.call_args.args, post.call_args.kwargs
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer re_test_key")
        self.assertEqual(kwargs["json"]["from"], "invites@tibbou.dev")
        self.assertEqual(kwargs["json"]["to"], ["invitee@example.com"])
        self.assertIn("Acme", kwargs["json"]["subject"])
        self.assertIn("admin", kwargs["json"]["html"])

    def test_send_failure_is_caught_and_reported_as_not_sent(self):
        with (
            patch.dict(
                os.environ,
                {"RESEND_API_KEY": "re_test_key", "RESEND_FROM_EMAIL": "invites@tibbou.dev"},
            ),
            patch.object(
                email_module.httpx,
                "post",
                side_effect=httpx.ConnectError("connection refused"),
            ),
        ):
            sent = send_invitation_email(
                to_email="invitee@example.com",
                organization_name="Acme",
                role="viewer",
                expires_at="2026-10-01T00:00:00+00:00",
            )
        self.assertFalse(sent)

    def test_accept_url_points_at_login(self):
        with patch.dict(os.environ, {"PUBLIC_APP_URL": "https://app.tibbou.dev/"}):
            self.assertEqual(invitation_accept_url(), "https://app.tibbou.dev/login")


if __name__ == "__main__":
    unittest.main()
