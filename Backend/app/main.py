import os

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.router import api_router
from app.api.routes.ingestion import max_dbt_manifest_bytes


def _is_dbt_manifest_request(request: Request) -> bool:
    return (
        request.method == "POST"
        and request.url.path.startswith("/api/v1/organizations/")
        and request.url.path.endswith("/ingestion/dbt/manifest")
    )


def create_app() -> FastAPI:
    application = FastAPI(title="Tibbou", version="1.0.0")

    @application.middleware("http")
    async def reject_oversized_dbt_manifests(request: Request, call_next):
        if _is_dbt_manifest_request(request):
            content_length = request.headers.get("content-length")
            if content_length is not None:
                try:
                    request_bytes = int(content_length)
                except ValueError:
                    return JSONResponse(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        content={"detail": "Invalid Content-Length header"},
                    )
                if request_bytes > max_dbt_manifest_bytes():
                    return JSONResponse(
                        status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                        content={"detail": "dbt manifest exceeds configured ingestion limits"},
                    )
        return await call_next(request)

    origins = [
        origin.strip()
        for origin in os.getenv("CORS_ORIGINS", "").split(",")
        if origin.strip()
    ]
    if origins:
        application.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=False,
            allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
        )
    application.include_router(api_router)
    return application


app = create_app()
