from pathlib import Path

import pandas as pd
from nodebook import display, node


DATA_DIR = Path("examples/transit_reliability/data")


def _combine_service_datetime(df, date_col, time_col):
    return pd.to_datetime(
        df[date_col].dt.strftime("%Y-%m-%d") + " " + df[time_col].fillna(""),
        errors="coerce",
    )


@node(id="n_load_trips", outputs=["trips_raw", "trips_ra", "trips_r", "trips_", "trips"])
def load_trips():
    trips = pd.read_csv(
        DATA_DIR / "trips.csv",
        parse_dates=["service_date"],
    )
    return {"trips_raw": trips_raw, "trips_ra": trips_ra, "trips_r": trips_r, "trips_": trips_, "trips": trips}


@node(id="n_load_routes", outputs=["routes_raw"])
def load_routes():
    routes_raw = pd.read_csv(DATA_DIR / "routes.csv")
    return {"routes_raw": routes_raw}


@node(id="n_load_maintenance", outputs=["maintenance_raw"])
def load_maintenance():
    maintenance_raw = pd.read_csv(
        DATA_DIR / "maintenance.csv",
        parse_dates=["maintenance_date"],
    )
    return {"maintenance_raw": maintenance_raw}


@node(id="n_prepare_trips", outputs=["trips"])
def prepare_trips(trips_raw):
    trips["scheduled_departure_at"] = _combine_service_datetime(
        trips,
        "service_date",
        "scheduled_departure",
    )
    trips["actual_departure_at"] = _combine_service_datetime(
        trips,
        "service_date",
        "actual_departure",
    )
    trips["scheduled_arrival_at"] = _combine_service_datetime(
        trips,
        "service_date",
        "scheduled_arrival",
    )
    trips["actual_arrival_at"] = _combine_service_datetime(
        trips,
        "service_date",
        "actual_arrival",
    )
    trips["completed"] = ~trips["cancelled"] & trips["actual_arrival_at"].notna()
    trips["departure_delay_min"] = (
        trips["actual_departure_at"] - trips["scheduled_departure_at"]
    ).dt.total_seconds() / 60
    trips["arrival_delay_min"] = (
        trips["actual_arrival_at"] - trips["scheduled_arrival_at"]
    ).dt.total_seconds() / 60
    trips["is_late"] = trips["completed"] & trips["arrival_delay_min"].gt(5)
    trips["departure_hour"] = trips["scheduled_departure_at"].dt.hour
    trips["is_peak"] = trips["departure_hour"].between(7, 9) | trips[
        "departure_hour"
    ].between(16, 18)
    return {"trips": trips}


@node(id="n_prepare_routes", outputs=["routes"])
def prepare_routes(routes_raw):
    routes = routes_raw.copy()
    routes["mode"] = routes["mode"].str.title()
    routes["region"] = routes["region"].str.title()
    return {"routes": routes}


@node(id="n_prepare_maintenance", outputs=["maintenance"])
def prepare_maintenance(maintenance_raw):
    maintenance = maintenance_raw.copy()
    maintenance["severity"] = maintenance["severity"].str.lower()
    maintenance["is_high_severity"] = maintenance["severity"].eq("high")
    return {"maintenance": maintenance}


@node(id="n_summarize_maintenance", outputs=["vehicle_maintenance"])
def summarize_maintenance(maintenance):
    vehicle_maintenance = (
        maintenance
        .groupby("vehicle_id", as_index=False)
        .agg(
            maintenance_events=("issue_type", "count"),
            high_severity_events=("is_high_severity", "sum"),
            downtime_hours=("downtime_hours", "sum"),
            last_maintenance_date=("maintenance_date", "max"),
        )
    )
    return {"vehicle_maintenance": vehicle_maintenance}


@node(id="n_build_trip_facts", outputs=["trip_facts"])
def build_trip_facts(trips, routes, vehicle_maintenance):
    trip_facts = (
        trips
        .merge(routes, on="route_id", how="left")
        .merge(vehicle_maintenance, on="vehicle_id", how="left")
    )
    trip_facts[[
        "maintenance_events",
        "high_severity_events",
        "downtime_hours",
    ]] = trip_facts[[
        "maintenance_events",
        "high_severity_events",
        "downtime_hours",
    ]].fillna(0)
    return {"trip_facts": trip_facts}


