"""투수·타자 지표 계산.

모든 함수는 투구 단위 DataFrame(pitches 테이블 형식)을 받는다.
표본이 작은 비율 지표에는 Wilson 95% 신뢰구간을 함께 돌려준다.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

ZONE_X = 25.0            # cm, 스트라이크존 좌우 절반 폭 (공 반지름 포함)
ZONE_Z = (45.0, 105.0)   # cm, 존 하단/상단 (MVP: 타자 키 보정 없이 고정값)
HARD_HIT_KMH = 153.0     # 95 mph

# 리그 평균에 가까운 wOBA 가중치 (리그·시즌별 값으로 바꿔 쓸 수 있음)
WOBA_WEIGHTS = {
    "walk": 0.69, "hit_by_pitch": 0.72, "single": 0.89,
    "double": 1.27, "triple": 1.62, "home_run": 2.10,
}

SWING = {"swinging_strike", "swinging_strike_blocked", "foul", "foul_tip", "foul_bunt", "missed_bunt", "in_play"}
WHIFF = {"swinging_strike", "swinging_strike_blocked", "missed_bunt"}
HITS = {"single", "double", "triple", "home_run"}
TOTAL_BASES = {"single": 1, "double": 2, "triple": 3, "home_run": 4}
NOT_AB = {"walk", "intent_walk", "hit_by_pitch", "sac_fly", "sac_bunt", "catcher_interf"}
STRIKEOUTS = {"strikeout", "strikeout_double_play"}
WALKS = {"walk", "intent_walk"}

NUMERIC_COLUMNS = [
    "balls", "strikes", "release_speed", "spin_rate", "pfx_x", "pfx_z", "plate_x", "plate_z",
    "launch_speed", "launch_angle", "spray_angle",
]

PITCH_NAMES = {
    "FF": "포심", "SI": "투심/싱커", "FC": "커터", "SL": "슬라이더", "ST": "스위퍼",
    "CU": "커브", "CH": "체인지업", "FS": "스플리터", "KN": "너클볼",
}

COUNT_BUCKETS = ["초구", "투수 유리", "타자 유리", "동일", "2스트라이크"]

# 5x5 격자: 가운데 3x3 이 스트라이크존, 바깥 한 칸은 존 밖 (멀리 빠진 공도 바깥 칸에 포함)
GRID_X = np.array([-np.inf, -25.0, -25 / 3, 25 / 3, 25.0, np.inf])
GRID_Z = np.array([-np.inf, 45.0, 65.0, 85.0, 105.0, np.inf])


def pitch_name(code: str) -> str:
    return PITCH_NAMES.get(code, code)


def wilson(k: float, n: float, z: float = 1.96) -> tuple[float, float]:
    """비율 k/n 의 Wilson 신뢰구간. n=0 이면 (nan, nan)."""
    if n <= 0:
        return (math.nan, math.nan)
    p = k / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, center - half), min(1.0, center + half))


def rate(k: float, n: float) -> dict:
    lo, hi = wilson(k, n)
    return {"value": (k / n) if n else math.nan, "n": int(n), "lo": lo, "hi": hi}


def count_bucket(balls: int, strikes: int) -> str:
    if balls == 0 and strikes == 0:
        return "초구"
    if strikes == 2:
        return "2스트라이크"
    if strikes > balls:
        return "투수 유리"
    if balls > strikes:
        return "타자 유리"
    return "동일"


def add_flags(df: pd.DataFrame) -> pd.DataFrame:
    """지표 계산에 쓰는 파생 컬럼을 붙인다."""
    d = df.copy()
    for col in NUMERIC_COLUMNS:
        if col in d.columns:
            d[col] = pd.to_numeric(d[col], errors="coerce")
    desc = d["description"].astype(str)
    res = d["pa_result"].where(d["pa_result"].notna(), None)
    d["is_swing"] = desc.isin(SWING)
    d["is_whiff"] = desc.isin(WHIFF)
    d["is_in_play"] = desc == "in_play"
    has_loc = d["plate_x"].notna() & d["plate_z"].notna()
    d["has_loc"] = has_loc
    d["in_zone"] = has_loc & (d["plate_x"].abs() <= ZONE_X) & d["plate_z"].between(*ZONE_Z)
    d["out_zone"] = has_loc & ~d["in_zone"]
    d["is_pa_end"] = res.notna()
    d["is_ab"] = d["is_pa_end"] & ~res.isin(NOT_AB)
    d["is_hit"] = res.isin(HITS)
    d["is_k"] = res.isin(STRIKEOUTS)
    d["is_bb"] = res.isin(WALKS)
    d["is_hbp"] = res == "hit_by_pitch"
    d["total_bases"] = res.map(TOTAL_BASES).fillna(0)
    d["woba_value"] = res.map(WOBA_WEIGHTS).fillna(0.0)
    d["woba_denom"] = d["is_pa_end"] & ~res.isin({"intent_walk", "sac_bunt"})
    d["count_bucket"] = [count_bucket(b, s) for b, s in zip(d["balls"].fillna(0), d["strikes"].fillna(0))]
    d["two_strike"] = d["strikes"].fillna(0) >= 2
    d["hard_hit"] = d["launch_speed"] >= HARD_HIT_KMH
    d["batted_type"] = pd.cut(
        d["launch_angle"], bins=[-90, 10, 25, 50, 90], labels=["땅볼", "라인드라이브", "뜬공", "팝업"], include_lowest=True
    ).astype("object")
    d.loc[~d["is_in_play"], "batted_type"] = None
    return d


def _ratio(num: pd.Series, den: pd.Series) -> float:
    n = den.sum()
    return float(num.sum() / n) if n else math.nan


def discipline(d: pd.DataFrame) -> dict:
    """스윙·헛스윙·존 관련 비율. (헛스윙% = 헛스윙 / 스윙)"""
    swings = d["is_swing"].sum()
    return {
        "pitches": int(len(d)),
        "zone": rate(d["in_zone"].sum(), d["has_loc"].sum()),
        "swing": rate(swings, len(d)),
        "z_swing": rate((d["is_swing"] & d["in_zone"]).sum(), d["in_zone"].sum()),
        "chase": rate((d["is_swing"] & d["out_zone"]).sum(), d["out_zone"].sum()),
        "whiff": rate(d["is_whiff"].sum(), swings),
        "z_contact": rate((d["is_swing"] & d["in_zone"] & ~d["is_whiff"]).sum(), (d["is_swing"] & d["in_zone"]).sum()),
        "csw": rate((d["is_whiff"] | (d["description"] == "called_strike")).sum(), len(d)),
    }


def slash_line(d: pd.DataFrame) -> dict:
    """타석 결과 기반 기록 (타자 기준이든 투수 피안타 기준이든 동일하게 계산)."""
    pa = d[d["is_pa_end"]]
    n_pa = len(pa)
    ab = int(pa["is_ab"].sum())
    hits = int(pa["is_hit"].sum())
    on_base_den = ab + int(pa["is_bb"].sum()) + int(pa["is_hbp"].sum()) + int((pa["pa_result"] == "sac_fly").sum())
    woba_den = int(pa["woba_denom"].sum())
    return {
        "pa": n_pa,
        "ab": ab,
        "h": hits,
        "hr": int((pa["pa_result"] == "home_run").sum()),
        "avg": hits / ab if ab else math.nan,
        "obp": (hits + pa["is_bb"].sum() + pa["is_hbp"].sum()) / on_base_den if on_base_den else math.nan,
        "slg": pa["total_bases"].sum() / ab if ab else math.nan,
        "woba": pa["woba_value"].sum() / woba_den if woba_den else math.nan,
        "k": rate(pa["is_k"].sum(), n_pa),
        "bb": rate(pa["is_bb"].sum(), n_pa),
    }


def batted_ball(d: pd.DataFrame) -> dict:
    bip = d[d["is_in_play"] & d["launch_speed"].notna()]
    n = len(bip)
    out = {
        "n": n,
        "ev": float(bip["launch_speed"].mean()) if n else math.nan,
        "ev_max": float(bip["launch_speed"].max()) if n else math.nan,
        "la": float(bip["launch_angle"].mean()) if n else math.nan,
        "hard_hit": rate(bip["hard_hit"].sum(), n),
        "types": {t: rate((bip["batted_type"] == t).sum(), n) for t in ["땅볼", "라인드라이브", "뜬공", "팝업"]},
    }
    spray = bip[bip["spray_angle"].notna()]
    if len(spray):
        # 당겨친 방향: 우타 = 좌측(음수), 좌타 = 우측(양수)
        sign = np.where(spray["stand"] == "L", 1, -1)
        directed = spray["spray_angle"] * sign
        out["pull"] = rate((directed > 15).sum(), len(spray))
        out["center"] = rate(directed.between(-15, 15).sum(), len(spray))
        out["oppo"] = rate((directed < -15).sum(), len(spray))
    return out


def by_pitch_type(d: pd.DataFrame, min_pitches: int = 1) -> list[dict]:
    """구종별 표: 비율, 구속·회전·무브먼트, 헛스윙·존·체이스, 결정구 비율, 피wOBA."""
    total = len(d)
    rows = []
    for ptype, g in d.groupby("pitch_type"):
        if len(g) < min_pitches:
            continue
        disc = discipline(g)
        two = g[g["two_strike"]]
        pa_end = g[g["is_pa_end"]]
        rows.append({
            "pitch_type": ptype,
            "name": pitch_name(ptype),
            "n": int(len(g)),
            "usage": len(g) / total if total else math.nan,
            "usage_vs_l": _share(d, g, "L"),
            "usage_vs_r": _share(d, g, "R"),
            "velo": float(g["release_speed"].mean()),
            "velo_max": float(g["release_speed"].max()),
            "spin": float(g["spin_rate"].mean()),
            "pfx_x": float(g["pfx_x"].mean()),
            "pfx_z": float(g["pfx_z"].mean()),
            "whiff": disc["whiff"],
            "zone": disc["zone"],
            "chase": disc["chase"],
            "csw": disc["csw"],
            "putaway": rate(two["is_k"].sum(), len(two)),
            "woba": (pa_end["woba_value"].sum() / pa_end["woba_denom"].sum()) if pa_end["woba_denom"].sum() else math.nan,
            "woba_n": int(pa_end["woba_denom"].sum()),
            "ev": float(g.loc[g["is_in_play"], "launch_speed"].mean()) if g["is_in_play"].any() else math.nan,
        })
    rows.sort(key=lambda r: -r["n"])
    return rows


def _share(d: pd.DataFrame, g: pd.DataFrame, stand: str) -> float:
    base = (d["stand"] == stand).sum()
    return float((g["stand"] == stand).sum() / base) if base else math.nan


def count_usage(d: pd.DataFrame) -> list[dict]:
    """볼카운트 상황별 구종 비율 (행 = 구종, 열 = 상황)."""
    table = pd.crosstab(d["pitch_type"], d["count_bucket"], normalize="columns")
    counts = d["count_bucket"].value_counts()
    order = d["pitch_type"].value_counts().index
    rows = []
    for ptype in order:
        rows.append({
            "pitch_type": ptype,
            "name": pitch_name(ptype),
            "cells": [float(table.at[ptype, b]) if b in table.columns else math.nan for b in COUNT_BUCKETS],
        })
    return {"buckets": COUNT_BUCKETS, "n": [int(counts.get(b, 0)) for b in COUNT_BUCKETS], "rows": rows}


def zone_grid(d: pd.DataFrame, value: str = "freq") -> dict:
    """5x5 격자 집계. value: freq(투구 분포) / swing / whiff / woba.

    반환: cells[row][col] = {"v": 값, "n": 표본}. row 0 = 위쪽, col 0 = 포수 시점 왼쪽(3루 쪽).
    """
    loc = d[d["has_loc"]]
    xi = np.clip(np.searchsorted(GRID_X, loc["plate_x"].to_numpy(), side="right") - 1, 0, 4)
    zi = np.clip(np.searchsorted(GRID_Z, loc["plate_z"].to_numpy(), side="right") - 1, 0, 4)
    loc = loc.assign(col=xi, row=4 - zi)
    cells = [[{"v": math.nan, "n": 0} for _ in range(5)] for _ in range(5)]
    total = len(loc)
    for (r, c), g in loc.groupby(["row", "col"]):
        if value == "freq":
            v, n = len(g) / total, len(g)
        elif value == "swing":
            v, n = g["is_swing"].mean(), len(g)
        elif value == "whiff":
            n = int(g["is_swing"].sum())
            v = g["is_whiff"].sum() / n if n else math.nan
        elif value == "woba":
            n = int(g["woba_denom"].sum())
            v = g["woba_value"].sum() / n if n else math.nan
        else:
            raise ValueError(value)
        cells[int(r)][int(c)] = {"v": float(v), "n": int(n)}
    return {"value": value, "cells": cells, "total": total}


def league_baseline(d: pd.DataFrame) -> dict:
    """비교 기준: 전체 데이터의 구종별 헛스윙%·피wOBA 와 전체 체이스%."""
    base = {}
    for ptype, g in d.groupby("pitch_type"):
        sw = g["is_swing"].sum()
        den = g["woba_denom"].sum()
        base[ptype] = {
            "whiff": g["is_whiff"].sum() / sw if sw else math.nan,
            "woba": g["woba_value"].sum() / den if den else math.nan,
        }
    disc = discipline(d)
    line = slash_line(d)
    return {
        "pitch": base,
        "chase": disc["chase"]["value"],
        "whiff": disc["whiff"]["value"],
        "k": line["k"]["value"],
        "woba": line["woba"],
    }


# ---------------------------------------------------------------- 요약 묶음

def pitcher_profile(d: pd.DataFrame) -> dict:
    """한 투수의 투구 데이터(add_flags 적용)를 받아 리포트용 요약을 만든다."""
    return {
        "pitches": int(len(d)),
        "games": int(d["game_id"].nunique()),
        "line": slash_line(d),
        "discipline": discipline(d),
        "batted": batted_ball(d),
        "arsenal": by_pitch_type(d),
        "count_usage": count_usage(d),
        "vs_hand": {h: slash_line(d[d["stand"] == h]) for h in ("L", "R")},
    }


def batter_profile(d: pd.DataFrame) -> dict:
    stands = set(d["stand"].dropna().unique())
    return {
        "stand": stands.pop() if len(stands) == 1 else ("S" if stands else None),
        "pitches": int(len(d)),
        "games": int(d["game_id"].nunique()),
        "line": slash_line(d),
        "discipline": discipline(d),
        "batted": batted_ball(d),
        "vs_pitch": by_pitch_type(d),
        "vs_hand": {h: slash_line(d[d["p_throws"] == h]) for h in ("L", "R")},
        "zone_whiff": zone_grid(d, "whiff"),
        "zone_woba": zone_grid(d, "woba"),
    }


# ---------------------------------------------------------------- 자동 코멘트

def _significant_high(k: float, n: int, base: float, min_n: int) -> bool:
    """표본이 충분하고, 신뢰구간 하한이 기준보다 높을 때만 '뚜렷하다'고 본다."""
    if n < min_n or not np.isfinite(base):
        return False
    lo, _ = wilson(k, n)
    return lo > base


def batter_notes(profile: dict, baseline: dict, min_swings: int = 15) -> list[str]:
    notes = []
    for row in profile["vs_pitch"]:
        w = row["whiff"]
        base = baseline["pitch"].get(row["pitch_type"], {}).get("whiff", math.nan)
        if _significant_high(w["value"] * w["n"], w["n"], base, min_swings):
            notes.append(
                f"{row['name']}에 헛스윙 {w['value']:.0%} (리그 {base:.0%}, 스윙 {w['n']}회) — 결정구로 활용"
            )
    chase = profile["discipline"]["chase"]
    if _significant_high(chase["value"] * chase["n"], chase["n"], baseline["chase"], 40):
        notes.append(f"존 밖 공에 자주 배트가 나옴: 체이스 {chase['value']:.0%} (리그 {baseline['chase']:.0%})")
    weak_cell = _worst_zone_cell(profile["zone_whiff"], profile.get("stand"))
    if weak_cell:
        notes.append(weak_cell)
    hand = profile["vs_hand"]
    l, r = hand["L"], hand["R"]
    if l["pa"] >= 20 and r["pa"] >= 20 and np.isfinite(l["woba"]) and np.isfinite(r["woba"]):
        gap = l["woba"] - r["woba"]
        if abs(gap) >= 0.060:
            weak_side = "우투수" if gap > 0 else "좌투수"
            notes.append(f"{weak_side} 상대로 약함 (wOBA 좌투 {l['woba']:.3f} / 우투 {r['woba']:.3f})")
    bb = profile["batted"]
    if bb.get("pull") and bb["pull"]["n"] >= 20 and bb["pull"]["value"] >= 0.5:
        notes.append(f"당겨치는 타구 {bb['pull']['value']:.0%} — 당겨치는 방향 수비 시프트 검토")
    return notes


def _worst_zone_cell(grid: dict, stand: str | None, min_swings: int = 12) -> str | None:
    """존 안 3x3 칸 중 헛스윙%가 가장 높은 칸 (표본 충분할 때)."""
    best = None
    for r in range(1, 4):
        for c in range(1, 4):
            cell = grid["cells"][r][c]
            if cell["n"] >= min_swings and np.isfinite(cell["v"]) and cell["v"] >= 0.30:
                if best is None or cell["v"] > best[0]:
                    best = (cell["v"], cell["n"], r, c)
    if not best:
        return None
    v, n, r, c = best
    return f"{zone_label(r, c, stand)} 코스 헛스윙 {v:.0%} (스윙 {n}회)"


def zone_label(r: int, c: int, stand: str | None) -> str:
    """격자 칸 이름. 포수 시점 왼쪽(3루 쪽)은 우타자에게 몸쪽, 좌타자에게 바깥쪽."""
    vertical = {1: "높은", 2: "가운데 높이", 3: "낮은"}[r]
    if stand == "R":
        horizontal = {1: "몸쪽", 2: "가운데", 3: "바깥쪽"}[c]
    elif stand == "L":
        horizontal = {1: "바깥쪽", 2: "가운데", 3: "몸쪽"}[c]
    else:
        horizontal = {1: "3루 쪽", 2: "가운데", 3: "1루 쪽"}[c]
    return f"{vertical} {horizontal}"


def pitcher_notes(profile: dict, baseline: dict) -> list[str]:
    notes = []
    arsenal = profile["arsenal"]
    if arsenal:
        main = arsenal[0]
        notes.append(f"주무기 {main['name']} {main['usage']:.0%}, 평균 {main['velo']:.0f}km/h (최고 {main['velo_max']:.0f})")
    for row in arsenal:
        w = row["whiff"]
        base = baseline["pitch"].get(row["pitch_type"], {}).get("whiff", math.nan)
        if _significant_high(w["value"] * w["n"], w["n"], base, 20):
            notes.append(f"{row['name']} 헛스윙 {w['value']:.0%} (리그 {base:.0%}) — 2스트라이크 이후 주의")
    for row in arsenal:
        l, r = row["usage_vs_l"], row["usage_vs_r"]
        if np.isfinite(l) and np.isfinite(r) and row["n"] >= 30 and abs(l - r) >= 0.15:
            side, other = ("좌타자", "우타자") if l > r else ("우타자", "좌타자")
            notes.append(f"{row['name']}는 {side}에게 {max(l, r):.0%}, {other}에게 {min(l, r):.0%}")
    usage = profile["count_usage"]
    try:
        i_two = usage["buckets"].index("2스트라이크")
        i_behind = usage["buckets"].index("타자 유리")
    except ValueError:
        return notes
    if usage["n"][i_two] >= 30:
        top = max(usage["rows"], key=lambda r: r["cells"][i_two] if np.isfinite(r["cells"][i_two]) else -1)
        notes.append(f"2스트라이크 결정구: {top['name']} {top['cells'][i_two]:.0%}")
    if usage["n"][i_behind] >= 30:
        top = max(usage["rows"], key=lambda r: r["cells"][i_behind] if np.isfinite(r["cells"][i_behind]) else -1)
        notes.append(f"카운트가 불리하면 {top['name']} 비중 {top['cells'][i_behind]:.0%} — 노려칠 공")
    return notes
