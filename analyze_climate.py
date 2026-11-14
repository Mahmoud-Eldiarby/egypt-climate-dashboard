#!/usr/bin/env python3
"""Reproduce the Egypt climate dashboard analysis from the supplied workbooks."""

from __future__ import annotations

import argparse
import csv
import json
import math
import posixpath
import re
import statistics
import sys
import zipfile
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from xml.etree import ElementTree


MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
START_YEAR = 2000
END_YEAR = 2024
HOT_THRESHOLDS = (35, 38, 40, 42)


def _column_index(reference: str) -> int:
    letters = re.match(r"[A-Z]+", reference.upper())
    if not letters:
        raise ValueError(f"Invalid Excel cell reference: {reference}")
    index = 0
    for letter in letters.group():
        index = index * 26 + ord(letter) - ord("A") + 1
    return index - 1


def read_xlsx(path: Path) -> list[dict[str, str]]:
    """Read the first worksheet in an .xlsx file using only the standard library."""
    if not path.is_file():
        raise FileNotFoundError(f"Required workbook was not found: {path}")

    try:
        with zipfile.ZipFile(path) as workbook:
            workbook_xml = ElementTree.fromstring(workbook.read("xl/workbook.xml"))
            sheet = workbook_xml.find(f".//{{{MAIN_NS}}}sheets/{{{MAIN_NS}}}sheet")
            if sheet is None:
                raise ValueError("Workbook does not contain a worksheet.")

            relationship_id = sheet.attrib.get(f"{{{DOC_REL_NS}}}id")
            relationships_xml = ElementTree.fromstring(
                workbook.read("xl/_rels/workbook.xml.rels")
            )
            target = next(
                (
                    relationship.attrib["Target"]
                    for relationship in relationships_xml.findall(
                        f"{{{PKG_REL_NS}}}Relationship"
                    )
                    if relationship.attrib.get("Id") == relationship_id
                ),
                None,
            )
            if target is None:
                raise ValueError("Could not locate the first worksheet in the workbook.")

            if target.startswith("/"):
                worksheet_path = target.lstrip("/")
            else:
                worksheet_path = posixpath.normpath(posixpath.join("xl", target))

            shared_strings: list[str] = []
            if "xl/sharedStrings.xml" in workbook.namelist():
                shared_xml = ElementTree.fromstring(
                    workbook.read("xl/sharedStrings.xml")
                )
                shared_strings = [
                    "".join(node.text or "" for node in item.iter(f"{{{MAIN_NS}}}t"))
                    for item in shared_xml.findall(f"{{{MAIN_NS}}}si")
                ]

            worksheet_xml = ElementTree.fromstring(workbook.read(worksheet_path))
    except (KeyError, zipfile.BadZipFile, ElementTree.ParseError) as error:
        raise ValueError(f"Could not read workbook {path.name}: {error}") from error

    sheet_data = worksheet_xml.find(f".//{{{MAIN_NS}}}sheetData")
    if sheet_data is None:
        raise ValueError(f"No worksheet data found in {path.name}.")

    rows: list[list[str]] = []
    for row_node in sheet_data.findall(f"{{{MAIN_NS}}}row"):
        values: list[str] = []
        for cell in row_node.findall(f"{{{MAIN_NS}}}c"):
            index = _column_index(cell.attrib.get("r", ""))
            while len(values) <= index:
                values.append("")

            cell_type = cell.attrib.get("t")
            if cell_type == "inlineStr":
                value = "".join(
                    node.text or "" for node in cell.iter(f"{{{MAIN_NS}}}t")
                )
            else:
                value_node = cell.find(f"{{{MAIN_NS}}}v")
                value = "" if value_node is None or value_node.text is None else value_node.text
                if cell_type == "s" and value:
                    value = shared_strings[int(value)]
                elif cell_type == "b" and value:
                    value = "true" if value == "1" else "false"
            values[index] = value
        if any(value.strip() for value in values):
            rows.append(values)

    if not rows:
        raise ValueError(f"No rows found in {path.name}.")

    headers = [value.strip() or f"column_{index + 1}" for index, value in enumerate(rows[0])]
    records: list[dict[str, str]] = []
    for values in rows[1:]:
        padded = values + [""] * (len(headers) - len(values))
        record = dict(zip(headers, padded))
        if any(value.strip() for value in record.values()):
            records.append(record)
    return records