@node(id="n_challenge_questions", outputs=["challenge_questions"])
def challenge_questions():
    challenge_questions = pd.DataFrame(
        [
            {
                "difficulty": "easy",
                "question": "How many trips were scheduled, completed, and cancelled?",
                "hint": "Start from trips. Count rows, completed trips, and cancelled trips.",
            },
            {
                "difficulty": "easy",
                "question": "What percentage of completed trips arrived more than 5 minutes late?",
                "hint": "Filter to completed trips and average the boolean is_late column.",
            },
            {
                "difficulty": "medium",
                "question": "Which routes carried the most passengers?",
                "hint": "Use trip_facts, group by route_name, and sum passenger_count.",
            },
            {
                "difficulty": "medium",
                "question": "Which routes have the worst peak-hour on-time performance?",
                "hint": "Filter to completed peak trips, then group by route_name and region.",
            },
            {
                "difficulty": "hard",
                "question": "Do vehicles with more maintenance downtime have worse reliability?",
                "hint": "Compare vehicle-level delay and cancellation metrics to downtime_hours.",
            },
            {
                "difficulty": "hard",
                "question": "Which route-region combinations should be prioritized for reliability work?",
                "hint": "Create a score using late rate, cancellation rate, and passenger volume.",
            },
        ]
    )
    display(challenge_questions)
    return {"challenge_questions": challenge_questions}


@node(id="n_preview_joined_data", outputs=["joined_data_preview"])
def preview_joined_data(trip_facts):
    columns = [
        "trip_id",
        "route_name",
        "region",
        "vehicle_id",
        "completed",
        "is_peak",
        "arrival_delay_min",
        "is_late",
        "passenger_count",
        "downtime_hours",
        "high_severity_events",
    ]
    joined_data_preview = trip_facts[columns].head(10)
    display(joined_data_preview)
    return {"joined_data_preview": joined_data_preview}


@node(id="n_basic_reliability_starter", outputs=["basic_reliability"])
def basic_reliability_starter(trips):
    # TODO: fill in the values for scheduled_trips, completed_trips,
    # cancelled_trips, and late_trip_rate.
    basic_reliability = pd.DataFrame(
        [
            {"metric": "scheduled_trips", "value": None},
            {"metric": "completed_trips", "value": None},
            {"metric": "cancelled_trips", "value": None},
            {"metric": "late_trip_rate", "value": None},
        ]
    )
    display(basic_reliability)
    return {"basic_reliability": basic_reliability}


@node(id="n_peak_route_starter", outputs=["peak_route_reliability"])
def peak_route_starter(trip_facts):
    # TODO: filter to completed peak trips, then group by route_name and region.
    peak_route_reliability = pd.DataFrame(
        columns=[
            "route_name",
            "region",
            "completed_peak_trips",
            "late_rate",
            "avg_arrival_delay_min",
        ]
    )
    display(peak_route_reliability)
    return {"peak_route_reliability": peak_route_reliability}


@node(id="n_maintenance_risk_starter", outputs=["maintenance_risk"])
def maintenance_risk_starter(trip_facts):
    # TODO: summarize trip performance by vehicle_id, then compare it to
    # downtime_hours and high_severity_events.
    maintenance_risk = pd.DataFrame(
        columns=[
            "vehicle_id",
            "completed_trips",
            "cancelled_trips",
            "late_rate",
            "avg_arrival_delay_min",
            "downtime_hours",
            "high_severity_events",
        ]
    )
    display(maintenance_risk)
    return {"maintenance_risk": maintenance_risk}


@node(id="n_priority_routes_starter", outputs=["priority_routes"])
def priority_routes_starter(trip_facts):
    # TODO: build a route-region score using late rate, cancellation rate,
    # passenger_count, or another metric you think is defensible.
    priority_routes = pd.DataFrame(
        columns=[
            "route_name",
            "region",
            "trips",
            "passengers",
            "late_rate",
            "cancellation_rate",
            "priority_score",
        ]
    )
    display(priority_routes)
    return {"priority_routes": priority_routes}


# NodeBook graph
prepare_trips.depends_on(load_trips)
prepare_routes.depends_on(load_routes)
prepare_maintenance.depends_on(load_maintenance)
summarize_maintenance.depends_on(prepare_maintenance)
build_trip_facts.depends_on(
    prepare_trips,
    prepare_routes,
    summarize_maintenance,
)
preview_joined_data.depends_on(build_trip_facts)
basic_reliability_starter.depends_on(prepare_trips)
peak_route_starter.depends_on(build_trip_facts)
maintenance_risk_starter.depends_on(build_trip_facts)
priority_routes_starter.depends_on(build_trip_facts)
