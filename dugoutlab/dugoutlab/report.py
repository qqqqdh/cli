"""상대팀 스카우팅 리포트 자동 생성 (HTML, 선택적으로 PDF)."""

from __future__ import annotations

import math
import os
from datetime import date, datetime
from pathlib import Path

import duckdb
from jinja2 import Environment, PackageLoader, select_autoescape
from markupsafe import Markup

from . import metrics as m
from . import svg
from .db import team_name as db_team_name
from .queries import load_pitches


def _fmt_pct(v, digits: int = 0) -> str:
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return "–"
    return f"{v * 100:.{digits}f}%"


def _fmt_rate3(v) -> str:
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return "–"
    return f"{v:.3f}".replace("0.", ".", 1) if v < 1 else f"{v:.3f}"


def _fmt_num(v, digits: int = 1) -> str:
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return "–"
    return f"{v:,.{digits}f}"


def _env() -> Environment:
    env = Environment(loader=PackageLoader("dugoutlab", "templates"), autoescape=select_autoescape(["html"]))
    env.filters["pct"] = _fmt_pct
    env.filters["r3"] = _fmt_rate3
    env.filters["num"] = _fmt_num
    env.globals["pitch_color"] = svg.pitch_color
    return env


def build_team_report(
    con: duckdb.DuckDBPyConnection,
    team: str,
    date_from: date | str | None = None,
    date_to: date | str | None = None,
    min_pitches: int = 80,
    min_pa: int = 20,
    team_name: str | None = None,
) -> dict:
    """상대팀의 투수진·타선을 분석해 리포트에 넣을 데이터를 만든다.

    비교 기준(리그 평균)은 같은 기간 전체 데이터로 계산한다.
    """
    league = load_pitches(con, date_from=date_from, date_to=date_to)
    if league.empty:
        raise ValueError("선택한 기간에 투구 데이터가 없습니다")
    baseline = m.league_baseline(league)

    pit = league[league["pitcher_team"] == team]
    bat = league[league["batter_team"] == team]
    if pit.empty and bat.empty:
        raise ValueError(f"{team} 팀 데이터가 없습니다")

    pitchers = []
    for pid, g in pit.groupby("pitcher_id"):
        if len(g) < min_pitches:
            continue
        prof = m.pitcher_profile(g)
        per_game = len(g) / max(prof["games"], 1)
        heatmaps = []
        for row in prof["arsenal"][:3]:
            sub = g[g["pitch_type"] == row["pitch_type"]]
            grid = m.zone_grid(sub, "freq")
            peak = max((c["v"] for r in grid["cells"] for c in r if math.isfinite(c["v"])), default=0.1)
            heatmaps.append(Markup(svg.zone_heatmap(
                grid, f"{row['name']} 로케이션 ({row['n']}구)", 0, max(peak, 0.05), scheme="blue", min_n=3, size=150,
            )))
        pitchers.append({
            "id": pid,
            "name": g["pitcher_name"].iloc[0],
            "throws": g["p_throws"].iloc[0],
            "role": "선발" if per_game >= 50 else "불펜",
            "profile": prof,
            "notes": m.pitcher_notes(prof, baseline),
            "movement_svg": Markup(svg.movement_chart(prof["arsenal"])),
            "usage_svg": Markup(svg.usage_bar(prof["arsenal"])),
            "heatmaps": heatmaps,
        })
    pitchers.sort(key=lambda p: (p["role"] != "선발", -p["profile"]["pitches"]))

    batters = []
    for bid, g in bat.groupby("batter_id"):
        pa = int(g["is_pa_end"].sum())
        if pa < min_pa:
            continue
        prof = m.batter_profile(g)
        batters.append({
            "id": bid,
            "name": g["batter_name"].iloc[0],
            "stand": prof["stand"],
            "profile": prof,
            "notes": m.batter_notes(prof, baseline),
            "whiff_svg": Markup(svg.zone_heatmap(prof["zone_whiff"], "코스별 헛스윙%", 0, 0.6, min_n=5)),
            "woba_svg": Markup(svg.zone_heatmap(prof["zone_woba"], "코스별 wOBA", 0.15, 0.65, fmt="r3", min_n=5)),
        })
    batters.sort(key=lambda b: -b["profile"]["line"]["pa"])

    team_bat = m.slash_line(bat) if len(bat) else None
    team_pit = m.slash_line(pit) if len(pit) else None
    games = sorted(set(pit["game_id"]) | set(bat["game_id"]))
    dates = league["game_date"]
    return {
        "team": team,
        "team_name": team_name or db_team_name(con, team),
        "period": (str(date_from or dates.min()), str(date_to or dates.max())),
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "games": len(games),
        "baseline": baseline,
        "team_batting": team_bat,
        "team_batting_disc": m.discipline(bat) if len(bat) else None,
        "team_pitching": team_pit,
        "team_pitching_disc": m.discipline(pit) if len(pit) else None,
        "pitchers": pitchers,
        "batters": batters,
        "count_buckets": m.COUNT_BUCKETS,
        "min_pitches": min_pitches,
        "min_pa": min_pa,
    }


def render_html(context: dict) -> str:
    return _env().get_template("team_report.html").render(**context)


def write_pdf(html: str, out_path: str | Path) -> Path:
    """HTML을 PDF로 저장한다. `pip install dugoutlab[pdf]` 와 Playwright 브라우저가 필요하다.

    브라우저 경로를 직접 지정하려면 환경변수 DUGOUTLAB_CHROMIUM 을 쓴다.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:  # pragma: no cover - 선택 기능
        raise RuntimeError(
            "PDF 저장에는 Playwright가 필요합니다: pip install 'dugoutlab[pdf]' && playwright install chromium"
        ) from exc
    out = Path(out_path)
    launch = {"executable_path": os.environ["DUGOUTLAB_CHROMIUM"]} if os.environ.get("DUGOUTLAB_CHROMIUM") else {}
    with sync_playwright() as pw:  # pragma: no cover - 브라우저 필요
        browser = pw.chromium.launch(**launch)
        page = browser.new_page()
        page.set_content(html, wait_until="load")
        page.pdf(path=str(out), format="A4", print_background=True,
                 margin={"top": "12mm", "bottom": "12mm", "left": "10mm", "right": "10mm"})
        browser.close()
    return out
