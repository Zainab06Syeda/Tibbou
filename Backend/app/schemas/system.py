from pydantic import BaseModel


class AppStatusResponse(BaseModel):
    name: str
    status: str


class HealthResponse(BaseModel):
    status: str


class DatabasePingResponse(BaseModel):
    db: str
