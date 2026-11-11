"""DB 조회: 조건에 맞는 투구를 선수 이름과 함께 DataFrame으로 꺼낸다."""

from __future__ import annotations

from datetime import date

import duckdb
import pandas as pd

from .metrics import add_flags


def load_pitches(
    con: duckdb.DuckDBPyConnection,
    *,
    pitcher_id: str | None = None,
    batter_id: str | None = None,
    pitcher_team: str | None = None,
    batter_team: str | None = None,
    date_from: date | str | None = None,
    date_to: date | str | None = None,
    pitch_types: list[str] | None = None,
    stand: str | None = None,
    p_throws: str | None = None,
    flags: bool = True,
) -> pd.DataFrame:
    where, params = [], []
    for col, value in (
        ("p.pitcher_id", pitcher_id), ("p.batter_id", batter_id),
        ("p.pitcher_team", pitcher_team), ("p.batter_team", batter_team),
        ("p.stand", stand), ("p.p_throws", p_throws),
    ):
        if value:
            where.append(f"{col} = ?")
            params.append(value)
    if date_from:
        where.append("p.game_date >= ?")
        params.append(str(date_from))
    if date_to:
        where.append("p.game_date <= ?")
        params.append(str(date_to))
    if pitch_types:
        where.append(f"p.pitch_type IN ({', '.join('?' for _ in pitch_types)})")
        params.extend(pitch_types)
    sql = f"""
        SELECT p.*, pp.name AS pitcher_name, bp.name AS batter_name
        FROM pitches p
        LEFT JOIN players pp ON pp.player_id = p.pitcher_id
        LEFT JOIN players bp ON bp.player_id = p.batter_id
        {"WHERE " + " AND ".join(where) if where else ""}
        ORDER BY p.game_date, p.game_id, p.pa_seq, p.pitch_num
    """
    df = con.execute(sql, params).df()
    return add_flags(df) if flags and len(df) else df


def list_teams(con: duckdb.DuckDBPyConnection) -> list[str]:
    rows = con.execute(
        "SELECT DISTINCT team FROM (SELECT pitcher_team AS team FROM pitches UNION SELECT batter_team FROM pitches) "
        "WHERE team IS NOT NULL ORDER BY team"
    ).fetchall()
    return [r[0] for r in rows]


def list_players(con: duckdb.DuckDBPyConnection, team: str | None = None) -> pd.DataFrame:
    """선수 목록과 투수/타자로서의 투구 수."""
    sql = """
        SELECT pl.player_id, pl.name, pl.team, pl.throws, pl.bats,
               coalesce(pt.n, 0) AS pitches_thrown,
               coalesce(bt.n, 0) AS pitches_seen
        FROM players pl
        LEFT JOIN (SELECT pitcher_id, count(*) n FROM pitches GROUP BY 1) pt ON pt.pitcher_id = pl.player_id
        LEFT JOIN (SELECT batter_id, count(*) n FROM pitches GROUP BY 1) bt ON bt.batter_id = pl.player_id
        {where}
        ORDER BY pl.team, pl.name
    """
    if team:
        return con.execute(sql.format(where="WHERE pl.team = ?"), [team]).df()
    return con.execute(sql.format(where="")).df()


def get_player(con: duckdb.DuckDBPyConnection, player_id: str) -> dict | None:
    row = con.execute(
        "SELECT player_id, name, team, throws, bats FROM players WHERE player_id = ?", [player_id]
    ).fetchone()
    if not row:
        return None
    return dict(zip(["player_id", "name", "team", "throws", "bats"], row))


def date_range(con: duckdb.DuckDBPyConnection) -> tuple[date | None, date | None]:
    return con.execute("SELECT min(game_date), max(game_date) FROM pitches").fetchone()
