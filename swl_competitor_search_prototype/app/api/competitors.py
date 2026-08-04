"""Competitor search, observation, and recommendation endpoints.

Local records only. No live competitor website is contacted.
Recommendations are proposals only and never release a price.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import (
    CompetitorObservation,
    CompetitorProduct,
    CompetitorSource,
    Product,
)
from app.schemas import (
    CompetitorSearchRequest,
    ObservationAccept,
    ObservationCreate,
    ObservationReject,
    RecommendationRequest,
)
from app.services import competitor as competitor_service

router = APIRouter(prefix="/api/competitor", tags=["competitor"])

DEFAULT_ACTOR = "local_operator"


@router.post("/search")
def search_competitors(body: CompetitorSearchRequest, db: Session = Depends(get_db)):
    """Search local competitor product records only. No external fetch."""
    product = db.get(Product, body.internal_sku)
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found")

    query = db.query(CompetitorProduct).join(CompetitorSource)
    if body.source_ids:
        query = query.filter(CompetitorProduct.source_id.in_(body.source_ids))

    candidates = []
    terms = []
    if body.query:
        terms = [t.lower() for t in body.query.split() if t.strip()]

    for cp in query.all():
        indicators = []
        if product.gtin and cp.gtin and product.gtin == cp.gtin:
            indicators.append("gtin_match")
        if (
            product.manufacturer_part_number
            and cp.manufacturer_part_number
            and product.manufacturer_part_number.lower()
            == cp.manufacturer_part_number.lower()
        ):
            indicators.append("mpn_match")
        if product.brand and cp.brand and product.brand.lower() == cp.brand.lower():
            indicators.append("brand_match")
        text = f"{cp.title} {cp.brand or ''} {cp.manufacturer_part_number or ''}".lower()
        if terms and all(t in text for t in terms):
            indicators.append("query_match")
        if not terms and not indicators:
            continue
        if terms and "query_match" not in indicators and not indicators:
            continue
        source = db.get(CompetitorSource, cp.source_id)
        candidates.append(
            {
                "competitor_product_id": cp.id,
                "source": {
                    "id": source.id,
                    "name": source.name,
                    "method": source.method,
                    "approved": source.approved,
                },
                "title": cp.title,
                "brand": cp.brand,
                "manufacturer_part_number": cp.manufacturer_part_number,
                "gtin": cp.gtin,
                "url": cp.url,
                "pack_size": cp.pack_size,
                "condition": cp.condition,
                "service_basis": cp.service_basis,
                "matching_indicators": indicators,
            }
        )

    competitor_service.record_audit(
        db,
        DEFAULT_ACTOR,
        "competitor_search",
        "Product",
        body.internal_sku,
        after={"query": body.query, "candidate_count": len(candidates)},
    )
    db.commit()

    message = (
        "No candidate competitor products found in local records."
        if not candidates
        else f"{len(candidates)} candidate(s) found in local records."
    )
    return {"candidates": candidates, "message": message}


@router.post("/observations", status_code=201)
def create_observation(body: ObservationCreate, db: Session = Depends(get_db)):
    product = db.get(Product, body.internal_sku)
    if product is None or not product.active:
        raise HTTPException(status_code=404, detail="Product not found or inactive")

    cp = db.get(CompetitorProduct, body.competitor_product_id)
    if cp is None:
        raise HTTPException(status_code=404, detail="Competitor product not found")

    source = db.get(CompetitorSource, cp.source_id)
    if source is None or not source.approved:
        raise HTTPException(
            status_code=403,
            detail="Competitor source is not approved. Observation rejected.",
        )
    if body.gst_basis.value == "unknown":
        raise HTTPException(
            status_code=422,
            detail="Unknown GST basis is not allowed. Record inclusive or exclusive.",
        )
    if body.currency != "AUD":
        raise HTTPException(
            status_code=422, detail="Only AUD is supported in this prototype."
        )

    obs = CompetitorObservation(
        internal_sku=body.internal_sku,
        competitor_product_id=body.competitor_product_id,
        observed_at=body.observed_at,
        price=body.price,
        currency=body.currency,
        gst_basis=body.gst_basis.value,
        shipping_amount=body.shipping_amount,
        shipping_basis=body.shipping_basis,
        stock_status=body.stock_status.value,
        source_url=body.source_url,
        evidence_reference=body.evidence_reference,
        match_confidence=body.match_confidence.value,
        review_state="pending",
        reviewer=body.reviewer,
        stale_state="stale" if competitor_service.is_stale(body.observed_at) else "fresh",
        valid=True,
    )
    db.add(obs)
    db.flush()
    competitor_service.record_audit(
        db,
        body.reviewer or DEFAULT_ACTOR,
        "observation_created",
        "CompetitorObservation",
        obs.id,
        after={
            "internal_sku": obs.internal_sku,
            "price": str(obs.price),
            "gst_basis": obs.gst_basis,
            "match_confidence": obs.match_confidence,
            "review_state": obs.review_state,
        },
    )
    db.commit()
    db.refresh(obs)
    return {
        "id": obs.id,
        "internal_sku": obs.internal_sku,
        "review_state": obs.review_state,
        "stale_state": obs.stale_state,
        "message": "Observation recorded with review state pending.",
    }


@router.post("/observations/{observation_id}/accept")
def accept_observation(
    observation_id: int, body: ObservationAccept, db: Session = Depends(get_db)
):
    obs = db.get(CompetitorObservation, observation_id)
    if obs is None:
        raise HTTPException(status_code=404, detail="Observation not found")
    before = {"review_state": obs.review_state}
    obs.review_state = "accepted"
    obs.reviewer = body.reviewer
    competitor_service.record_audit(
        db,
        body.reviewer,
        "observation_accepted",
        "CompetitorObservation",
        obs.id,
        before=before,
        after={"review_state": "accepted"},
    )
    db.commit()
    return {"id": obs.id, "review_state": obs.review_state}


@router.post("/observations/{observation_id}/reject")
def reject_observation(
    observation_id: int, body: ObservationReject, db: Session = Depends(get_db)
):
    obs = db.get(CompetitorObservation, observation_id)
    if obs is None:
        raise HTTPException(status_code=404, detail="Observation not found")
    before = {"review_state": obs.review_state}
    obs.review_state = "rejected"
    obs.reviewer = body.reviewer
    competitor_service.record_audit(
        db,
        body.reviewer,
        "observation_rejected",
        "CompetitorObservation",
        obs.id,
        before=before,
        after={"review_state": "rejected"},
        reason=body.reason,
    )
    db.commit()
    return {"id": obs.id, "review_state": obs.review_state}


@router.post("/recommendations", status_code=201)
def create_recommendation(body: RecommendationRequest, db: Session = Depends(get_db)):
    try:
        result = competitor_service.build_recommendation(
            db,
            internal_sku=body.internal_sku,
            strategy=body.strategy.value,
            undercut_amount=body.undercut_amount,
            undercut_percent=body.undercut_percent,
            observation_ids=body.observation_ids,
            actor=DEFAULT_ACTOR,
        )
    except LookupError:
        raise HTTPException(status_code=404, detail="Product not found or inactive")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    for key in (
        "floor_ex_gst",
        "selected_competitor_ex_gst",
        "target_ex_gst",
        "recommended_ex_gst",
        "recommended_incl_gst",
        "actual_markup",
    ):
        if result.get(key) is not None:
            result[key] = str(result[key])
    return result
