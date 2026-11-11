"""DuckDB 저장소: 스키마 생성과 연결 관리.

분석의 최소 단위는 투구(pitch) 1개다. 선수는 소스마다 ID가 달라서
player_id_map 으로 내부 ID에 묶는다.
"""

from __future__ import annotations

from pathlib import Path

import duckdb

DEFAULT_DB_PATH = Path("dugoutlab.duckdb")

SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS teams (
        team_id VARCHAR PRIMARY KEY,
        name    VARCHAR NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS players (
        player_id VARCHAR PRIMARY KEY,
        name      VARCHAR NOT NULL,
        team      VARCHAR,
        throws    VARCHAR,   -- R / L
        bats      VARCHAR    -- R / L / S
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS player_id_map (
        source    VARCHAR NOT NULL,
        source_id VARCHAR NOT NULL,
        player_id VARCHAR NOT NULL,
        PRIMARY KEY (source, source_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS games (
        game_id   VARCHAR PRIMARY KEY,
        game_date DATE,
        venue     VARCHAR,
        home_team VARCHAR,
        away_team VARCHAR
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS pitches (
        pitch_uid     VARCHAR PRIMARY KEY,  -- game_id-pa_seq-pitch_num
        game_id       VARCHAR NOT NULL,
        game_date     DATE,
        inning        INTEGER,
        top_bottom    VARCHAR,
        pa_seq        INTEGER NOT NULL,
        pitch_num     INTEGER NOT NULL,
        pitcher_id    VARCHAR NOT NULL,
        pitcher_team  VARCHAR,
        p_throws      VARCHAR,
        batter_id     VARCHAR NOT NULL,
        batter_team   VARCHAR,
        stand         VARCHAR,
        balls         INTEGER,
        strikes       INTEGER,
        outs          INTEGER,
        on_1b         BOOLEAN,
        on_2b         BOOLEAN,
        on_3b         BOOLEAN,
        pitch_type    VARCHAR,
        release_speed DOUBLE,   -- km/h
        spin_rate     DOUBLE,   -- rpm
        pfx_x         DOUBLE,   -- cm, 포수 시점 (+ = 1루 방향)
        pfx_z         DOUBLE,   -- cm
        plate_x       DOUBLE,   -- cm, 홈플레이트 중앙 기준
        plate_z       DOUBLE,   -- cm, 지면 기준
        release_x     DOUBLE,
        release_z     DOUBLE,
        extension     DOUBLE,
        description   VARCHAR,  -- ball, called_strike, swinging_strike, foul, in_play, hit_by_pitch ...
        pa_result     VARCHAR,  -- 타석 마지막 투구에만: single, strikeout, walk ...
        launch_speed  DOUBLE,   -- km/h
        launch_angle  DOUBLE,   -- deg
        spray_angle   DOUBLE,   -- deg, 음수 = 좌측(3루) 방향
        video_url     VARCHAR,
        video_ts      DOUBLE,   -- 영상 내 초
        source        VARCHAR,
        ingested_at   TIMESTAMP DEFAULT current_timestamp
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS ingest_log (
        ingested_at TIMESTAMP DEFAULT current_timestamp,
        source      VARCHAR,
        file        VARCHAR,
        rows_read   INTEGER,
        rows_loaded INTEGER,
        rows_rejected INTEGER
    )
    """,
]


def connect(path: str | Path | None = None, read_only: bool = False) -> duckdb.DuckDBPyConnection:
    """DB에 연결하고 스키마가 없으면 만든다. path=':memory:' 는 테스트용."""
    target = str(path or DEFAULT_DB_PATH)
    con = duckdb.connect(target, read_only=read_only)
    if not read_only:
        for stmt in SCHEMA:
            con.execute(stmt)
    return con


def set_team_name(con: duckdb.DuckDBPyConnection, team_id: str, name: str) -> None:
    con.execute("INSERT OR REPLACE INTO teams VALUES (?, ?)", [team_id, name])


def team_name(con: duckdb.DuckDBPyConnection, team_id: str) -> str:
    row = con.execute("SELECT name FROM teams WHERE team_id = ?", [team_id]).fetchone()
    return row[0] if row else team_id
