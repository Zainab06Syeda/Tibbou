from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from psycopg2.errors import RaiseException
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.auth import (
    CurrentUser,
    OrganizationAccess,
    get_current_user,
    set_request_user_context,
)
from app.db import get_db
from app.models.organization_invitations import OrganizationInvitation
from app.models.organization_memberships import OrganizationMembership
from app.models.organizations import Organization
from app.permissions import require_capability
from app.schemas.organizations import (
    MembershipRoleUpdate,
    OrganizationAdminCurrentUserRead,
    OrganizationAdminRead,
    OrganizationMembershipRead,
    OrganizationRead,
)
from app.services.organizations import require_can_modify_member, require_invitable_role

router = APIRouter(prefix="/api/v1/organizations", tags=["organizations"])


def _membership_or_404(db: Session, organization_id: UUID, user_id: UUID) -> OrganizationMembership:
    membership = (
        db.query(OrganizationMembership)
        .filter(
            OrganizationMembership.organization_id == organization_id,
            OrganizationMembership.user_id == user_id,
        )
        .one_or_none()
    )
    if membership is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member not found")
    return membership


def _raise_if_last_owner_protection(exc: DBAPIError) -> None:
    if isinstance(exc.orig, RaiseException):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An organization must retain at least one owner. Transfer ownership first.",
        ) from exc
    raise exc


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
    access: OrganizationAccess = Depends(require_capability("manage_members")),
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
    # Emails and names live in Supabase's auth.users, which the runtime role
    # can't read; this function returns them to owners/admins of this org only.
    profiles = {
        row.user_id: row
        for row in db.execute(
            text("select * from private.list_organization_member_profiles(:organization_id)"),
            {"organization_id": str(access.organization_id)},
        )
    }
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
        memberships=[
            OrganizationMembershipRead(
                user_id=membership.user_id,
                role=membership.role,
                created_at=membership.created_at,
                email=getattr(profiles.get(membership.user_id), "email", None),
                display_name=getattr(profiles.get(membership.user_id), "display_name", None),
            )
            for membership in memberships
        ],
        invitations=invitations,
        current_user=OrganizationAdminCurrentUserRead(
            id=access.user.id,
            email=access.user.email,
            role=access.role,
        ),
    )


@router.patch(
    "/{organization_id}/memberships/{user_id}", response_model=OrganizationMembershipRead
)
def change_member_role(
    user_id: UUID,
    payload: MembershipRoleUpdate,
    access: OrganizationAccess = Depends(require_capability("manage_members")),
    db: Session = Depends(get_db),
) -> OrganizationMembershipRead:
    membership = _membership_or_404(db, access.organization_id, user_id)
    require_can_modify_member(access, membership.role)
    require_invitable_role(access, payload.role)

    membership.role = payload.role
    try:
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        _raise_if_last_owner_protection(exc)
    db.refresh(membership)
    return membership


@router.delete("/{organization_id}/memberships/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_member(
    user_id: UUID,
    access: OrganizationAccess = Depends(require_capability("manage_members")),
    db: Session = Depends(get_db),
) -> None:
    membership = _membership_or_404(db, access.organization_id, user_id)
    require_can_modify_member(access, membership.role)

    db.delete(membership)
    try:
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        _raise_if_last_owner_protection(exc)


@router.post(
    "/{organization_id}/memberships/{user_id}/transfer-ownership",
    response_model=OrganizationMembershipRead,
)
def transfer_ownership(
    user_id: UUID,
    access: OrganizationAccess = Depends(require_capability("transfer_ownership")),
    db: Session = Depends(get_db),
) -> OrganizationMembershipRead:
    membership = _membership_or_404(db, access.organization_id, user_id)
    membership.role = "owner"
    db.commit()
    db.refresh(membership)
    return membership
