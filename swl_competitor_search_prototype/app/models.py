"""SQLAlchemy models for the competitor search and recommendation module."""

from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class Product(Base):
    __tablename__ = "products"

    internal_sku: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    brand: Mapped[str | None] = mapped_column(String(128))
    model: Mapped[str | None] = mapped_column(String(128))
    manufacturer_part_number: Mapped[str | None] = mapped_column(String(128))
    gtin: Mapped[str | None] = mapped_column(String(32))
    category: Mapped[str | None] = mapped_column(String(128))
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    supplier_offers: Mapped[list["SupplierOffer"]] = relationship(back_populates="product")


class SupplierOffer(Base):
    __tablename__ = "supplier_offers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    internal_sku: Mapped[str] = mapped_column(
        ForeignKey("products.internal_sku"), nullable=False, index=True
    )
    supplier: Mapped[str] = mapped_column(String(128), nullable=False)
    cost_ex_gst: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), default="AUD", nullable=False)
    effective_from: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    product: Mapped["Product"] = relationship(back_populates="supplier_offers")


class CompetitorSource(Base):
    __tablename__ = "competitor_sources"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    method: Mapped[str] = mapped_column(String(64), nullable=False)
    approved: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    terms_reviewed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)


class CompetitorProduct(Base):
    __tablename__ = "competitor_products"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source_id: Mapped[int] = mapped_column(
        ForeignKey("competitor_sources.id"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    brand: Mapped[str | None] = mapped_column(String(128))
    manufacturer_part_number: Mapped[str | None] = mapped_column(String(128))
    gtin: Mapped[str | None] = mapped_column(String(32))
    url: Mapped[str | None] = mapped_column(String(512))
    pack_size: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    condition: Mapped[str] = mapped_column(String(32), default="new", nullable=False)
    service_basis: Mapped[str] = mapped_column(
        String(32), default="product_only", nullable=False
    )

    source: Mapped["CompetitorSource"] = relationship()


class CompetitorObservation(Base):
    __tablename__ = "competitor_observations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    internal_sku: Mapped[str] = mapped_column(
        ForeignKey("products.internal_sku"), nullable=False, index=True
    )
    competitor_product_id: Mapped[int] = mapped_column(
        ForeignKey("competitor_products.id"), nullable=False, index=True
    )
    observed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    price: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), default="AUD", nullable=False)
    gst_basis: Mapped[str] = mapped_column(String(16), nullable=False)
    shipping_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    shipping_basis: Mapped[str | None] = mapped_column(String(64))
    stock_status: Mapped[str] = mapped_column(String(16), default="unknown", nullable=False)
    source_url: Mapped[str] = mapped_column(String(512), nullable=False)
    evidence_reference: Mapped[str | None] = mapped_column(String(255))
    match_confidence: Mapped[str] = mapped_column(String(16), nullable=False)
    review_state: Mapped[str] = mapped_column(
        String(16), default="pending", nullable=False, index=True
    )
    reviewer: Mapped[str | None] = mapped_column(String(128))
    stale_state: Mapped[str] = mapped_column(String(16), default="fresh", nullable=False)
    valid: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    competitor_product: Mapped["CompetitorProduct"] = relationship()


class CompetitiveRecommendation(Base):
    __tablename__ = "competitive_recommendations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    internal_sku: Mapped[str] = mapped_column(
        ForeignKey("products.internal_sku"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, nullable=False
    )
    strategy: Mapped[str] = mapped_column(String(32), nullable=False)
    rule_version: Mapped[str] = mapped_column(String(32), nullable=False)
    floor_ex_gst: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    selected_competitor_ex_gst: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    target_ex_gst: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    recommended_ex_gst: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    recommended_incl_gst: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    actual_markup: Mapped[Decimal] = mapped_column(Numeric(12, 4), nullable=False)
    exception_state: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    release_blocked: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)
    observation_ids: Mapped[str | None] = mapped_column(String(512))


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, nullable=False
    )
    actor: Mapped[str] = mapped_column(String(128), nullable=False)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_id: Mapped[str | None] = mapped_column(String(64))
    before_json: Mapped[str | None] = mapped_column(Text)
    after_json: Mapped[str | None] = mapped_column(Text)
    reason: Mapped[str | None] = mapped_column(Text)


Index("ix_observations_sku_state", CompetitorObservation.internal_sku, CompetitorObservation.review_state)
