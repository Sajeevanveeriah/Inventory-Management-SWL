"""Server rendered v2 UI for the Pricing Control Hub prototype.

Local only. All data comes from the local database or local
configuration. No external website, ServiceM8, or Xero connection.
"""

import json
import os
from datetime import timezone
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import (
    AuditEvent,
    CompetitiveRecommendation,
    CompetitorObservation,
    CompetitorProduct,
    CompetitorSource,
    Product,
    SupplierOffer,
)
from app.services import competitor as competitor_service
from app.services import pricing

router = APIRouter(prefix="/v2", tags=["ui-v2"])

templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))

DISPLAY_TZ = ZoneInfo(os.environ.get("DISPLAY_TIMEZONE", "Australia/Melbourne"))

MAX_TABLE_ROWS = 200

NAV_ITEMS = [
    {"href": "/v2/dashboard", "label": "Dashboard"},
    {"href": "/v2/products", "label": "Products"},
    {"href": "/v2/supplier-files", "label": "Supplier files"},
    {"href": "/v2/supplier-offers", "label": "Supplier offers"},
    {"href": "/v2/pricing-rules", "label": "Pricing rules"},
    {"href": "/v2/bundles", "label": "Bundles"},
    {"href": "/v2/trade-tiers", "label": "Trade tiers"},
    {"href": "/v2/competitor/search", "label": "Competitor search"},
    {"href": "/v2/exceptions", "label": "Exceptions"},
    {"href": "/v2/approvals", "label": "Approvals"},
    {"href": "/v2/releases", "label": "Releases"},
    {"href": "/v2/reconciliation", "label": "Reconciliation"},
    {"href": "/v2/audit", "label": "Audit"},
    {"href": "/v2/settings", "label": "Settings"},
    {"href": "/v2/help", "label": "Help"},
]

FEATURE_FLAGS = {
    "v2_ui": os.environ.get("FEATURE_V2_UI", "on"),
    "competitor_module": os.environ.get("FEATURE_COMPETITOR_MODULE", "on"),
    "approval_proposal": os.environ.get("FEATURE_APPROVAL_PROPOSAL", "on"),
    "reconciliation_mock": os.environ.get("FEATURE_RECONCILIATION_MOCK", "on"),
    "production_write": "off",
    "price_release": "off",
    "servicem8_write": "off",
    "xero_write": "off",
}


def fmt_melbourne(dt) -> str:
    """Display timestamps as YYYY-MM-DD HH:mm Australia/Melbourne."""
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(DISPLAY_TZ).strftime("%Y-%m-%d %H:%M")


def render(request: Request, template: str, context: dict):
    base = {
        "app_env": os.environ.get("APP_ENV", "local"),
        "nav_items": NAV_ITEMS,
        "active_path": request.url.path,
        "fmt": fmt_melbourne,
        "breadcrumbs": context.pop("breadcrumbs", None),
    }
    base.update(context)
    return templates.TemplateResponse(request, f"v2/{template}", base)


def product_summary(db: Session, product: Product) -> dict:
    cost = competitor_service.get_active_cost(db, product.internal_sku)
    latest_rec = (
        db.query(CompetitiveRecommendation)
        .filter(CompetitiveRecommendation.internal_sku == product.internal_sku)
        .order_by(CompetitiveRecommendation.created_at.desc(), CompetitiveRecommendation.id.desc())
        .first()
    )
    sell_ex = Decimal(latest_rec.recommended_ex_gst) if latest_rec else None
    markup = None
    if cost is not None and sell_ex is not None and cost > 0:
        markup = pricing.actual_markup(sell_ex, cost)
    if cost is None:
        badge = ("missing", "Missing cost")
    elif latest_rec is None:
        badge = ("pending", "No recommendation")
    elif latest_rec.exception_state == "OK":
        badge = ("safe", "Safe")
    elif latest_rec.release_blocked:
        badge = ("blocked", latest_rec.exception_state.replace("_", " ").title())
    else:
        badge = ("flag", latest_rec.exception_state.replace("_", " ").title())
    return {
        "product": product,
        "cost_ex": cost,
        "sell_ex": sell_ex,
        "markup": markup,
        "latest_rec": latest_rec,
        "badge_kind": badge[0],
        "badge_label": badge[1],
        "updated_at": latest_rec.created_at if latest_rec else None,
    }


