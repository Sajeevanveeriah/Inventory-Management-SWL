"""FastAPI application for the SWL competitor search prototype.

Local prototype only. Not authorised for production use. Does not
connect to ServiceM8, Xero, or any competitor website.
"""

import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.templating import Jinja2Templates

from app.api import competitors, products
from app.db import Base, engine

app = FastAPI(
    title="SWL Competitor Search Prototype",
    description="Local competitor observation and price recommendation prototype. Proposal only, no release.",
    docs_url=None,
    redoc_url=None,
)

Base.metadata.create_all(bind=engine)

templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))

app.include_router(products.router)
app.include_router(competitors.router)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    # Do not expose stack traces or internal detail to the client.
    return JSONResponse(
        status_code=500,
        content={"detail": "An internal error occurred. Please check server logs."},
    )


@app.get("/health")
def health():
    return {
        "status": "ok",
        "environment": os.environ.get("APP_ENV", "local"),
        "production_write_authorised": False,
    }


@app.get("/ui/competitor-search")
def competitor_search_ui(request: Request):
    return templates.TemplateResponse(
        request, "competitor_search.html", {"app_env": os.environ.get("APP_ENV", "local")}
    )
