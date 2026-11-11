"""투구 CSV 적재: 컬럼 매핑 → 단위 변환 → 검증 → 선수 ID 통합 → 저장.

장비·리그마다 컬럼 이름과 단위가 다르므로, 매핑 파일(JSON)로 표준 컬럼에 맞춘다.

매핑 파일 예시::

    {
      "source": "trackman",
      "columns": {"RelSpeed": "release_speed", "SpinRate": "spin_rate"},
      "units": {"release_speed": "mph", "plate_x": "ft"},
      "values": {"description": {"StrikeSwinging": "swinging_strike"}}
    }
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

REQUIRED = ["game_id", "pa_seq", "pitch_num", "pitcher_id", "batter_id", "pitch_type", "description"]

PITCH_COLUMNS = [
    "game_id", "game_date", "inning", "top_bottom", "pa_seq", "pitch_num",
    "pitcher_id", "pitcher_team", "p_throws", "batter_id", "batter_team", "stand",
    "balls", "strikes", "outs", "on_1b", "on_2b", "on_3b",
    "pitch_type", "release_speed", "spin_rate", "pfx_x", "pfx_z", "plate_x", "plate_z",
    "release_x", "release_z", "extension", "description", "pa_result",
    "launch_speed", "launch_angle", "spray_angle", "video_url", "video_ts",
]

# 표준 단위로 바꾸는 배율 (속도 km/h, 거리 cm)
UNIT_FACTORS = {
    "mph": 1.609344,
    "kmh": 1.0,
    "ft": 30.48,
    "in": 2.54,
    "m": 100.0,
    "cm": 1.0,
}

# 범위를 벗어나면 측정 오류로 보고 값을 비운다 (행은 유지)
VALID_RANGES = {
    "release_speed": (60, 175),
    "spin_rate": (0, 4000),
    "plate_x": (-150, 150),
    "plate_z": (-50, 250),
    "pfx_x": (-90, 90),
    "pfx_z": (-90, 90),
    "launch_speed": (0, 200),
    "launch_angle": (-90, 90),
    "spray_angle": (-90, 90),
}

DESCRIPTIONS = {
    "ball", "blocked_ball", "called_strike", "swinging_strike", "swinging_strike_blocked",
    "foul", "foul_tip", "foul_bunt", "missed_bunt", "in_play", "hit_by_pitch", "pitchout",
}


@dataclass
class IngestResult:
    rows_read: int = 0
    rows_loaded: int = 0
    rejected: list[tuple[int, str]] = field(default_factory=list)  # (원본 행 번호, 사유)
    warnings: list[str] = field(default_factory=list)
    new_players: int = 0

    @property
    def rows_rejected(self) -> int:
        return len(self.rejected)

    def summary(self) -> str:
        lines = [
            f"읽은 행 {self.rows_read} · 적재 {self.rows_loaded} · 거부 {self.rows_rejected} · 신규 선수 {self.new_players}",
        ]
        for row, reason in self.rejected[:10]:
            lines.append(f"  거부 {row}행: {reason}")
        if self.rows_rejected > 10:
            lines.append(f"  … 외 {self.rows_rejected - 10}행")
        lines.extend(f"  경고: {w}" for w in self.warnings)
        return "\n".join(lines)


def load_mapping(path: str | Path | None) -> dict:
    if not path:
        return {}
    return json.loads(Path(path).read_text(encoding="utf-8"))


def normalize(df: pd.DataFrame, mapping: dict | None = None) -> tuple[pd.DataFrame, list[str]]:
    """컬럼 이름·단위를 표준으로 맞추고, 범위를 벗어난 값을 비운다."""
    mapping = mapping or {}
    warnings: list[str] = []
    df = df.rename(columns=mapping.get("columns", {})).copy()

    # 값 코드 변환 (예: "StrikeSwinging" → "swinging_strike")
    for col, table in mapping.get("values", {}).items():
        if col in df.columns:
            df[col] = df[col].map(lambda v, t=table: t.get(v, t.get(str(v), v)) if pd.notna(v) else v)

    # 타석 번호가 없으면 경기별로 '타석 내 투구 번호 = 1' 이 나올 때마다 새 타석으로 센다
    if "pa_seq" not in df.columns and {"game_id", "pitch_num"} <= set(df.columns):
        starts = pd.to_numeric(df["pitch_num"], errors="coerce") == 1
        df["pa_seq"] = starts.groupby(df["game_id"]).cumsum()
        warnings.append("pa_seq 컬럼이 없어 파일 순서대로 타석 번호를 만들었습니다")

    for col, unit in mapping.get("units", {}).items():
        if col in df.columns:
            factor = UNIT_FACTORS.get(unit)
            if factor is None:
                raise ValueError(f"알 수 없는 단위: {unit} ({col})")
            df[col] = pd.to_numeric(df[col], errors="coerce") * factor

    for col, (lo, hi) in VALID_RANGES.items():
        if col in df.columns:
            values = pd.to_numeric(df[col], errors="coerce")
            bad = values.notna() & ((values < lo) | (values > hi))
            if bad.any():
                warnings.append(f"{col} 범위({lo}~{hi}) 밖 값 {int(bad.sum())}개를 비웠습니다")
            df[col] = values.where(~bad)

    if "description" in df.columns:
        df["description"] = df["description"].astype("string").str.strip().str.lower()
    if "pitch_type" in df.columns:
        df["pitch_type"] = df["pitch_type"].astype("string").str.strip().str.upper()
    for col in ("p_throws", "stand"):
        if col in df.columns:
            df[col] = df[col].astype("string").str.strip().str.upper().str[:1]
    return df, warnings


def validate(df: pd.DataFrame) -> tuple[pd.DataFrame, list[tuple[int, str]]]:
    """필수값이 없거나 투구 결과 코드가 잘못된 행을 걸러낸다. 행 번호는 CSV 기준(헤더=1)."""
    missing_cols = [c for c in REQUIRED if c not in df.columns]
    if missing_cols:
        raise ValueError(f"필수 컬럼이 없습니다: {', '.join(missing_cols)}")

    reasons = pd.Series("", index=df.index, dtype="object")
    for col in REQUIRED:
        empty = df[col].isna() | (df[col].astype("string").str.strip() == "")
        reasons[empty & (reasons == "")] = f"{col} 값 없음"
    bad_desc = ~df["description"].isin(DESCRIPTIONS) & (reasons == "")
    reasons[bad_desc] = "알 수 없는 투구 결과: " + df.loc[bad_desc, "description"].astype(str)

    rejected_mask = reasons != ""
    rejected = [(int(i) + 2, reasons[i]) for i in df.index[rejected_mask]]
    return df[~rejected_mask].copy(), rejected


class PlayerResolver:
    """소스별 선수 ID를 내부 ID로 바꾼다. 매핑 → 이름+팀 → 신규 생성 순으로 찾는다."""

    def __init__(self, con: duckdb.DuckDBPyConnection, source: str):
        self.con = con
        self.source = source
        self.map = {
            sid: pid
            for sid, pid in con.execute(
                "SELECT source_id, player_id FROM player_id_map WHERE source = ?", [source]
            ).fetchall()
        }
        self.by_name = {
            (name, team): pid
            for pid, name, team in con.execute("SELECT player_id, name, team FROM players").fetchall()
        }
        self.next_num = con.execute("SELECT count(*) FROM players").fetchone()[0] + 1
        self.created = 0

    def resolve(self, source_id: str, name: str | None, team: str | None) -> str:
        source_id = str(source_id)
        if source_id in self.map:
            return self.map[source_id]
        pid = self.by_name.get((name, team)) if name else None
        if pid is None:
            pid = f"P{self.next_num:06d}"
            self.next_num += 1
            self.created += 1
            self.con.execute(
                "INSERT INTO players (player_id, name, team) VALUES (?, ?, ?)",
                [pid, name or source_id, team],
            )
            if name:
                self.by_name[(name, team)] = pid
        self.con.execute(
            "INSERT OR REPLACE INTO player_id_map VALUES (?, ?, ?)", [self.source, source_id, pid]
        )
        self.map[source_id] = pid
        return pid


def _opt(row: pd.Series, col: str):
    if col not in row.index:
        return None
    value = row[col]
    return None if pd.isna(value) else value


def ingest_dataframe(
    con: duckdb.DuckDBPyConnection,
    df: pd.DataFrame,
    source: str = "default",
    mapping: dict | None = None,
    file_label: str = "",
) -> IngestResult:
    result = IngestResult(rows_read=len(df))
    df, warnings = normalize(df, mapping)
    result.warnings.extend(warnings)
    df, rejected = validate(df)
    result.rejected.extend(rejected)
    if df.empty:
        _log(con, source, file_label, result)
        return result

    resolver = PlayerResolver(con, source)

    # 선수 ID 통합 (투수/타자 각각 소스 ID → 내부 ID)
    pitcher_keys = df[["pitcher_id"] + [c for c in ("pitcher_name", "pitcher_team") if c in df]].drop_duplicates("pitcher_id")
    batter_keys = df[["batter_id"] + [c for c in ("batter_name", "batter_team") if c in df]].drop_duplicates("batter_id")
    pmap = {
        str(r.pitcher_id): resolver.resolve(r.pitcher_id, _opt(r, "pitcher_name"), _opt(r, "pitcher_team"))
        for _, r in pitcher_keys.iterrows()
    }
    bmap = {
        str(r.batter_id): resolver.resolve(r.batter_id, _opt(r, "batter_name"), _opt(r, "batter_team"))
        for _, r in batter_keys.iterrows()
    }
    df["pitcher_id"] = df["pitcher_id"].astype(str).map(pmap)
    df["batter_id"] = df["batter_id"].astype(str).map(bmap)
    result.new_players = resolver.created

    _update_handedness(con, df)
    _upsert_games(con, df)

    out = pd.DataFrame({c: df[c] if c in df.columns else None for c in PITCH_COLUMNS})
    out["game_id"] = out["game_id"].astype(str)
    out["pa_seq"] = pd.to_numeric(out["pa_seq"]).astype(int)
    out["pitch_num"] = pd.to_numeric(out["pitch_num"]).astype(int)
    if out["game_date"].notna().any():
        out["game_date"] = pd.to_datetime(out["game_date"]).dt.date
    for col in ("on_1b", "on_2b", "on_3b"):
        out[col] = out[col].map(_to_bool)
    out["pa_result"] = out["pa_result"].where(out["pa_result"].notna() & (out["pa_result"].astype(str) != ""), None)
    out.insert(0, "pitch_uid", out["game_id"] + "-" + out["pa_seq"].astype(str) + "-" + out["pitch_num"].astype(str))
    out["source"] = source

    dup = out["pitch_uid"].duplicated(keep="last")
    if dup.any():
        result.warnings.append(f"같은 파일 안 중복 투구 {int(dup.sum())}개는 마지막 값만 사용했습니다")
        out = out[~dup]

    con.register("incoming", out)
    cols = ", ".join(out.columns)
    con.execute(f"INSERT OR REPLACE INTO pitches ({cols}) SELECT {cols} FROM incoming")
    con.unregister("incoming")
    result.rows_loaded = len(out)
    _log(con, source, file_label, result)
    return result


def ingest_csv(
    con: duckdb.DuckDBPyConnection,
    path: str | Path,
    source: str | None = None,
    mapping_path: str | Path | None = None,
) -> IngestResult:
    mapping = load_mapping(mapping_path)
    source = source or mapping.get("source") or "default"
    df = pd.read_csv(path, dtype={"game_id": str, "pitcher_id": str, "batter_id": str})
    return ingest_dataframe(con, df, source=source, mapping=mapping, file_label=str(path))


def _to_bool(value) -> bool | None:
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return None
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "t", "y", "yes"}
    return bool(value)


def _update_handedness(con: duckdb.DuckDBPyConnection, df: pd.DataFrame) -> None:
    if "p_throws" in df:
        for pid, hand in df[["pitcher_id", "p_throws"]].dropna().drop_duplicates("pitcher_id").itertuples(index=False):
            con.execute("UPDATE players SET throws = ? WHERE player_id = ? AND throws IS NULL", [hand, pid])
    if "stand" in df:
        for pid, hands in df[["batter_id", "stand"]].dropna().groupby("batter_id")["stand"]:
            seen = set(hands.unique())
            current = con.execute("SELECT bats FROM players WHERE player_id = ?", [pid]).fetchone()[0]
            if current:
                seen.add(current)
            bats = "S" if len(seen - {"S"}) > 1 or "S" in seen else seen.pop()
            con.execute("UPDATE players SET bats = ? WHERE player_id = ?", [bats, pid])


def _upsert_games(con: duckdb.DuckDBPyConnection, df: pd.DataFrame) -> None:
    cols = [c for c in ("game_id", "game_date", "venue", "home_team", "away_team") if c in df.columns]
    games = df[cols].drop_duplicates("game_id")
    for _, g in games.iterrows():
        date = _opt(g, "game_date")
        con.execute(
            "INSERT OR REPLACE INTO games VALUES (?, ?, ?, ?, ?)",
            [
                str(g["game_id"]),
                pd.to_datetime(date).date() if date is not None else None,
                _opt(g, "venue"),
                _opt(g, "home_team"),
                _opt(g, "away_team"),
            ],
        )


def _log(con, source: str, file_label: str, result: IngestResult) -> None:
    con.execute(
        "INSERT INTO ingest_log (source, file, rows_read, rows_loaded, rows_rejected) VALUES (?, ?, ?, ?, ?)",
        [source, file_label, result.rows_read, result.rows_loaded, result.rows_rejected],
    )
