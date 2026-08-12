from pathlib import Path

import polars as pl
from rowcall import display, node


DATA_PATH = Path(__file__).parent / "data" / "orders.csv"


@node(id="n_orders_load", outputs=["orders_raw"])
def load_orders():
    orders_raw = pl.read_csv(DATA_PATH, try_parse_dates=True)
    return {"orders_raw": orders_raw}


@node(id="n_orders_prepare", outputs=["orders"])
def prepare_orders(orders_raw):
    orders = (
        orders_raw
        .with_columns(
            gross=pl.col("units") * pl.col("unit_price"),
            net=(
                pl.col("units")
                * pl.col("unit_price")
                * (1 - pl.col("discount_rate"))
            ).round(2),
        )
        .filter(~pl.col("returned"))
        .sort(["region", "category", "order_date"])
    )
    return {"orders": orders}


@node(id="n_orders_summarize", outputs=["summary"])
def summarize_by_region(orders):
    summary = (
        orders
        .group_by("region")
        .agg(
            orders=pl.len(),
            units=pl.col("units").sum(),
            revenue=pl.col("net").sum().round(2),
            avg_order=pl.col("net").mean().round(2),
        )
        .sort("revenue", descending=True)
    )
    return {"summary": summary}


@node(id="n_orders_render", outputs=[])
def render_summary(summary):
    display(summary)
    return {}


# Rowcall graph
prepare_orders.depends_on(load_orders)
summarize_by_region.depends_on(prepare_orders)
render_summary.depends_on(summarize_by_region)
