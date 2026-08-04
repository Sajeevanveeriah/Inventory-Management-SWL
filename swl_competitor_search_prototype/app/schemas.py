"""Pydantic schemas for API requests and responses."""

from datetime import datetime
from decimal import Decimal
from enum import Enum

from pydantic import BaseModel, Field, field_validator


class GstBasis(str, Enum):
    inclusive = "inclusive"
    exclusive = "exclusive"
    unknown = "unknown"


class StockStatus(str, Enum):
    in_stock = "in_stock"
    out_of_stock = "out_of_stock"
    unknown = "unknown"


class MatchConfidence(str, Enum):
    high = "high"
    medium = "medium"
    low = "low"


class Strategy(str, Enum):
    MATCH = "MATCH"
    UNDERCUT_AMOUNT = "UNDERCUT_AMOUNT"
    UNDERCUT_PERCENT = "UNDERCUT_PERCENT"
    MAINTAIN_FLOOR = "MAINTAIN_FLOOR"


class CompetitorSearchRequest(BaseModel):
    internal_sku: str
    query: str | None = None
    source_ids: list[int] | None = None


class ObservationCreate(BaseModel):
    internal_sku: str
    competitor_product_id: int
    observed_at: datetime
    price: Decimal
    currency: str = "AUD"
    gst_basis: GstBasis
    shipping_amount: Decimal | None = None
    shipping_basis: str | None = None
    stock_status: StockStatus = StockStatus.unknown
    source_url: str
    evidence_reference: str | None = None
    match_confidence: MatchConfidence
    reviewer: str | None = None
    notes: str | None = None

    @field_validator("price")
    @classmethod
    def price_not_negative(cls, v: Decimal) -> Decimal:
        if v < 0:
            raise ValueError("Price must not be negative")
        return v

    @field_validator("source_url")
    @classmethod
    def source_url_valid(cls, v: str) -> str:
        if not v or not v.startswith(("http://", "https://")):
            raise ValueError("source_url must be a valid http or https URL")
        return v


class ObservationAccept(BaseModel):
    reviewer: str = Field(min_length=1)


class ObservationReject(BaseModel):
    reviewer: str = Field(min_length=1)
    reason: str = Field(min_length=1)


class RecommendationRequest(BaseModel):
    internal_sku: str
    strategy: Strategy = Strategy.MATCH
    undercut_amount: Decimal | None = None
    undercut_percent: Decimal | None = None
    observation_ids: list[int] | None = None
