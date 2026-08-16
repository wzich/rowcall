from pathlib import Path

import pandas as pd
from rowcall import node


DATA_DIR = Path(__file__).parent / "data"


@node(id="n_load_orders", outputs=["orders_raw"])
def load_orders():
    orders_raw = pd.read_csv(DATA_DIR / "orders.csv", parse_dates=["order_date"])
    return {"orders_raw": orders_raw}


@node(id="n_load_customers", outputs=["customers_raw"])
def load_customers():
    customers_raw = pd.read_csv(
        DATA_DIR / "customers.csv",
        parse_dates=["signup_date"],
    )
    return {"customers_raw": customers_raw}


@node(id="n_load_campaigns", outputs=["campaigns_raw"])
def load_campaigns():
    campaigns_raw = pd.read_csv(DATA_DIR / "campaigns.csv")
    return {"campaigns_raw": campaigns_raw}


@node(id="n_load_support", outputs=["support_raw"])
def load_support_tickets():
    support_raw = pd.read_csv(
        DATA_DIR / "support_tickets.csv",
        parse_dates=["opened_date"],
    )
    return {"support_raw": support_raw}


@node(id="n_prepare_orders", outputs=["orders"])
def prepare_orders(orders_raw):
    orders = orders_raw
    orders["gross_revenue"] = orders["units"] * orders["unit_price"]
    orders["net_revenue"] = (
        orders["gross_revenue"] * (1 - orders["discount_rate"])
    ).round(2)
    orders = orders.loc[~orders["returned"]].sort_values("order_date")
    return {"orders": orders}


@node(id="n_prepare_customers", outputs=["customers"])
def prepare_customers(customers_raw):
    customers = customers_raw
    customers["customer_tenure_days"] = (
        pd.Timestamp("2026-03-31") - customers["signup_date"]
    ).dt.days
    customers["segment"] = customers["segment"].str.title()
    return {"customers": customers}


@node(id="n_prepare_campaigns", outputs=["campaigns"])
def prepare_campaigns(campaigns_raw):
    campaigns = campaigns_raw
    campaigns["channel"] = campaigns["channel"].str.title()
    campaigns["cost_per_click"] = (
        campaigns["spend"] / campaigns["clicks"].clip(lower=1)
    ).round(2)
    return {"campaigns": campaigns}


@node(id="n_summarize_support", outputs=["support_by_customer"])
def summarize_support(support_raw):
    support_by_customer = (
        support_raw
        .assign(is_high_priority=support_raw["priority"].eq("high"))
        .groupby("customer_id", as_index=False)
        .agg(
            tickets=("ticket_id", "count"),
            high_priority_tickets=("is_high_priority", "sum"),
            last_ticket_date=("opened_date", "max"),
        )
    )
    return {"support_by_customer": support_by_customer}


@node(id="n_build_customer_facts", outputs=["customer_facts"])
def build_customer_facts(orders, customers, support_by_customer):
    order_facts = (
        orders
        .groupby("customer_id", as_index=False)
        .agg(
            orders=("order_id", "count"),
            units=("units", "sum"),
            revenue=("net_revenue", "sum"),
            first_order=("order_date", "min"),
            last_order=("order_date", "max"),
        )
    )
    customer_facts = (
        customers
        .merge(order_facts, on="customer_id", how="left")
        .merge(support_by_customer, on="customer_id", how="left")
    )
    customer_facts[["orders", "units", "tickets", "high_priority_tickets"]] = (
        customer_facts[["orders", "units", "tickets", "high_priority_tickets"]]
        .fillna(0)
        .astype(int)
    )
    customer_facts["revenue"] = customer_facts["revenue"].fillna(0).round(2)
    customer_facts["avg_order_value"] = (
        customer_facts["revenue"] / customer_facts["orders"].clip(lower=1)
    ).round(2)
    customer_facts["days_since_last_order"] = (
        pd.Timestamp("2026-03-31") - customer_facts["last_order"]
    ).dt.days
    return {"customer_facts": customer_facts}


@node(id="n_campaign_roi", outputs=["campaign_roi"])
def campaign_roi(customer_facts, campaigns):
    attributed_revenue = (
        customer_facts
        .groupby("acquisition_campaign", as_index=False)
        .agg(
            customers=("customer_id", "count"),
            revenue=("revenue", "sum"),
            avg_order_value=("avg_order_value", "mean"),
        )
        .rename(columns={"acquisition_campaign": "campaign"})
    )
    campaign_roi = (
        campaigns
        .merge(attributed_revenue, on="campaign", how="left")
        .fillna({"customers": 0, "revenue": 0, "avg_order_value": 0})
    )
    campaign_roi["roas"] = (campaign_roi["revenue"] / campaign_roi["spend"]).round(2)
    campaign_roi = campaign_roi.sort_values("roas", ascending=False)
    display(campaign_roi, label="Campaign ROI")
    return {"campaign_roi": campaign_roi}


@node(id="n_segment_revenue", outputs=["segment_revenue"])
def segment_revenue(customer_facts):
    segment_revenue = (
        customer_facts
        .groupby(["region", "segment"], as_index=False)
        .agg(
            customers=("customer_id", "count"),
            revenue=("revenue", "sum"),
            avg_order_value=("avg_order_value", "mean"),
            support_tickets=("tickets", "sum"),
        )
        .sort_values("revenue", ascending=False)
    )
    segment_revenue["avg_order_value"] = segment_revenue["avg_order_value"].round(2)
    display(segment_revenue, label="Segment revenue")
    return {"segment_revenue": segment_revenue}


@node(id="n_retention_risk", outputs=["retention_risk"])
def retention_risk(customer_facts):
    retention_risk = (
        customer_facts
        .assign(
            risk_score=lambda df: (
                df["days_since_last_order"].fillna(120) * 0.5
                + df["high_priority_tickets"] * 20
                - df["orders"] * 3
            ).round(1)
        )
        .loc[lambda df: df["orders"].gt(0)]
        .sort_values("risk_score", ascending=False)
        [[
            "customer_id",
            "customer_name",
            "region",
            "segment",
            "revenue",
            "days_since_last_order",
            "tickets",
            "high_priority_tickets",
            "risk_score",
        ]]
        .head(8)
    )
    display(retention_risk, label="Retention risk")
    return {"retention_risk": retention_risk}


# Rowcall graph
prepare_orders.depends_on(load_orders.output("orders_raw"))
prepare_customers.depends_on(load_customers.output("customers_raw"))
prepare_campaigns.depends_on(load_campaigns.output("campaigns_raw"))
summarize_support.depends_on(load_support_tickets.output("support_raw"))
build_customer_facts.depends_on(
    prepare_orders.output("orders"),
    prepare_customers.output("customers"),
    summarize_support.output("support_by_customer"),
)
campaign_roi.depends_on(
    build_customer_facts.output("customer_facts"),
    prepare_campaigns.output("campaigns"),
)
segment_revenue.depends_on(build_customer_facts.output("customer_facts"))
retention_risk.depends_on(build_customer_facts.output("customer_facts"))
