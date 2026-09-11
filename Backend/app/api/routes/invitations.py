from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from psycopg2.errors import UniqueViolation
from sqlalchemy import func, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import (
    CurrentUser,
    OrganizationAccess,
    get_current_user,
    normalize_email,
    require_admin,
    set_request_user_context,
)
from app.db import get_db
from app.models.organization_invitations import OrganizationInvitation
from app.models.organization_memberships import OrganizationMembership
from app.models.organizations import Organization
from app.schemas.organizations import (
    OrganizationInvitationCreate,
    OrganizationInvitationRead,
    OrganizationInvitationSummaryRead,
    OrganizationRead,
)

router = APIRouter(tags=["organization invitations"])


def _require_invitable_role(access: OrganizationAccess, role: str) -> None:
    if role == "admin" and access.role != "owner":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only owners can invite administrators",
        )


@router.get("/api/v1/invitations", response_model=list[OrganizationInvitationSummaryRead])
def list_my_invitations(
    user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[OrganizationInvitationSummaryRead]:
    if not normalize_email(user.email):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Authenticated account has no email address",
        )
    set_request_user_context(db, user.id, user.email)
    rows = db.execute(
        text("select * from private.list_request_user_organization_invitations()")
    ).mappings()
    return [OrganizationInvitationSummaryRead.model_validate(row) for row in rows]


@router.post(
    "/api/v1/invitations/{invitation_id}/accept",
    response_model=OrganizationRead,
    status_code=status.HTTP_201_CREATED,
)
def accept_invitation(
    invitation_id: UUID,
    user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> OrganizationRead:
    email = normalize_email(user.email)
    if not email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Authenticated account has no email address",
        )
    set_request_user_context(db, user.id, email)
    invitation = (
        db.query(OrganizationInvitation)
        .filter(
            OrganizationInvitation.id == invitation_id,
            OrganizationInvitation.email == email,
            OrganizationInvitation.expires_at > func.now(),
        )
        .with_for_update()
        .one_or_none()
    )
    if invitation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invitation not found")

    existing = (
        db.query(OrganizationMembership)
        .filter(
            OrganizationMembership.organization_id == invitation.organization_id,
            OrganizationMembership.user_id == user.id,
        )
        .one_or_none()
    )
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="User is already an organization member",
        )

    membership = OrganizationMembership(
        organization_id=invitation.organization_id,
        user_id=user.id,
        role=invitation.role,
    )
    try:
        db.add(membership)
        db.flush()
        db.delete(invitation)
        db.flush()
        organization = (
            db.query(Organization)
            .filter(Organization.id == membership.organization_id)
            .one()
        )
        result = OrganizationRead(
            id=organization.id,
            name=organization.name,
            slug=organization.slug,
            role=membership.role,
            created_at=organization.created_at,
        )
        db.commit()
        return result
    except IntegrityError as exc:
        db.rollback()
        constraint_name = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
        if constraint_name == "uq_organization_memberships_org_user":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="User is already an organization member",
            ) from exc
        raise


@router.post(
    "/api/v1/organizations/{organization_id}/invitations",
    response_model=OrganizationInvitationRead,
    status_code=status.HTTP_201_CREATED,
)
def create_invitation(
    payload: OrganizationInvitationCreate,
    access: OrganizationAccess = Depends(require_admin),
    db: Session = Depends(get_db),
) -> OrganizationInvitationRead:
    _require_invitable_role(access, payload.role)
    invitation = OrganizationInvitation(
        organization_id=access.organization_id,
        email=payload.email,
        role=payload.role,
        invited_by=access.user.id,
    )
    try:
        db.add(invitation)
        db.flush()
        db.refresh(invitation)
        result = OrganizationInvitationRead.model_validate(invitation)
        db.commit()
        return result
    except IntegrityError as exc:
        db.rollback()
        constraint_name = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
        if isinstance(exc.orig, UniqueViolation) and constraint_name == "uq_organization_invitations_org_email":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Invitation already exists",
            ) from exc
        raise


@router.delete(
    "/api/v1/organizations/{organization_id}/invitations/{invitation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_invitation(
    invitation_id: UUID,
    access: OrganizationAccess = Depends(require_admin),
    db: Session = Depends(get_db),
) -> None:
    invitation = (
        db.query(OrganizationInvitation)
        .filter(
            OrganizationInvitation.id == invitation_id,
            OrganizationInvitation.organization_id == access.organization_id,
        )
        .one_or_none()
    )
    if invitation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invitation not found")
    _require_invitable_role(access, invitation.role)
    db.delete(invitation)
    db.commit()