def require_columns(
    records: list[dict[str, str]], columns: tuple[str, ...], source_name: str
) -> None:
    if not records:
        raise ValueError(f"{source_name} contains no data rows.")
    missing = [column for column in columns if column not in records[0]]
    if missing:
        raise ValueError(
            f"{source_name} is missing required columns: {', '.join(missing)}"
        )


def number(value: str, context: str) -> float | None:
    if value is None or not value.strip():
        return None
    try:
        result = float(value)
    except ValueError as error:
        raise ValueError(f"Expected a number for {context}; received {value!r}.") from error
    return result if math.isfinite(result) else None


def mean(values: list[float]) -> float | None:
    return statistics.fmean(values) if values else None


def linear_fit(points: list[tuple[int, float]]) -> tuple[float | None, float | None]:
    if len(points) < 2:
        return None, None
    mean_x = statistics.fmean(x for x, _ in points)
    mean_y = statistics.fmean(y for _, y in points)
    denominator = sum((x - mean_x) ** 2 for x, _ in points)
    if denominator == 0:
        return None, None
    slope = sum((x - mean_x) * (y - mean_y) for x, y in points) / denominator
    return slope, mean_y - slope * mean_x


def excel_date(value: str, context: str) -> date:
    numeric = number(value, context)
    if numeric is not None:
        return date(1899, 12, 30) + timedelta(days=int(numeric))
    for date_format in ("%Y-%m-%d", "%A, %B %d, %Y"):
        try:
            return datetime.strptime(value.strip(), date_format).date()
        except ValueError:
            continue
    raise ValueError(f"Could not parse date {value!r} in {context}.")


