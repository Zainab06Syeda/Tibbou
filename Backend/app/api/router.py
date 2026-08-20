from fastapi import APIRouter

from app.api.routes.costs import router as costs_router
from app.api.routes.connections import router as connections_router
from app.api.routes.datasets import router as datasets_router
from app.api.routes.ingestion import router as ingestion_router
from app.api.routes.lineage import router as lineage_router
from app.api.routes.organizations import router as organizations_router
from app.api.routes.system import router as system_router

api_router = APIRouter()
api_router.include_router(system_router, tags=["system"])
api_router.include_router(organizations_router)
api_router.include_router(connections_router)
api_router.include_router(costs_router)
api_router.include_router(datasets_router)
api_router.include_router(ingestion_router)
api_router.include_router(lineage_router)
