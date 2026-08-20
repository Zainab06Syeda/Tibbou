import os

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL is not set")

engine_options = {
    "pool_pre_ping": True,
    "pool_size": int(os.getenv("DATABASE_POOL_SIZE", "5")),
    "max_overflow": int(os.getenv("DATABASE_MAX_OVERFLOW", "5")),
    "pool_recycle": 300,
}
if DATABASE_URL.startswith("postgresql"):
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
