"""웹 API와 투구 탐색기 화면 (FastAPI)."""

from __future__ import annotations

import math
import threading
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse

from . import metrics as m
from .db import DEFAULT_DB_PATH, connect
from .queries import date_range, get_player, list_players, list_teams, load_pitches
from .report import build_team_report, render_html

TEMPLATES = Path(__file__).parent / "templates"
SCATTER_LIMIT = 3000  # 화면에 점으로 그릴 최대 투구 수


def to_json(value):
    """NaN·numpy 값을 JSON으로 보낼 수 있게 바꾼다."""
    if isinstance(value, dict):
        return {str(k): to_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_json(v) for v in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (float, np.floating)):
        return None if not math.isfinite(float(value)) else float(value)
    if isinstance(value, (np.bool_,)):
        return bool(value)
    if isinstance(value, pd.Timestamp):
        return value.strftime("%Y-%m-%d") if value == value.normalize() else value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if value is pd.NA or value is pd.NaT:
        return None
    return value


def create_app(db_path: str | Path | None = None) -> FastAPI:
    app = FastAPI(title="DugoutLab", version="0.1.0")
    base = connect(db_path or DEFAULT_DB_PATH)
    lock = threading.Lock()

    def con():
        # DuckDB 연결은 스레드마다 cursor() 로 나눠 쓴다
        with lock:
            return base.cursor()

    app.state.con = base

    @app.get("/", response_class=HTMLResponse)
    def explorer():
        return (TEMPLATES / "explorer.html").read_text(encoding="utf-8")

    @app.get("/api/teams")
    def teams():
        c = con()
        lo, hi = date_range(c)
        return {"teams": list_teams(c), "date_from": to_json(lo), "date_to": to_json(hi)}

    @app.get("/api/players")
    def players(team: str | None = None):
        df = list_players(con(), team)
        return to_json(df.to_dict(orient="records"))

    @app.get("/api/players/{player_id}")
    def player(player_id: str, role: str = Query("pitcher", pattern="^(pitcher|batter)$"),
               date_from: str | None = None, date_to: str | None = None):
        c = con()
        info = get_player(c, player_id)
        if not info:
            raise HTTPException(404, "선수를 찾을 수 없습니다")
        key = "pitcher_id" if role == "pitcher" else "batter_id"
        d = load_pitches(c, **{key: player_id}, date_from=date_from, date_to=date_to)
        if d.empty:
            return {"player": info, "role": role, "profile": None}
        prof = m.pitcher_profile(d) if role == "pitcher" else m.batter_profile(d)
        return to_json({"player": info, "role": role, "profile": prof})

    @app.get("/api/pitches")
    def pitches(
        pitcher_id: str | None = None,
        batter_id: str | None = None,
        pitcher_team: str | None = None,
        batter_team: str | None = None,
        pitch_type: list[str] | None = Query(None),
        stand: str | None = None,
        p_throws: str | None = None,
        count: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        result: str | None = Query(None, pattern="^(swing|whiff|in_play|called_strike|ball)$"),
    ):
        """투구 탐색기: 조건에 맞는 투구의 요약 지표와 점 데이터."""
        c = con()
        d = load_pitches(
            c, pitcher_id=pitcher_id, batter_id=batter_id, pitcher_team=pitcher_team, batter_team=batter_team,
            pitch_types=pitch_type, stand=stand, p_throws=p_throws, date_from=date_from, date_to=date_to,
        )
        if not d.empty and count:
            d = d[d["count_bucket"] == count]
        if not d.empty and result:
            mask = {
                "swing": d["is_swing"], "whiff": d["is_whiff"], "in_play": d["is_in_play"],
                "called_strike": d["description"] == "called_strike", "ball": d["description"] == "ball",
            }[result]
            d = d[mask]
        if d.empty:
            return {"total": 0, "summary": None, "by_pitch_type": [], "points": []}
        cols = ["pitch_uid", "game_date", "inning", "pitcher_name", "batter_name", "stand", "p_throws",
                "balls", "strikes", "pitch_type", "release_speed", "spin_rate", "plate_x", "plate_z",
                "description", "pa_result", "launch_speed", "launch_angle", "video_url", "video_ts"]
        pts = d[d["has_loc"]]
        if len(pts) > SCATTER_LIMIT:
            pts = pts.sample(SCATTER_LIMIT, random_state=0)
        return to_json({
            "total": len(d),
            "sampled": len(pts) < int(d["has_loc"].sum()),
            "summary": {"discipline": m.discipline(d), "line": m.slash_line(d), "batted": m.batted_ball(d)},
            "by_pitch_type": m.by_pitch_type(d),
            "points": pts[cols].to_dict(orient="records"),
        })

    @app.get("/reports/team/{team}", response_class=HTMLResponse)
    def team_report(team: str, date_from: str | None = None, date_to: str | None = None,
                    min_pitches: int = 80, min_pa: int = 20):
        try:
            ctx = build_team_report(con(), team, date_from, date_to, min_pitches=min_pitches, min_pa=min_pa)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        return render_html(ctx)

    return app