def write_csv(path: Path, fields: list[str], rows: list[dict[str, object]]) -> None:
    with path.open("w", newline="", encoding="utf-8-sig") as output:
        writer = csv.DictWriter(output, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def analyze(data_dir: Path, output_dir: Path) -> dict[str, object]:
    output_dir.mkdir(parents=True, exist_ok=True)

    egypt = read_xlsx(data_dir / "egypt_climate_2000_2025.xlsx")
    world = read_xlsx(data_dir / "world_climate_2000_2025.xlsx")
    cairo = read_xlsx(data_dir / "Cairo-Weather.xlsx")
    governorates = read_xlsx(data_dir / "governorates_final o.xlsx")

    require_columns(
        egypt,
        ("Governorate", "Year", "Month", "Temperature_C", "Temp_Max_C", "Temp_Min_C"),
        "Egypt workbook",
    )
    require_columns(
        world,
        ("Country", "City", "Year", "Month", "Temperature_C"),
        "World workbook",
    )
    require_columns(
        cairo,
        ("date", "temperature_2m_max", "temperature_2m_mean", "temperature_2m_min"),
        "Cairo daily workbook",
    )
    require_columns(
        governorates,
        (
            "Governorate",
            "Warming_per_decade",
            "p_value",
            "Forecast_2035",
            "Avg_Temp",
            "Cluster name",
        ),
        "Governorate forecast workbook",
    )

    egypt_groups: dict[int, list[dict[str, str]]] = defaultdict(list)
    egypt_by_governorate: dict[str, dict[int, list[float]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for row in egypt:
        year = int(number(row["Year"], "Egypt Year") or 0)
        if START_YEAR <= year <= END_YEAR:
            egypt_groups[year].append(row)
            temperature = number(row["Temperature_C"], "Egypt Temperature_C")
            if temperature is not None:
                egypt_by_governorate[row["Governorate"]][year].append(temperature)

    egypt_annual: list[dict[str, object]] = []
    for year, rows in sorted(egypt_groups.items()):
        means: dict[str, float | None] = {}
        for column in ("Temperature_C", "Temp_Max_C", "Temp_Min_C"):
            values = [
                value
                for row in rows
                if (value := number(row[column], f"Egypt {column}")) is not None
            ]
            means[column] = mean(values)
        egypt_annual.append(
            {
                "year": year,
                "mean_temperature_c": means["Temperature_C"],
                "mean_monthly_max_c": means["Temp_Max_C"],
                "mean_monthly_min_c": means["Temp_Min_C"],
                "observations": len(rows),
                "governorates": len({row["Governorate"] for row in rows}),
            }
        )
    write_csv(
        output_dir / "egypt_annual.csv",
        [
            "year",
            "mean_temperature_c",
            "mean_monthly_max_c",
            "mean_monthly_min_c",
            "observations",
            "governorates",
        ],
        egypt_annual,
    )

    governorate_analysis: list[dict[str, object]] = []
    for governorate, year_groups in sorted(egypt_by_governorate.items()):
        annual = [(year, mean(values)) for year, values in sorted(year_groups.items())]
        points = [(year, value) for year, value in annual if value is not None]
        slope, _ = linear_fit(points)
        governorate_analysis.append(
            {
                "governorate": governorate,
                "mean_temperature_c": mean(
                    [value for _, value in points if value is not None]
                ),
                "warming_c_per_decade": None if slope is None else slope * 10,
                "years_covered": len(points),
            }
        )
    write_csv(
        output_dir / "egypt_governorates.csv",
        [
            "governorate",
            "mean_temperature_c",
            "warming_c_per_decade",
            "years_covered",
        ],
        governorate_analysis,
    )

    world_groups: dict[int, list[dict[str, str]]] = defaultdict(list)
    for row in world:
        year = int(number(row["Year"], "World Year") or 0)
        if START_YEAR <= year <= END_YEAR:
            world_groups[year].append(row)

    world_means: dict[int, float] = {}
    world_annual: list[dict[str, object]] = []
    for year, rows in sorted(world_groups.items()):
        temperatures = [
            value
            for row in rows
            if (value := number(row["Temperature_C"], "World Temperature_C")) is not None
        ]
        annual_mean = mean(temperatures)
        if annual_mean is None:
            continue
        world_means[year] = annual_mean
        world_annual.append(
            {
                "year": year,
                "mean_temperature_c": annual_mean,
                "anomaly_vs_2000_2009_c": "",
                "observations": len(temperatures),
                "cities": len({row["City"] for row in rows}),
                "countries": len({row["Country"] for row in rows}),
            }
        )
    baseline_values = [value for year, value in world_means.items() if 2000 <= year <= 2009]
    world_baseline = mean(baseline_values)
    if world_baseline is not None:
        for row in world_annual:
            row["anomaly_vs_2000_2009_c"] = round(
                float(row["mean_temperature_c"]) - world_baseline, 4
            )
    write_csv(
        output_dir / "world_annual.csv",
        [
            "year",
            "mean_temperature_c",
            "anomaly_vs_2000_2009_c",
            "observations",
            "cities",
            "countries",
        ],
        world_annual,
    )

    cairo_by_year_threshold: dict[tuple[int, int], int] = defaultdict(int)
    cairo_by_month_threshold: dict[tuple[int, int], int] = defaultdict(int)
    cairo_day_counts: dict[int, int] = defaultdict(int)
    for row in cairo:
        day = excel_date(row["date"], "Cairo daily date")
        if not START_YEAR <= day.year <= END_YEAR:
            continue
        maximum = number(row["temperature_2m_max"], "Cairo temperature_2m_max")
        if maximum is None:
            continue
        cairo_day_counts[day.year] += 1
        for threshold in HOT_THRESHOLDS:
            if maximum > threshold:
                cairo_by_year_threshold[(day.year, threshold)] += 1
                cairo_by_month_threshold[(day.month, threshold)] += 1

    cairo_yearly: list[dict[str, object]] = []
    for year in range(START_YEAR, END_YEAR + 1):
        for threshold in HOT_THRESHOLDS:
            cairo_yearly.append(
                {
                    "year": year,
                    "threshold_c": threshold,
                    "hot_days": cairo_by_year_threshold[(year, threshold)],
                    "valid_daily_observations": cairo_day_counts[year],
                }
            )
    write_csv(
        output_dir / "cairo_hot_days_annual.csv",
        ["year", "threshold_c", "hot_days", "valid_daily_observations"],
        cairo_yearly,
    )

    cairo_monthly = [
        {
            "month": month,
            "threshold_c": threshold,
            "hot_days": cairo_by_month_threshold[(month, threshold)],
        }
        for month in range(1, 13)
        for threshold in HOT_THRESHOLDS
    ]
    write_csv(
        output_dir / "cairo_hot_days_monthly.csv",
        ["month", "threshold_c", "hot_days"],
        cairo_monthly,
    )

    forecast_rows: list[dict[str, object]] = []
    for row in governorates:
        forecast_rows.append(
            {
                "governorate": row["Governorate"],
                "warming_c_per_decade": number(
                    row["Warming_per_decade"], "Forecast Warming_per_decade"
                ),
                "p_value": number(row["p_value"], "Forecast p_value"),
                "forecast_2035_c": number(row["Forecast_2035"], "Forecast_2035"),
                "mean_temperature_c": number(row["Avg_Temp"], "Forecast Avg_Temp"),
                "cluster": row["Cluster name"],
            }
        )
    write_csv(
        output_dir / "governorate_forecasts.csv",
        [
            "governorate",
            "warming_c_per_decade",
            "p_value",
            "forecast_2035_c",
            "mean_temperature_c",
            "cluster",
        ],
        forecast_rows,
    )

    egypt_points = [
        (int(row["year"]), float(row["mean_temperature_c"]))
        for row in egypt_annual
        if row["mean_temperature_c"] is not None
    ]
    world_points = sorted(world_means.items())
    egypt_slope, _ = linear_fit(egypt_points)
    world_slope, _ = linear_fit(world_points)
    egypt_baseline = mean([value for year, value in egypt_points if 2000 <= year <= 2009])
    egypt_recent = mean([value for year, value in egypt_points if 2015 <= year <= 2024])
    hottest_governorate = max(
        forecast_rows,
        key=lambda row: float(row["mean_temperature_c"] or float("-inf")),
    )
    fastest_warming_governorate = max(
        forecast_rows,
        key=lambda row: float(row["warming_c_per_decade"] or float("-inf")),
    )
    summary = {
        "period_analyzed": {"start_year": START_YEAR, "end_year": END_YEAR},
        "data_sources": {
            "egypt_monthly_rows": len(egypt),
            "world_monthly_rows": len(world),
            "cairo_daily_rows": len(cairo),
            "governorate_forecast_rows": len(governorates),
        },
        "coverage": {
            "egypt_years": sorted(egypt_groups),
            "world_years": sorted(world_groups),
            "cairo_years_with_observations": sorted(cairo_day_counts),
        },
        "egypt": {
            "warming_c_per_decade_ols": None if egypt_slope is None else round(egypt_slope * 10, 4),
            "mean_2000_2009_c": None if egypt_baseline is None else round(egypt_baseline, 4),
            "mean_2015_2024_c": None if egypt_recent is None else round(egypt_recent, 4),
            "recent_minus_baseline_c": (
                None
                if egypt_baseline is None or egypt_recent is None
                else round(egypt_recent - egypt_baseline, 4)
            ),
        },
        "world": {
            "warming_c_per_decade_ols": None if world_slope is None else round(world_slope * 10, 4),
            "mean_2000_2009_c": None if world_baseline is None else round(world_baseline, 4),
        },
        "governorate_extremes_from_forecast_workbook": {
            "hottest_by_mean_temperature": hottest_governorate["governorate"],
            "fastest_warming": fastest_warming_governorate["governorate"],
        },
        "cairo_hot_days": {},
        "method_notes": [
            "Monthly observations are averaged with equal weight per row.",
            "Egypt and world warming rates are ordinary least-squares trends of annual means.",
            "World anomalies use the mean of annual means from 2000 through 2009.",
            "Hot days count when Cairo daily maximum temperature is strictly greater than the threshold.",
            "2025 is excluded from all analyses because it is incomplete.",
            "Forecast and p-value columns are read from the supplied governorate summary workbook; they are not refitted.",
        ],
    }

    for threshold in (35, 40):
        points = [
            (year, float(cairo_by_year_threshold[(year, threshold)]))
            for year in range(START_YEAR, END_YEAR + 1)
        ]
        hot_slope, _ = linear_fit(points)
        summary["cairo_hot_days"][str(threshold)] = {
            "total_days": sum(count for (year, t), count in cairo_by_year_threshold.items() if t == threshold),
            "change_per_decade_ols": (
                None if hot_slope is None else round(hot_slope * 10, 4)
            ),
        }

    summary_path = output_dir / "analysis_summary.json"
    summary_path.write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Analyze the climate Excel workbooks included with this project."
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path(__file__).resolve().parent,
        help="Folder containing the source .xlsx files (defaults to this script's folder).",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parent / "analysis_output",
        help="Folder where CSV tables and the JSON summary will be written.",
    )
    args = parser.parse_args()

    try:
        summary = analyze(args.data_dir, args.output_dir)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        print(f"Analysis failed: {error}", file=sys.stderr)
        return 1

    egypt = summary["egypt"]
    world = summary["world"]
    print(f"Analysis period: {START_YEAR}-{END_YEAR}")
    print(
        "Egypt OLS warming rate: "
        f"{egypt['warming_c_per_decade_ols']} °C/decade"
    )
    print(
        "World-city OLS warming rate: "
        f"{world['warming_c_per_decade_ols']} °C/decade"
    )
    print(f"Results written to: {args.output_dir.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
