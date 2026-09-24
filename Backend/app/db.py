import os
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import declarative_base, sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL is not set")

engine_options = {
    "pool_pre_ping": True,
    "pool_size": int(os.getenv("DATABASE_POOL_SIZE", "3")),
    "max_overflow": int(os.getenv("DATABASE_MAX_OVERFLOW", "0")),
    "pool_recycle": 300,
}
if DATABASE_URL.startswith("postgresql"):
    database_host = make_url(DATABASE_URL).host
    if os.getenv("APP_ENV", "development").lower() == "production":
        root_cert = os.getenv("DATABASE_SSL_ROOT_CERT", "")
        if not root_cert or not Path(root_cert).is_file():
            raise RuntimeError("DATABASE_SSL_ROOT_CERT must name an existing CA file")
        engine_options["connect_args"] = {
            "sslmode": "verify-full",
            "sslrootcert": root_cert,
        }
    elif database_host in {"127.0.0.1", "localhost"}:
        engine_options["connect_args"] = {"sslmode": "disable"}
    else:
        engine_options["connect_args"] = {"sslmode": "require"}

engine = create_engine(DATABASE_URL, **engine_options)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
