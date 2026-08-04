"""Competitor observation validity and recommendation service.

Local prototype only. No live competitor data is fetched. Observations
are manual, dated evidence records. Recommendations are proposals only
and never release a price.
"""

import json
import os
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy.orm import Session

from app.models import (
    AuditEvent,
    CompetitiveRecommendation,
    CompetitorObservation,
    CompetitorProduct,
    CompetitorSource,
    Product,
    SupplierOffer,
    utc_now,
)
from app.services import pricing

STALE_DAYS = int(os.environ.get("STALE_DAYS", "30"))

STRATEGIES = ("MATCH", "UNDERCUT_AMOUNT", "UNDERCUT_PERCENT", "MAINTAIN_FLOOR")

EXCEPTION_OK = "OK"
EXCEPTION_BELOW_FLOOR = "COMPETITOR_BELOW_FLOOR"
EXCEPTION_NO_VALID_OBSERVATION = "NO_VALID_OBSERVATION"
EXCEPTION_MISSING_COST = "MISSING_COST"


def record_audit(
    db: Session,
    actor: str,
    action: str,
    entity_type: str,
    entity_id: str | None,
    before: dict | None = None,
    after: dict | None = None,
    reason: str | None = None,
) -> AuditEvent:
    event = AuditEvent(
        actor=actor,
        action=action,
        entity_type=entity_type,
        entity_id=str(entity_id) if entity_id is not None else None,
        before_json=json.dumps(before, default=str) if before is not None else None,
        after_json=json.dumps(after, default=str) if after is not None else None,
        reason=reason,
    )
    db.add(event)
    return event


def _as_utc(value: datetime) -> datetime:
    """SQLite drops tzinfo; naive values from this store are UTC."""
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def is_stale(observed_at: datetime, now: datetime | None = None) -> bool:
    now = now or utc_now()
    return _as_utc(observed_at) < now - timedelta(days=STALE_DAYS)


def get_active_cost(db: Session, internal_sku: str) -> Decimal | None:
    offer = (
        db.query(SupplierOffer)
        .filter(
            SupplierOffer.internal_sku == internal_sku,
            SupplierOffer.active.is_(True),
            SupplierOffer.currency == "AUD",
        )
        .order_by(SupplierOffer.cost_ex_gst.asc())
        .first()
    )
    return Decimal(offer.cost_ex_gst) if offer else None


def observation_exclusion_reason(
    db: Session, obs: CompetitorObservation
) -> str | None:
    """Return why an observation cannot be used for a recommendation, or None."""
    if not obs.valid:
        return "marked invalid"
    if obs.review_state != "accepted":
        return f"review state is {obs.review_state}"
    if obs.match_confidence == "low":
        return "low match confidence"
    if obs.gst_basis == "unknown":
        return "unknown GST basis"
    if obs.currency != "AUD":
        return "currency is not AUD"
    if obs.price is None or Decimal(obs.price) < 0:
        return "price missing or negative"
    if is_stale(obs.observed_at):
        return "observation is stale"
    cp = db.get(CompetitorProduct, obs.competitor_product_id)
    if cp is None:
        return "competitor product missing"
    if cp.pack_size != 1:
        return "pack size is not 1"
    if cp.condition != "new":
        return "condition is not new"
    if cp.service_basis != "product_only":
        return "service basis is not product only"
    source = db.get(CompetitorSource, cp.source_id)
    if source is None or not source.approved:
        return "source not approved"
    return None


def valid_accepted_observations(
    db: Session, internal_sku: str, observation_ids: list[int] | None = None
) -> list[CompetitorObservation]:
    query = db.query(CompetitorObservation).filter(
        CompetitorObservation.internal_sku == internal_sku
    )
    if observation_ids:
        query = query.filter(CompetitorObservation.id.in_(observation_ids))
    return [
        obs
        for obs in query.all()
        if observation_exclusion_reason(db, obs) is None
    ]


