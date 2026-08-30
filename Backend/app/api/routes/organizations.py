from fastapi import APIRouter, Depends, HTTPException, status
from psycopg2.errors import UniqueViolation
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import CurrentUser, get_current_user, set_request_user_context
from app.db import get_db
from app.models.organization_memberships import OrganizationMembership
from app.models.organizations import Organization
from app.schemas.organizations import OrganizationCreate, OrganizationRead

router = APIRouter(prefix="/api/v1/organizations", tags=["organizations"])


@router.get("", response_model=list[OrganizationRead])
def list_organizations(
    user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[OrganizationRead]:
    set_request_user_context(db, user.id)
    rows = (
        db.query(Organization, OrganizationMembership.role)
        .join(
            OrganizationMembership,
            OrganizationMembership.organization_id == Organization.id,
        )
        .filter(OrganizationMembership.user_id == user.id)
        .order_by(Organization.name, Organization.id)
        .all()
    )
    return [
        OrganizationRead(
            id=organization.id,
            name=organization.name,
            slug=organization.slug,
            role=role,
            created_at=organization.created_at,
        )
        for organization, role in rows
    ]


@router.post("", response_model=OrganizationRead, status_code=status.HTTP_201_CREATED)
def create_organization(
    payload: OrganizationCreate,
    user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> OrganizationRead:
    set_request_user_context(db, user.id)
    organization = Organization(name=payload.name.strip(), slug=payload.slug, created_by=user.id)
    try:
        db.add(organization)
        db.flush()
        db.add(
            OrganizationMembership(
                organization_id=organization.id, user_id=user.id, role="owner"
            )
        )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        constraint_name = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
        if isinstance(exc.orig, UniqueViolation) and constraint_name == "organizations_slug_key":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Organization slug exists",
            ) from exc
        raise
    # SET LOCAL context is cleared by commit; restore the validated identity
    # before the RLS-protected refresh starts its next transaction.
    set_request_user_context(db, user.id)
    db.refresh(organization)
    return OrganizationRead(
        id=organization.id,
        name=organization.name,
        slug=organization.slug,
        role="owner",
        created_at=organization.created_at,
    )