def collect_exceptions(db: Session) -> list[dict]:
    """Exception queue built from recommendations and excluded observations."""
    items = []
    recs = (
        db.query(CompetitiveRecommendation)
        .filter(CompetitiveRecommendation.exception_state != "OK")
        .order_by(CompetitiveRecommendation.created_at.desc())
        .limit(MAX_TABLE_ROWS)
        .all()
    )
    for rec in recs:
        items.append(
            {
                "type": rec.exception_state,
                "internal_sku": rec.internal_sku,
                "severity": "blocked" if rec.release_blocked else "flag",
                "state": "open",
                "reason": rec.reason or rec.exception_state.replace("_", " ").capitalize(),
                "evidence_href": f"/v2/products/{rec.internal_sku}/competitor",
                "recommended_action": "Review evidence and seek approved exception before any release.",
                "required_approval": "Business owner approval required. Not granted in this prototype.",
                "created_at": rec.created_at,
            }
        )
    observations = (
        db.query(CompetitorObservation)
        .order_by(CompetitorObservation.observed_at.desc())
        .limit(MAX_TABLE_ROWS)
        .all()
    )
    reason_to_type = {
        "unknown GST basis": "UNKNOWN_GST",
        "low match confidence": "LOW_CONFIDENCE",
        "source not approved": "UNAPPROVED_SOURCE",
        "observation is stale": "STALE_OBSERVATION",
    }
    for obs in observations:
        reason = competitor_service.observation_exclusion_reason(db, obs)
        if reason in reason_to_type:
            items.append(
                {
                    "type": reason_to_type[reason],
                    "internal_sku": obs.internal_sku,
                    "severity": "flag",
                    "state": obs.review_state,
                    "reason": f"Observation {obs.id}: {reason}",
                    "evidence_href": f"/v2/products/{obs.internal_sku}/competitor",
                    "recommended_action": "Correct or quarantine the observation before it can inform a recommendation.",
                    "required_approval": "Reviewer decision required.",
                    "created_at": obs.observed_at,
                }
            )
    return items


@router.get("/dashboard")
def dashboard(request: Request, db: Session = Depends(get_db)):
    products = db.query(Product).filter(Product.active.is_(True)).all()
    missing_cost = [
        p for p in products
        if competitor_service.get_active_cost(db, p.internal_sku) is None
    ]
    observations = db.query(CompetitorObservation).all()
    pending_obs = [o for o in observations if o.review_state == "pending"]
    stale_obs = [o for o in observations if competitor_service.is_stale(o.observed_at)]
    below_floor = (
        db.query(CompetitiveRecommendation)
        .filter(CompetitiveRecommendation.exception_state == "COMPETITOR_BELOW_FLOOR")
        .count()
    )
    exception_count = len(collect_exceptions(db))
    recent_audit = (
        db.query(AuditEvent).order_by(AuditEvent.created_at.desc()).limit(10).all()
    )
    return render(
        request,
        "dashboard.html",
        {
            "page_title": "Dashboard",
            "cards": [
                {"label": "Pending exceptions", "value": exception_count, "href": "/v2/exceptions"},
                {"label": "Pending approvals", "value": 0, "href": "/v2/approvals"},
                {"label": "Below floor items", "value": below_floor, "href": "/v2/exceptions"},
                {"label": "Stale competitor observations", "value": len(stale_obs), "href": "/v2/exceptions"},
                {"label": "Missing active costs", "value": len(missing_cost), "href": "/v2/products?missing_cost=1"},
                {"label": "Pending observation reviews", "value": len(pending_obs), "href": "/v2/exceptions"},
            ],
            "recent_audit": recent_audit,
        },
    )


