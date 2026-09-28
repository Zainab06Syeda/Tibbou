from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

SNOWFLAKE_IDENTIFIER_PATTERN = r"^[A-Za-z_][A-Za-z0-9_$]{0,254}$"
BLOCKED_ROLES = frozenset(
    {"ACCOUNTADMIN", "ORGADMIN", "SECURITYADMIN", "SYSADMIN", "USERADMIN", "PUBLIC"}
)


class SnowflakeConnectionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    account_identifier: str = Field(min_length=1, max_length=255)
    user_name: str = Field(pattern=SNOWFLAKE_IDENTIFIER_PATTERN)
    role_name: str = Field(pattern=SNOWFLAKE_IDENTIFIER_PATTERN)
    warehouse_name: str = Field(pattern=SNOWFLAKE_IDENTIFIER_PATTERN)

    @field_validator("name", "account_identifier", mode="before")
    @classmethod
    def strip_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value

    @field_validator("user_name", "role_name", "warehouse_name", mode="before")
    @classmethod
    def normalize_identifier(cls, value: Any) -> Any:
        return value.strip().upper() if isinstance(value, str) else value

    @field_validator("role_name")
    @classmethod
    def require_limited_role(cls, value: str) -> str:
        if value in BLOCKED_ROLES:
            raise ValueError("Use a dedicated least-privilege Snowflake role")
        return value
class SnowflakeConnectionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=120)
    account_identifier: str | None = Field(default=None, min_length=1, max_length=255)
    user_name: str | None = Field(default=None, pattern=SNOWFLAKE_IDENTIFIER_PATTERN)
    role_name: str | None = Field(default=None, pattern=SNOWFLAKE_IDENTIFIER_PATTERN)
    warehouse_name: str | None = Field(default=None, pattern=SNOWFLAKE_IDENTIFIER_PATTERN)

    @field_validator(
        "name",
        "account_identifier",
        "user_name",
        "role_name",
        "warehouse_name",
        mode="before",
    )
    @classmethod
    def reject_explicit_null(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("Connection fields cannot be null")
        return value

    @field_validator("name", "account_identifier", mode="before")
    @classmethod
    def strip_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value

    @field_validator("user_name", "role_name", "warehouse_name", mode="before")
    @classmethod
    def normalize_identifier(cls, value: Any) -> Any:
        return value.strip().upper() if isinstance(value, str) else value

    @field_validator("role_name")
    @classmethod
    def require_limited_role(cls, value: str | None) -> str | None:
        if value in BLOCKED_ROLES:
            raise ValueError("Use a dedicated least-privilege Snowflake role")
        return value


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
    lifecycle_state: str
    public_key: str | None
    public_key_fingerprint: str | None
    key_pair_name: str | None
    key_expires_at: datetime | None
    registration_sql: str | None = None
    status: str
    capabilities: dict[str, Any]
    enabled: bool
    validation_error: str | None
    last_validated_at: datetime | None
    last_success_at: datetime | None
    created_at: datetime
    updated_at: datetime
