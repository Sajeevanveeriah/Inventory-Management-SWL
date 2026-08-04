"""Product read endpoints. Read only, no production writes."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import CompetitiveRecommendation, CompetitorObservation, Product
from app.services import competitor as competitor_service

router = APIRouter(prefix="/api/products", tags=["products"])


def _product_json(product: Product) -> dict:
    return {
        "internal_sku": product.internal_sku,
        "name": product.name,
        "brand": product.brand,
        "model": product.model,
        "manufacturer_part_number": product.manufacturer_part_number,
        "gtin": product.gtin,
        "category": product.category,
        "active": product.active,
    }


def _observation_json(db: Session, obs: CompetitorObservation) -> dict:
    return {
        "id": obs.id,
        "internal_sku": obs.internal_sku,
        "competitor_product_id": obs.competitor_product_id,
        "observed_at": obs.observed_at.isoformat() if obs.observed_at else None,
        "price": str(obs.price),
        "currency": obs.currency,
        "gst_basis": obs.gst_basis,
        "stock_status": obs.stock_status,
        "source_url": obs.source_url,
        "match_confidence": obs.match_confidence,
        "review_state": obs.review_state,
        "reviewer": obs.reviewer,
        "stale_state": "stale" if competitor_service.is_stale(obs.observed_at) else "fresh",
        "valid": obs.valid,
        "exclusion_reason": competitor_service.observation_exclusion_reason(db, obs),
    }


@router.get("")
def list_products(db: Session = Depends(get_db)):
    products = db.query(Product).filter(Product.active.is_(True)).all()
    return {"products": [_product_json(p) for p in products]}


@router.get("/{internal_sku}")
def get_product(internal_sku: str, db: Session = Depends(get_db)):
    product = db.get(Product, internal_sku)
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found")
    cost = competitor_service.get_active_cost(db, internal_sku)
    return {
        **_product_json(product),
        "active_cost_ex_gst": str(cost) if cost is not None else None,
    }


@router.get("/{internal_sku}/competitor")
def get_product_competitor_state(internal_sku: str, db: Session = Depends(get_db)):
    product = db.get(Product, internal_sku)
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found")

    observations = (
        db.query(CompetitorObservation)
        .filter(CompetitorObservation.internal_sku == internal_sku)
        .order_by(CompetitorObservation.observed_at.desc())
        .all()
    )
    accepted = [o for o in observations if o.review_state == "accepted"]
    latest_rec = (
        db.query(CompetitiveRecommendation)
        .filter(CompetitiveRecommendation.internal_sku == internal_sku)
        .order_by(CompetitiveRecommendation.created_at.desc(), CompetitiveRecommendation.id.desc())
        .first()
    )
    return {
        "internal_sku": internal_sku,
        "observations": [_observation_json(db, o) for o in observations],
        "accepted_observations": [_observation_json(db, o) for o in accepted],
        "latest_recommendation": {
            "id": latest_rec.id,
            "created_at": latest_rec.created_at.isoformat(),
            "strategy": latest_rec.strategy,
            "rule_version": latest_rec.rule_version,
            "floor_ex_gst": str(latest_rec.floor_ex_gst),
            "selected_competitor_ex_gst": (
                str(latest_rec.selected_competitor_ex_gst)
                if latest_rec.selected_competitor_ex_gst is not None
                else None
            ),
            "target_ex_gst": (
                str(latest_rec.target_ex_gst)
                if latest_rec.target_ex_gst is not None
                else None
            ),
            "recommended_ex_gst": str(latest_rec.recommended_ex_gst),
            "recommended_incl_gst": str(latest_rec.recommended_incl_gst),
            "actual_markup": str(latest_rec.actual_markup),
            "exception_state": latest_rec.exception_state,
            "release_blocked": latest_rec.release_blocked,
            "reason": latest_rec.reason,
        }
        if latest_rec
        else None,
        "exception_state": latest_rec.exception_state if latest_rec else None,
    }
