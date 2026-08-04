"""FastAPI application for the SWL competitor search prototype.

Local prototype only. Not authorised for production use. Does not
connect to ServiceM8, Xero, or any competitor website.
"""

import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app import ui_v2
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
app.include_router(ui_v2.router)

app.mount(
    "/static",
    StaticFiles(directory=str(Path(__file__).parent / "static")),
    name="static",
)


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


@app.get("/legacy")
def legacy_redirect():
    """The pre v2 experience remains available at its original address."""
    return RedirectResponse(url="/ui/competitor-search", status_code=307)


@app.get("/")
def root_redirect():
    return RedirectResponse(url="/v2/dashboard", status_code=307)


@app.get("/v2")
def v2_redirect():
    return RedirectResponse(url="/v2/dashboard", status_code=307)