def build_recommendation(
    db: Session,
    internal_sku: str,
    strategy: str = "MATCH",
    undercut_amount: Decimal | None = None,
    undercut_percent: Decimal | None = None,
    observation_ids: list[int] | None = None,
    actor: str = "local_operator",
) -> dict:
    """Calculate a competitive price proposal. Never releases a price."""
    if strategy not in STRATEGIES:
        raise ValueError(f"Unknown strategy {strategy}")

    product = db.get(Product, internal_sku)
    if product is None or not product.active:
        raise LookupError("Product not found or inactive")

    cost_ex = get_active_cost(db, internal_sku)
    if cost_ex is None:
        record_audit(
            db,
            actor,
            "recommendation_blocked",
            "CompetitiveRecommendation",
            None,
            after={"internal_sku": internal_sku, "exception_state": EXCEPTION_MISSING_COST},
            reason="No active AUD supplier cost for product",
        )
        db.commit()
        return {
            "internal_sku": internal_sku,
            "strategy": strategy,
            "rule_version": pricing.RULE_VERSION,
            "floor_ex_gst": None,
            "selected_competitor_ex_gst": None,
            "target_ex_gst": None,
            "recommended_ex_gst": None,
            "recommended_incl_gst": None,
            "actual_markup": None,
            "exception_state": EXCEPTION_MISSING_COST,
            "release_blocked": True,
            "reason": "No active supplier cost. A recommendation cannot be calculated.",
            "observation_ids": [],
            "stored": False,
        }

    floor_ex = pricing.floor_ex_gst(cost_ex)
    observations = valid_accepted_observations(db, internal_sku, observation_ids)

    selected_ex: Decimal | None = None
    selected_obs_ids: list[int] = []
    if observations:
        normalised = [
            (pricing.to_ex_gst(Decimal(o.price), o.gst_basis), o) for o in observations
        ]
        normalised.sort(key=lambda pair: pair[0])
        selected_ex = normalised[0][0]
        selected_obs_ids = [o.id for _, o in normalised]

    exception_state = EXCEPTION_OK
    release_blocked = False
    reason = None
    target_ex: Decimal | None = None

    if strategy == "MAINTAIN_FLOOR" or selected_ex is None:
        target_ex = floor_ex
        if selected_ex is None and strategy != "MAINTAIN_FLOOR":
            exception_state = EXCEPTION_NO_VALID_OBSERVATION
            release_blocked = True
            reason = "No valid accepted competitor observation. Floor recommended."
    elif strategy == "MATCH":
        target_ex = selected_ex
    elif strategy == "UNDERCUT_AMOUNT":
        amount = undercut_amount if undercut_amount is not None else Decimal("0")
        target_ex = pricing.round_money(selected_ex - amount)
    elif strategy == "UNDERCUT_PERCENT":
        percent = undercut_percent if undercut_percent is not None else Decimal("0")
        target_ex = pricing.round_money(
            selected_ex * (Decimal("1") - percent / Decimal("100"))
        )

    if target_ex < floor_ex:
        recommended_ex = floor_ex
        if exception_state == EXCEPTION_OK:
            exception_state = EXCEPTION_BELOW_FLOOR
            reason = (
                "Competitor target is below the approved 30 percent markup floor. "
                "Floor recommended. Release blocked pending approved exception."
            )
        release_blocked = True
    else:
        recommended_ex = pricing.round_money(target_ex)

    recommendation = CompetitiveRecommendation(
        internal_sku=internal_sku,
        strategy=strategy,
        rule_version=pricing.RULE_VERSION,
        floor_ex_gst=floor_ex,
        selected_competitor_ex_gst=selected_ex,
        target_ex_gst=target_ex,
        recommended_ex_gst=recommended_ex,
        recommended_incl_gst=pricing.to_incl_gst(recommended_ex),
        actual_markup=pricing.actual_markup(recommended_ex, cost_ex),
        exception_state=exception_state,
        release_blocked=release_blocked,
        reason=reason,
        observation_ids=json.dumps(selected_obs_ids),
    )
    db.add(recommendation)
    db.flush()
    record_audit(
        db,
        actor,
        "recommendation_created",
        "CompetitiveRecommendation",
        recommendation.id,
        after={
            "internal_sku": internal_sku,
            "strategy": strategy,
            "recommended_ex_gst": str(recommended_ex),
            "exception_state": exception_state,
            "release_blocked": release_blocked,
        },
        reason=reason,
    )
    db.commit()
    db.refresh(recommendation)

    return {
        "id": recommendation.id,
        "internal_sku": internal_sku,
        "strategy": strategy,
        "rule_version": pricing.RULE_VERSION,
        "floor_ex_gst": floor_ex,
        "selected_competitor_ex_gst": selected_ex,
        "target_ex_gst": target_ex,
        "recommended_ex_gst": recommended_ex,
        "recommended_incl_gst": recommendation.recommended_incl_gst,
        "actual_markup": recommendation.actual_markup,
        "exception_state": exception_state,
        "release_blocked": release_blocked,
        "reason": reason,
        "observation_ids": selected_obs_ids,
        "stored": True,
    }
