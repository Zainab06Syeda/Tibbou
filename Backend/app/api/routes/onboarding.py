from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from psycopg2.errors import UniqueViolation
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import (
    CurrentUser,
    OrganizationAccess,
    get_current_user,
    normalize_email,
    set_request_user_context,
)
from app.db import get_db
from app.models.organization_join_requests import OrganizationJoinRequest
from app.models.organization_memberships import OrganizationMembership
from app.models.organizations import Organization
from app.permissions import require_capability
from app.schemas.organizations import (
    DomainMatchRead,
    OrganizationCreate,
    OrganizationJoinRequestRead,
    OrganizationJoinRequestSummaryRead,
    OrganizationRead,
    OrganizationSummaryRead,
)
from app.services.organizations import email_domain, is_free_email_domain, slugify

router = APIRouter(prefix="/api/v1/organizations", tags=["organization onboarding"])


def _require_email(user: CurrentUser) -> str:
    email = normalize_email(user.email)
    if not email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Authenticated account has no email address",
        )
    return email


def _domain_match(db: Session) -> dict | None:
    row = db.execute(
        text("select * from private.find_organization_by_domain()")
    ).mappings().one_or_none()
    return dict(row) if row and row["id"] is not None else None


@router.get("/domain-match", response_model=DomainMatchRead)
def get_domain_match(
    user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DomainMatchRead:
    email = _require_email(user)
    set_request_user_context(db, user.id, email)

    domain = email_domain(email)
    if not domain or is_free_email_domain(domain):
        return DomainMatchRead(organization=None, allow_domain_join=False, already_requested=False)

    match = _domain_match(db)
    if match is None:
        return DomainMatchRead(organization=None, allow_domain_join=False, already_requested=False)

    return DomainMatchRead(
        organization=OrganizationSummaryRead(id=match["id"], name=match["name"], slug=match["slug"]),
        allow_domain_join=False,
        already_requested=match["already_requested"],
    )


@router.post("", response_model=OrganizationRead, status_code=status.HTTP_201_CREATED)
def create_organization(
    payload: OrganizationCreate,
    user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> OrganizationRead:
    email = _require_email(user)
    set_request_user_context(db, user.id, email)

    domain = email_domain(email)
    claimed_domain = domain if domain and not is_free_email_domain(domain) else None

    if claimed_domain is not None:
        existing = _domain_match(db)
        if existing is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"{existing['name']} already uses Tibbou for this email domain. "
                    "Join it or request access instead of creating a new organization."
                ),
            )

    slug = slugify(payload.name)
    for attempt_slug in (slug, f"{slug}-{user.id.hex[:6]}"):
        organization = Organization(
            name=payload.name,
            slug=attempt_slug,
            claimed_email_domain=claimed_domain,
            allow_domain_join=False,
            created_by=user.id,
        )
        try:
            db.add(organization)
            db.flush()
            membership = OrganizationMembership(
                organization_id=organization.id, user_id=user.id, role="owner"
            )
            db.add(membership)
            db.flush()
            result = OrganizationRead(
                id=organization.id,
                name=organization.name,
                slug=organization.slug,
                role="owner",
                created_at=organization.created_at,
            )
            db.commit()
            return result
        except IntegrityError as exc:
            db.rollback()
            constraint_name = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
            if isinstance(exc.orig, UniqueViolation) and constraint_name == "organizations_slug_key":
                set_request_user_context(db, user.id, email)
                continue
            if (
                isinstance(exc.orig, UniqueViolation)
                and constraint_name == "uq_organizations_claimed_email_domain"
            ):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="This email domain was just claimed by another organization.",
                ) from exc
            raise
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT, detail="Could not allocate a unique organization slug"
    )


@router.post(
    "/domain-join-requests",
    response_model=OrganizationJoinRequestRead,
    status_code=status.HTTP_201_CREATED,
)
def request_join_by_domain(
    user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> OrganizationJoinRequestRead:
    email = _require_email(user)
    set_request_user_context(db, user.id, email)

    match = _domain_match(db)
    if match is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No organization matches this email domain",
        )

    join_request = OrganizationJoinRequest(
        organization_id=match["id"], user_id=user.id, email=email
    )
    try:
        db.add(join_request)
        db.flush()
        db.refresh(join_request)
        result = OrganizationJoinRequestRead.model_validate(join_request)
        db.commit()
        return result
    except IntegrityError as exc:
        db.rollback()
        constraint_name = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
        if constraint_name == "ux_organization_join_requests_pending_org_user":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A join request is already pending for this organization",
            ) from exc
        raise


@router.get(
    "/{organization_id}/join-requests",
    response_model=list[OrganizationJoinRequestSummaryRead],
)
def list_join_requests(
    access: OrganizationAccess = Depends(require_capability("manage_members")),
    db: Session = Depends(get_db),
) -> list[OrganizationJoinRequestSummaryRead]:
    return (
        db.query(OrganizationJoinRequest)
        .filter(
            OrganizationJoinRequest.organization_id == access.organization_id,
            OrganizationJoinRequest.status == "pending",
        )
        .order_by(OrganizationJoinRequest.created_at)
        .all()
    )


def _resolve_join_request(
    request_id: UUID, access: OrganizationAccess, db: Session, *, approve: bool
) -> None:
    join_request = (
        db.query(OrganizationJoinRequest)
        .filter(
            OrganizationJoinRequest.id == request_id,
            OrganizationJoinRequest.organization_id == access.organization_id,
            OrganizationJoinRequest.status == "pending",
        )
        .with_for_update()
        .one_or_none()
    )
    if join_request is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Join request not found")

    if approve:
        membership = OrganizationMembership(
            organization_id=access.organization_id, user_id=join_request.user_id, role="viewer"
        )
        db.add(membership)
        db.flush()

    join_request.status = "approved" if approve else "denied"
    join_request.resolved_at = datetime.now(timezone.utc)
    join_request.resolved_by = access.user.id
    db.commit()


@router.post("/{organization_id}/join-requests/{request_id}/approve", status_code=status.HTTP_204_NO_CONTENT)
def approve_join_request(
    request_id: UUID,
    access: OrganizationAccess = Depends(require_capability("manage_members")),
    db: Session = Depends(get_db),
) -> None:
    try:
        _resolve_join_request(request_id, access, db, approve=True)
    except IntegrityError as exc:
        db.rollback()
        constraint_name = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
        if constraint_name == "uq_organization_memberships_org_user":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="User is already an organization member"
            ) from exc
        raise


@router.post("/{organization_id}/join-requests/{request_id}/deny", status_code=status.HTTP_204_NO_CONTENT)
def deny_join_request(
    request_id: UUID,
    access: OrganizationAccess = Depends(require_capability("manage_members")),
    db: Session = Depends(get_db),
) -> None:
    _resolve_join_request(request_id, access, db, approve=False)
