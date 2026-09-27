from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class SnowflakeConnectionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    account_identifier: str = Field(min_length=1, max_length=255)
    user_name: str | None = Field(default=None, max_length=255)
    role_name: str = Field(min_length=1, max_length=255)
    warehouse_name: str = Field(min_length=1, max_length=255)
    database_name: str | None = Field(default=None, max_length=255)
    auth_method: Literal["external_oauth", "workload_identity", "key_pair"]
    secret_reference: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$")


class SnowflakeConnectionTestRequest(BaseModel):
    """Credentials here are used for exactly one live connection attempt and
    are never persisted -- only the saved connection's secret_reference
    (a label, not a secret) is stored, same as the create endpoint."""

    account_identifier: str = Field(min_length=1, max_length=255)
    user_name: str | None = Field(default=None, max_length=255)
    role_name: str = Field(min_length=1, max_length=255)
    warehouse_name: str = Field(min_length=1, max_length=255)
    database_name: str | None = Field(default=None, max_length=255)
    auth_method: Literal["external_oauth", "key_pair"]
    oauth_token: str | None = None
    private_key_pem: str | None = None
    private_key_passphrase: str | None = None

    @model_validator(mode="after")
    def require_matching_credential(self) -> "SnowflakeConnectionTestRequest":
        if self.auth_method == "key_pair" and not self.private_key_pem:
            raise ValueError("private_key_pem is required for key_pair authentication")
        if self.auth_method == "external_oauth" and not self.oauth_token:
            raise ValueError("oauth_token is required for external_oauth authentication")
        return self


class SnowflakeConnectionTestResult(BaseModel):
    success: bool
    detail: str


class SnowflakeConnectionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    organization_id: UUID
    name: str
    account_identifier: str
    user_name: str | None
    role_name: str
    warehouse_name: str
    auth_method: str
    status: str
    capabilities: dict[str, Any]
    enabled: bool
    last_validated_at: datetime | None
    last_success_at: datetime | None
    created_at: datetime
    updated_at: datetime