@router.get("/products")
def products_page(
    request: Request,
    q: str = "",
    category: str = "",
    brand: str = "",
    supplier: str = "",
    active: str = "",
    exception_state: str = "",
    missing_cost: str = "",
    db: Session = Depends(get_db),
):
    query = db.query(Product)
    if active == "1":
        query = query.filter(Product.active.is_(True))
    elif active == "0":
        query = query.filter(Product.active.is_(False))
    if category:
        query = query.filter(Product.category == category)
    if brand:
        query = query.filter(Product.brand == brand)
    products = query.order_by(Product.internal_sku).limit(MAX_TABLE_ROWS).all()

    if q:
        needle = q.lower()
        products = [
            p for p in products
            if needle in " ".join(
                filter(None, [p.internal_sku, p.name, p.brand, p.model, p.manufacturer_part_number, p.gtin])
            ).lower()
        ]
    if supplier:
        skus = {
            o.internal_sku
            for o in db.query(SupplierOffer).filter(SupplierOffer.supplier == supplier)
        }
        products = [p for p in products if p.internal_sku in skus]

    rows = [product_summary(db, p) for p in products]
    if missing_cost == "1":
        rows = [r for r in rows if r["cost_ex"] is None]
    if exception_state:
        rows = [
            r for r in rows
            if r["latest_rec"] and r["latest_rec"].exception_state == exception_state
        ]

    categories = sorted({p.category for p in db.query(Product) if p.category})
    brands = sorted({p.brand for p in db.query(Product) if p.brand})
    suppliers = sorted({o.supplier for o in db.query(SupplierOffer)})
    return render(
        request,
        "products.html",
        {
            "page_title": "Products",
            "rows": rows,
            "filters": {
                "q": q, "category": category, "brand": brand, "supplier": supplier,
                "active": active, "exception_state": exception_state, "missing_cost": missing_cost,
            },
            "categories": categories,
            "brands": brands,
            "suppliers": suppliers,
            "exception_states": [
                "OK", "COMPETITOR_BELOW_FLOOR", "LOW_CONFIDENCE", "UNKNOWN_GST",
                "UNAPPROVED_SOURCE", "STALE_OBSERVATION", "NO_VALID_OBSERVATION",
                "MISSING_COST", "AMBIGUOUS_MATCH",
            ],
        },
    )


@router.get("/products/{internal_sku}")
def product_detail(request: Request, internal_sku: str, db: Session = Depends(get_db)):
    product = db.get(Product, internal_sku)
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found")
    summary = product_summary(db, product)
    offers = (
        db.query(SupplierOffer)
        .filter(SupplierOffer.internal_sku == internal_sku)
        .order_by(SupplierOffer.active.desc(), SupplierOffer.effective_from.desc())
        .all()
    )
    observations = (
        db.query(CompetitorObservation)
        .filter(CompetitorObservation.internal_sku == internal_sku)
        .order_by(CompetitorObservation.observed_at.desc())
        .limit(MAX_TABLE_ROWS)
        .all()
    )
    recommendations = (
        db.query(CompetitiveRecommendation)
        .filter(CompetitiveRecommendation.internal_sku == internal_sku)
        .order_by(CompetitiveRecommendation.created_at.desc())
        .limit(20)
        .all()
    )
    audit_events = (
        db.query(AuditEvent)
        .filter(AuditEvent.entity_id == internal_sku)
        .order_by(AuditEvent.created_at.desc())
        .limit(20)
        .all()
    )
    floor = pricing.floor_ex_gst(summary["cost_ex"]) if summary["cost_ex"] is not None else None
    return render(
        request,
        "product_detail.html",
        {
            "page_title": f"Product {internal_sku}",
            "breadcrumbs": [
                {"href": "/v2/dashboard", "label": "Dashboard"},
                {"href": "/v2/products", "label": "Products"},
                {"href": "", "label": internal_sku},
            ],
            "summary": summary,
            "floor_ex": floor,
            "offers": offers,
            "observations": observations,
            "recommendations": recommendations,
            "audit_events": audit_events,
        },
    )


