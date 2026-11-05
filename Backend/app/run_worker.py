"""Start the ingestion worker as a second Elastic Beanstalk process.

EB hands every Procfile process the same environment, which includes the
API's DATABASE_URL. The worker refuses to start while API credentials are
present, and the API refuses to start while worker credentials are present,
so the worker's database URL lives in SSM Parameter Store and is loaded only
into this process's environment just before it execs the real worker.
"""

import os
import sys

import boto3

API_ONLY_VARIABLES = ("DATABASE_URL", "DATABASE_POOL_SIZE", "DATABASE_MAX_OVERFLOW")


def main() -> None:
    name = os.getenv("WORKER_DATABASE_URL_PARAMETER", "/tibbou/worker-database-url")
    region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "us-east-1"
    parameter = boto3.client("ssm", region_name=region).get_parameter(
        Name=name, WithDecryption=True
    )
    env = {key: value for key, value in os.environ.items() if key not in API_ONLY_VARIABLES}
    env["WORKER_DATABASE_URL"] = parameter["Parameter"]["Value"]
    env["APP_ENV"] = "production"
    os.execvpe(sys.executable, [sys.executable, "-m", "app.worker"], env)


if __name__ == "__main__":
    main()
