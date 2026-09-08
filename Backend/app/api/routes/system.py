from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.auth import CurrentUser, get_current_user, set_request_user_context
from app.db import get_db
from app.schemas.system import AppStatusResponse, DatabasePingResponse, HealthResponse

router = APIRouter()


@router.get("/", response_model=AppStatusResponse)
def root() -> AppStatusResponse:
    return AppStatusResponse(name="Tibbou", status="running")


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok")


@router.get("/db/ping", response_model=DatabasePingResponse)
def db_ping(
    user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)
) -> DatabasePingResponse:
    set_request_user_context(db, user.id)
    db.execute(text("select 1"))
    return DatabasePingResponse(db="ok")