@router.get("/products/{internal_sku}/competitor")
def product_competitor(request: Request, internal_sku: str, db: Session = Depends(get_db)):
    product = db.get(Product, internal_sku)
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found")
    summary = product_summary(db, product)
    floor = pricing.floor_ex_gst(summary["cost_ex"]) if summary["cost_ex"] is not None else None
    observations = (
        db.query(CompetitorObservation)
        .filter(CompetitorObservation.internal_sku == internal_sku)
        .order_by(CompetitorObservation.observed_at.desc())
        .limit(MAX_TABLE_ROWS)
        .all()
    )
    obs_rows = [
        {
            "obs": o,
            "exclusion_reason": competitor_service.observation_exclusion_reason(db, o),
            "normalised_ex": (
                pricing.to_ex_gst(Decimal(o.price), o.gst_basis)
                if o.gst_basis in ("inclusive", "exclusive")
                else None
            ),
            "stale": competitor_service.is_stale(o.observed_at),
        }
        for o in observations
    ]
    return render(
        request,
        "product_competitor.html",
        {
            "page_title": f"Competitor evidence for {internal_sku}",
            "breadcrumbs": [
                {"href": "/v2/dashboard", "label": "Dashboard"},
                {"href": "/v2/products", "label": "Products"},
                {"href": f"/v2/products/{internal_sku}", "label": internal_sku},
                {"href": "", "label": "Competitor"},
            ],
            "summary": summary,
            "floor_ex": floor,
            "obs_rows": obs_rows,
        },
    )


@router.get("/supplier-files")
def supplier_files(request: Request):
    return render(
        request,
        "supplier_files.html",
        {"page_title": "Supplier files"},
    )


@router.get("/supplier-offers")
def supplier_offers(request: Request, internal_sku: str = "", db: Session = Depends(get_db)):
    query = db.query(SupplierOffer)
    if internal_sku:
        query = query.filter(SupplierOffer.internal_sku == internal_sku)
    offers = query.order_by(SupplierOffer.internal_sku, SupplierOffer.cost_ex_gst).limit(MAX_TABLE_ROWS).all()
    skus = sorted({o.internal_sku for o in db.query(SupplierOffer)})
    return render(
        request,
        "supplier_offers.html",
        {
            "page_title": "Supplier offers",
            "offers": offers,
            "skus": skus,
            "selected_sku": internal_sku,
        },
    )


@router.get("/pricing-rules")
def pricing_rules(request: Request):
    return render(
        request,
        "pricing_rules.html",
        {
            "page_title": "Pricing rules",
            "markup_rate": pricing.MARKUP_RATE,
            "rounding_places": pricing.ROUNDING_PLACES,
            "rule_version": pricing.RULE_VERSION,
            "gst_rate": pricing.GST_RATE,
        },
    )


@router.get("/bundles")
def bundles(request: Request):
    return render(request, "bundles.html", {"page_title": "Bundles"})


@router.get("/trade-tiers")
def trade_tiers(request: Request):
    return render(request, "trade_tiers.html", {"page_title": "Trade tiers"})


@router.get("/competitor/search")
def competitor_search_page(request: Request, db: Session = Depends(get_db)):
    products = db.query(Product).filter(Product.active.is_(True)).order_by(Product.internal_sku).all()
    sources = db.query(CompetitorSource).order_by(CompetitorSource.name).all()
    return render(
        request,
        "competitor_search.html",
        {
            "page_title": "Competitor search",
            "products": products,
            "sources": sources,
        },
    )


