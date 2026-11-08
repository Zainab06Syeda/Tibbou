import os
import sys
import unittest
from unittest.mock import MagicMock, patch

from app import run_worker


class RunWorkerTests(unittest.TestCase):
    def _launch(self, environ):
        ssm = MagicMock()
        ssm.get_parameter.return_value = {
            "Parameter": {"Value": "postgresql://tibbou_worker_login.ref:pw@pooler:5432/postgres"}
        }
        with (
            patch.dict(os.environ, environ, clear=True),
            patch.object(run_worker.boto3, "client", return_value=ssm) as client,
            patch.object(run_worker.os, "execvpe") as execvpe,
        ):
            run_worker.main()
        return client, ssm, execvpe

    def test_worker_gets_its_own_url_and_never_the_api_credentials(self):
        _client, ssm, execvpe = self._launch(
            {
                "DATABASE_URL": "postgresql://tibbou_api_login.ref:pw@pooler:5432/postgres",
                "DATABASE_POOL_SIZE": "3",
                "DATABASE_MAX_OVERFLOW": "0",
                "DATABASE_SSL_ROOT_CERT": "/var/app/current/certs/supabase-ca.crt",
            }
        )

        ssm.get_parameter.assert_called_once_with(
            Name="/tibbou/worker-database-url", WithDecryption=True
        )
        executable, argv, env = execvpe.call_args.args
        self.assertEqual(executable, sys.executable)
        self.assertEqual(argv[1:], ["-m", "app.worker"])
        self.assertNotIn("DATABASE_URL", env)
        self.assertNotIn("DATABASE_POOL_SIZE", env)
        self.assertNotIn("DATABASE_MAX_OVERFLOW", env)
        self.assertTrue(env["WORKER_DATABASE_URL"].startswith("postgresql://tibbou_worker_login."))
        self.assertEqual(env["APP_ENV"], "production")
        self.assertEqual(env["DATABASE_SSL_ROOT_CERT"], "/var/app/current/certs/supabase-ca.crt")

    def test_parameter_name_and_region_are_configurable(self):
        client, ssm, _execvpe = self._launch(
            {"WORKER_DATABASE_URL_PARAMETER": "/other/name", "AWS_REGION": "eu-west-1"}
        )

        self.assertEqual(client.call_args.kwargs["region_name"], "eu-west-1")
        self.assertEqual(ssm.get_parameter.call_args.kwargs["Name"], "/other/name")


if __name__ == "__main__":
    unittest.main()
