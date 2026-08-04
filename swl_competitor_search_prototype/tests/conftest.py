"""Test fixtures. In-memory SQLite, no network, no live URLs, no secrets."""

import os

os.environ.setdefault("DATABASE_URL", "sqlite://")
os.environ.setdefault("APP_ENV", "test")

from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base, get_db
from app.main import app
from app.models import (
    CompetitorObservation,
    CompetitorProduct,
    CompetitorSource,
    Product,
    SupplierOffer,
    utc_now,
)


@pytest.fixture()
def db_session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    TestingSession = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    session = TestingSession()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture()
def client(db_session):
    def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture()
def seeded(db_session):
    """Two products, costs, an approved source, an unapproved source, and a competitor product."""
    db_session.add_all(
        [
            Product(
                internal_sku="SWL-ABUS-55-40",
                name="ABUS 55/40 Padlock",
                brand="ABUS",
                model="55/40",
                manufacturer_part_number="55/40",
                category="Padlock",
                active=True,
            ),
            Product(
                internal_sku="SWL-ABUS-55-40-HB",
                name="ABUS 55/40 Padlock High Body",
                brand="ABUS",
                model="55/40 HB",
                manufacturer_part_number="55/40 HB",
                category="Padlock",
                active=True,
            ),
            Product(
                internal_sku="SWL-NO-COST",
                name="Product Without Cost",
                brand="ABUS",
                category="Padlock",
                active=True,
            ),
        ]
    )
    db_session.add_all(
        [
            SupplierOffer(
                internal_sku="SWL-ABUS-55-40",
                supplier="Local Seed Supplier",
                cost_ex_gst=Decimal("60.00"),
                currency="AUD",
                active=True,
            ),
            SupplierOffer(
                internal_sku="SWL-ABUS-55-40-HB",
                supplier="Local Seed Supplier",
                cost_ex_gst=Decimal("75.00"),
                currency="AUD",
                active=True,
            ),
        ]
    )
    approved = CompetitorSource(
        name="Manual Entry", method="manual", approved=True, terms_reviewed=True
    )
    unapproved = CompetitorSource(
        name="Unapproved Example", method="manual", approved=False, terms_reviewed=False
    )
    db_session.add_all([approved, unapproved])
    db_session.flush()

    cp_approved = CompetitorProduct(
        source_id=approved.id,
        title="ABUS 55/40 Padlock",
        brand="ABUS",
        manufacturer_part_number="55/40",
        url="https://example.com/abus-55-40",
        pack_size=1,
        condition="new",
        service_basis="product_only",
    )
    cp_unapproved = CompetitorProduct(
        source_id=unapproved.id,
        title="ABUS 55/40 Padlock",
        brand="ABUS",
        manufacturer_part_number="55/40",
        url="https://example.com/other-abus-55-40",
        pack_size=1,
        condition="new",
        service_basis="product_only",
    )
    db_session.add_all([cp_approved, cp_unapproved])
    db_session.commit()
    return {
        "approved_source": approved,
        "unapproved_source": unapproved,
        "cp_approved": cp_approved,
        "cp_unapproved": cp_unapproved,
    }


def make_observation(db_session, cp_id, **overrides):
    defaults = dict(
        internal_sku="SWL-ABUS-55-40",
        competitor_product_id=cp_id,
        observed_at=utc_now(),
        price=Decimal("100.00"),
        currency="AUD",
        gst_basis="inclusive",
        stock_status="in_stock",
        source_url="https://example.com/abus-55-40",
        match_confidence="high",
        review_state="accepted",
        reviewer="test_reviewer",
        stale_state="fresh",
        valid=True,
    )
    defaults.update(overrides)
    obs = CompetitorObservation(**defaults)
    db_session.add(obs)
    db_session.commit()
    return obs