@router.get("/exceptions")
def exceptions_page(
    request: Request,
    exception_type: str = "",
    internal_sku: str = "",
    severity: str = "",
    state: str = "",
    db: Session = Depends(get_db),
):
    items = collect_exceptions(db)
    if exception_type:
        items = [i for i in items if i["type"] == exception_type]
    if internal_sku:
        items = [i for i in items if i["internal_sku"] == internal_sku]
    if severity:
        items = [i for i in items if i["severity"] == severity]
    if state:
        items = [i for i in items if i["state"] == state]
    return render(
        request,
        "exceptions.html",
        {
            "page_title": "Exceptions",
            "items": items[:MAX_TABLE_ROWS],
            "filters": {
                "exception_type": exception_type,
                "internal_sku": internal_sku,
                "severity": severity,
                "state": state,
            },
            "exception_types": [
                "COMPETITOR_BELOW_FLOOR", "LOW_CONFIDENCE", "UNKNOWN_GST",
                "UNAPPROVED_SOURCE", "STALE_OBSERVATION", "NO_VALID_OBSERVATION",
                "MISSING_COST", "AMBIGUOUS_MATCH",
            ],
        },
    )


@router.get("/approvals")
def approvals(request: Request, db: Session = Depends(get_db)):
    recommendations = (
        db.query(CompetitiveRecommendation)
        .order_by(CompetitiveRecommendation.created_at.desc())
        .limit(MAX_TABLE_ROWS)
        .all()
    )
    line_items = []
    for rec in recommendations:
        cost = competitor_service.get_active_cost(db, rec.internal_sku)
        line_items.append({"rec": rec, "cost_ex": cost})
    return render(
        request,
        "approvals.html",
        {
            "page_title": "Approvals",
            "line_items": line_items,
            "rule_version": pricing.RULE_VERSION,
        },
    )


@router.get("/releases")
def releases(request: Request, db: Session = Depends(get_db)):
    recommendations = (
        db.query(CompetitiveRecommendation)
        .order_by(CompetitiveRecommendation.created_at.desc())
        .limit(MAX_TABLE_ROWS)
        .all()
    )
    return render(
        request,
        "releases.html",
        {"page_title": "Releases", "recommendations": recommendations},
    )


@router.get("/reconciliation")
def reconciliation(request: Request, db: Session = Depends(get_db)):
    recommendations = (
        db.query(CompetitiveRecommendation)
        .order_by(CompetitiveRecommendation.created_at.desc())
        .limit(MAX_TABLE_ROWS)
        .all()
    )
    return render(
        request,
        "reconciliation.html",
        {"page_title": "Reconciliation", "recommendations": recommendations},
    )


@router.get("/audit")
def audit_page(
    request: Request,
    entity_type: str = "",
    action: str = "",
    actor: str = "",
    db: Session = Depends(get_db),
):
    query = db.query(AuditEvent)
    if entity_type:
        query = query.filter(AuditEvent.entity_type == entity_type)
    if action:
        query = query.filter(AuditEvent.action == action)
    if actor:
        query = query.filter(AuditEvent.actor == actor)
    events = query.order_by(AuditEvent.created_at.desc()).limit(MAX_TABLE_ROWS).all()
    actions = sorted({e.action for e in db.query(AuditEvent)})
    entity_types = sorted({e.entity_type for e in db.query(AuditEvent)})
    return render(
        request,
        "audit.html",
        {
            "page_title": "Audit",
            "events": events,
            "filters": {"entity_type": entity_type, "action": action, "actor": actor},
            "actions": actions,
            "entity_types": entity_types,
        },
    )


@router.get("/settings")
def settings_page(request: Request):
    approved_sources_note = "Manual Entry only. No live competitor source is approved until Q-011 is closed."
    return render(
        request,
        "settings.html",
        {
            "page_title": "Settings",
            "config": {
                "GST rate": str(pricing.GST_RATE),
                "Stale days": str(competitor_service.STALE_DAYS),
                "Rounding rule": f"{pricing.ROUNDING_PLACES} decimal places, ROUND_HALF_UP, applied after calculation",
                "Display timezone": os.environ.get("DISPLAY_TIMEZONE", "Australia/Melbourne"),
                "Source allow list": approved_sources_note,
                "Currency": "AUD only",
            },
            "feature_flags": FEATURE_FLAGS,
        },
    )


@router.get("/help")
def help_page(request: Request):
    return render(request, "help.html", {"page_title": "Help"})
