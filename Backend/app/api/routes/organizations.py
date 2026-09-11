from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth import (
    CurrentUser,
    OrganizationAccess,
    get_current_user,
    require_admin,
    set_request_user_context,
)
from app.db import get_db
from app.models.organization_invitations import OrganizationInvitation
from app.models.organization_memberships import OrganizationMembership
from app.models.organizations import Organization
from app.schemas.organizations import (
    OrganizationAdminCurrentUserRead,
    OrganizationAdminRead,
    OrganizationRead,
)

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


@router.get("/{organization_id}/admin", response_model=OrganizationAdminRead)
def get_admin_dashboard(
    access: OrganizationAccess = Depends(require_admin),
    db: Session = Depends(get_db),
) -> OrganizationAdminRead:
    organization = (
        db.query(Organization)
        .filter(Organization.id == access.organization_id)
        .one_or_none()
    )
    if organization is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Organization not found")

    memberships = (
        db.query(OrganizationMembership)
        .filter(OrganizationMembership.organization_id == access.organization_id)
        .order_by(OrganizationMembership.created_at, OrganizationMembership.user_id)
        .all()
    )
    invitations = (
        db.query(OrganizationInvitation)
        .filter(OrganizationInvitation.organization_id == access.organization_id)
        .order_by(OrganizationInvitation.created_at, OrganizationInvitation.id)
        .all()
    )
    return OrganizationAdminRead(
        organization=OrganizationRead(
            id=organization.id,
            name=organization.name,
            slug=organization.slug,
            role=access.role,
            created_at=organization.created_at,
        ),
        memberships=memberships,
        invitations=invitations,
        current_user=OrganizationAdminCurrentUserRead(
            id=access.user.id,
            email=access.user.email,
            role=access.role,
        ),
    )
