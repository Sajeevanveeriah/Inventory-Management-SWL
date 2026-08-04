"""Idempotent seed script with illustrative local data only.

Safe to run repeatedly. Never deletes data. Uses example.com URLs and
no real competitor names, customer data, or secrets.

Run: python -m app.seed
"""

from decimal import Decimal

from sqlalchemy.orm import Session

from app.db import Base, SessionLocal, engine
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
from app.services import competitor as competitor_service


def seed(db: Session) -> dict:
    created = {"products": 0, "offers": 0, "sources": 0, "competitor_products": 0, "observations": 0}

    products = [
        dict(
            internal_sku="SWL-ABUS-55-40",
            name="ABUS 55/40 Padlock",
            brand="ABUS",
            model="55/40",
            manufacturer_part_number="55/40",
            category="Padlock",
            active=True,
        ),
        dict(
            internal_sku="SWL-ABUS-55-40-HB",
            name="ABUS 55/40 Padlock High Body",
            brand="ABUS",
            model="55/40 HB",
            manufacturer_part_number="55/40 HB",
            category="Padlock",
            active=True,
        ),
    ]
    for data in products:
        if db.get(Product, data["internal_sku"]) is None:
            db.add(Product(**data))
            created["products"] += 1

    offers = [
        ("SWL-ABUS-55-40", Decimal("60.00")),
        ("SWL-ABUS-55-40-HB", Decimal("75.00")),
    ]
    for sku, cost in offers:
        existing = (
            db.query(SupplierOffer)
            .filter(SupplierOffer.internal_sku == sku, SupplierOffer.active.is_(True))
            .first()
        )
        if existing is None:
            db.add(
                SupplierOffer(
                    internal_sku=sku,
                    supplier="Local Seed Supplier",
                    cost_ex_gst=cost,
                    currency="AUD",
                    effective_from=utc_now(),
                    active=True,
                )
            )
            created["offers"] += 1

    source = db.query(CompetitorSource).filter(CompetitorSource.name == "Manual Entry").first()
    if source is None:
        source = CompetitorSource(
            name="Manual Entry",
            method="manual",
            approved=True,
            terms_reviewed=True,
            notes="Local manual observation prototype source. No live source approved. Q 011 remains open.",
        )
        db.add(source)
        db.flush()
        created["sources"] += 1

    cp = (
        db.query(CompetitorProduct)
        .filter(
            CompetitorProduct.source_id == source.id,
            CompetitorProduct.title == "ABUS 55/40 Padlock",
        )
        .first()
    )
    if cp is None:
        cp = CompetitorProduct(
            source_id=source.id,
            title="ABUS 55/40 Padlock",
            brand="ABUS",
            manufacturer_part_number="55/40",
            url="https://example.com/abus-55-40",
            pack_size=1,
            condition="new",
            service_basis="product_only",
        )
        db.add(cp)
        db.flush()
        created["competitor_products"] += 1

    obs = (
        db.query(CompetitorObservation)
        .filter(
            CompetitorObservation.internal_sku == "SWL-ABUS-55-40",
            CompetitorObservation.competitor_product_id == cp.id,
            CompetitorObservation.reviewer == "local_seed",
        )
        .first()
    )
    if obs is None:
        db.add(
            CompetitorObservation(
                internal_sku="SWL-ABUS-55-40",
                competitor_product_id=cp.id,
                observed_at=utc_now(),
                price=Decimal("100.00"),
                currency="AUD",
                gst_basis="inclusive",
                stock_status="in_stock",
                source_url="https://example.com/abus-55-40",
                match_confidence="high",
                review_state="accepted",
                reviewer="local_seed",
                stale_state="fresh",
                valid=True,
            )
        )
        created["observations"] += 1

    low_conf = (
        db.query(CompetitorObservation)
        .filter(
            CompetitorObservation.internal_sku == "SWL-ABUS-55-40",
            CompetitorObservation.match_confidence == "low",
            CompetitorObservation.reviewer == "local_seed_low_confidence",
        )
        .first()
    )
    if low_conf is None:
        db.add(
            CompetitorObservation(
                internal_sku="SWL-ABUS-55-40",
                competitor_product_id=cp.id,
                observed_at=utc_now(),
                price=Decimal("95.00"),
                currency="AUD",
                gst_basis="inclusive",
                stock_status="unknown",
                source_url="https://example.com/similar-padlock",
                match_confidence="low",
                review_state="pending",
                reviewer="local_seed_low_confidence",
                stale_state="fresh",
                valid=True,
            )
        )
        created["observations"] += 1

    hb_obs = (
        db.query(CompetitorObservation)
        .filter(
            CompetitorObservation.internal_sku == "SWL-ABUS-55-40-HB",
            CompetitorObservation.reviewer == "local_seed",
        )
        .first()
    )
    if hb_obs is None:
        db.add(
            CompetitorObservation(
                internal_sku="SWL-ABUS-55-40-HB",
                competitor_product_id=cp.id,
                observed_at=utc_now(),
                price=Decimal("100.00"),
                currency="AUD",
                gst_basis="inclusive",
                stock_status="in_stock",
                source_url="https://example.com/abus-55-40-hb",
                match_confidence="high",
                review_state="accepted",
                reviewer="local_seed",
                stale_state="fresh",
                valid=True,
            )
        )
        created["observations"] += 1
    db.commit()

    # Below floor exception example: cost 75.00 gives floor 97.50, competitor
    # 100.00 inclusive normalises to 90.91 ex GST, so the floor is recommended
    # and release is blocked.
    existing_rec = (
        db.query(CompetitiveRecommendation)
        .filter(CompetitiveRecommendation.internal_sku == "SWL-ABUS-55-40-HB")
        .first()
    )
    if existing_rec is None:
        competitor_service.build_recommendation(
            db, "SWL-ABUS-55-40-HB", strategy="MATCH", actor="local_seed"
        )
        created["recommendations"] = created.get("recommendations", 0) + 1

    seed_event = (
        db.query(AuditEvent)
        .filter(AuditEvent.action == "seed_created", AuditEvent.actor == "local_seed")
        .first()
    )
    if seed_event is None:
        competitor_service.record_audit(
            db,
            "local_seed",
            "seed_created",
            "Seed",
            None,
            after=created,
            reason="Idempotent seed run with illustrative local data only.",
        )
        created["audit_events"] = created.get("audit_events", 0) + 1

    db.commit()
    return created


if __name__ == "__main__":
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    try:
        result = seed(session)
        print(f"Seed complete. Newly created: {result}")
    finally:
        session.close()
