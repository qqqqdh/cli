"""가상 리그의 투구 단위 샘플 데이터를 만든다 (실제 데이터 연동 전 시연·테스트용).

팀과 선수는 모두 가상이다. 선수마다 약점(특정 구종에 헛스윙이 많음 등)을 심어 두어,
리포트가 그 약점을 찾아내는지 확인할 수 있게 했다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta

import numpy as np
import pandas as pd

TEAMS = {
    "BLU": "서울 블루윙즈",
    "RED": "부산 레드포트",
    "GRN": "광주 그린필드",
    "GLD": "대전 골드스타",
}

SURNAMES = list("김이박최정강조윤장임한오서신권황안송류홍")
GIVEN = ["민준", "서준", "도윤", "예준", "시우", "하준", "지호", "주원", "지후", "준우",
         "현우", "건우", "우진", "선우", "유찬", "은우", "승현", "태윤", "동현", "재원"]

# 구종별 기본 성질: 구속(km/h), 회전수, 수평/수직 무브먼트(cm, 우투 기준), 높이 목표, 헛스윙 기본값
PITCH_PROFILES = {
    "FF": dict(velo=146, spin=2300, hb=-18, vb=40, z=85, whiff=0.20),
    "SI": dict(velo=143, spin=2150, hb=-35, vb=20, z=65, whiff=0.13),
    "FC": dict(velo=137, spin=2350, hb=5, vb=25, z=75, whiff=0.22),
    "SL": dict(velo=130, spin=2450, hb=20, vb=5, z=60, whiff=0.33),
    "CU": dict(velo=118, spin=2500, hb=18, vb=-30, z=55, whiff=0.30),
    "CH": dict(velo=129, spin=1700, hb=-35, vb=15, z=55, whiff=0.31),
    "FS": dict(velo=131, spin=1300, hb=-20, vb=5, z=50, whiff=0.35),
}

ZONE_X = 25.0          # cm, 스트라이크존 좌우 절반 폭 (공 반지름 포함)
ZONE_Z = (45.0, 105.0)  # cm


@dataclass
class Pitcher:
    pid: str
    name: str
    team: str
    throws: str
    repertoire: dict[str, float]  # 구종 → 기본 비율
    velo_adj: float
    role: str  # SP / RP


@dataclass
class Batter:
    pid: str
    name: str
    team: str
    stand: str
    contact: float      # 1.0 = 평균, 높을수록 헛스윙 적음
    power: float        # 1.0 = 평균
    discipline: float   # 높을수록 존 밖 공에 덜 휘두름
    pull: float         # 당겨치는 경향 (0~1)
    weakness: dict[str, float] = field(default_factory=dict)  # 구종 → 헛스윙 배율
    weak_zone: str = ""  # high / low / away / in


def _name(rng: np.random.Generator, used: set[str]) -> str:
    while True:
        n = rng.choice(SURNAMES) + rng.choice(GIVEN)
        if n not in used:
            used.add(n)
            return n


def build_rosters(rng: np.random.Generator) -> tuple[list[Pitcher], list[Batter]]:
    pitchers, batters, used = [], [], set()
    for t_idx, team in enumerate(TEAMS):
        for i in range(7):
            role = "SP" if i < 4 else "RP"
            throws = "L" if rng.random() < 0.3 else "R"
            primary = rng.choice(["FF", "FF", "SI"])
            options = [p for p in ["SL", "CU", "CH", "FS", "FC"]]
            k = 3 if role == "SP" else 2
            secondaries = list(rng.choice(options, size=k, replace=False))
            weights = rng.dirichlet(np.ones(k) * 2) * 0.55
            rep = {primary: 0.45, **{p: float(w) for p, w in zip(secondaries, weights)}}
            pitchers.append(Pitcher(
                pid=f"{team}-P{i + 1:02d}", name=_name(rng, used), team=team, throws=throws,
                repertoire=rep, velo_adj=float(rng.normal(0, 3)), role=role,
            ))
        for i in range(12):
            stand = rng.choice(["R", "R", "L"])
            weak = rng.choice(list(PITCH_PROFILES))
            batters.append(Batter(
                pid=f"{team}-B{i + 1:02d}", name=_name(rng, used), team=team, stand=str(stand),
                contact=float(rng.normal(1.0, 0.12)), power=float(rng.normal(1.0, 0.08)),
                discipline=float(rng.normal(1.0, 0.15)), pull=float(np.clip(rng.normal(0.42, 0.1), 0.2, 0.7)),
                weakness={str(weak): float(rng.uniform(1.4, 1.9))},
                weak_zone=str(rng.choice(["high", "low", "away", "in"])),
            ))
    return pitchers, batters


def _choose_pitch(rng, p: Pitcher, balls: int, strikes: int, stand: str) -> str:
    types = list(p.repertoire)
    w = np.array([p.repertoire[t] for t in types])
    for i, t in enumerate(types):
        fastball = t in ("FF", "SI")
        if strikes == 2 and not fastball:
            w[i] *= 1.5
        if balls >= 2 and balls > strikes and fastball:
            w[i] *= 1.6
        opposite = stand != p.throws
        if opposite and t in ("CH", "FS"):
            w[i] *= 1.8
        if not opposite and t in ("SL", "FC"):
            w[i] *= 1.5
        if opposite and t == "SL":
            w[i] *= 0.6
    w = w / w.sum()
    return str(rng.choice(types, p=w))


def _in_zone(x: float, z: float) -> bool:
    return abs(x) <= ZONE_X and ZONE_Z[0] <= z <= ZONE_Z[1]


def _zone_penalty(b: Batter, x: float, z: float) -> float:
    """타자의 약한 코스로 오면 헛스윙 배율을 키운다. x는 포수 시점."""
    away = x > 8 if b.stand == "R" else x < -8
    inside = x < -8 if b.stand == "R" else x > 8
    hit = {"high": z > 90, "low": z < 60, "away": away, "in": inside}.get(b.weak_zone, False)
    return 1.45 if hit else 1.0


def _batted_ball(rng, b: Batter, ptype: str, in_zone: bool) -> tuple[float, float, float, str]:
    quality = b.power * (1.0 if in_zone else 0.9) * (0.95 if ptype in ("SL", "CU", "CH", "FS") else 1.0)
    ev = float(np.clip(rng.normal(138 * quality, 16), 50, 185))
    la = float(np.clip(rng.normal(12, 24), -60, 75))
    pull_dir = -1 if b.stand == "R" else 1
    spray = float(np.clip(rng.normal(pull_dir * (b.pull - 0.3) * 60, 22), -45, 45))

    # 타구 속도·발사각으로 안타 확률을 대략 정한다
    if 20 <= la <= 40 and ev >= 150:
        hr_p = min(0.85, (ev - 148) / 25)
    else:
        hr_p = 0.0
    if rng.random() < hr_p:
        return ev, la, spray, "home_run"
    if la < 10:
        hit_p = 0.20 + max(0, ev - 130) / 100
    elif la <= 25:
        hit_p = 0.55 + max(0, ev - 135) / 90
    elif la <= 45:
        hit_p = 0.10 + max(0, ev - 150) / 60
    else:
        hit_p = 0.03
    hit_p = min(hit_p, 0.9)
    if rng.random() < hit_p:
        r = rng.random()
        if la > 8 and ev > 132 and r < 0.45:
            return ev, la, spray, "double" if r > 0.03 else "triple"
        return ev, la, spray, "single"
    return ev, la, spray, "field_out" if rng.random() > 0.04 else "double_play"


def simulate_pa(rng, p: Pitcher, b: Batter) -> list[dict]:
    balls = strikes = 0
    rows = []
    while True:
        ptype = _choose_pitch(rng, p, balls, strikes, b.stand)
        prof = PITCH_PROFILES[ptype]
        hand = 1 if p.throws == "R" else -1
        velo = float(rng.normal(prof["velo"] + p.velo_adj, 1.6))
        spin = float(rng.normal(prof["spin"], 90))
        pfx_x = float(rng.normal(prof["hb"] * hand, 4))
        pfx_z = float(rng.normal(prof["vb"], 4))
        aim_in_zone = rng.random() < (0.55 if balls > strikes else 0.42 if strikes == 2 else 0.5)
        if aim_in_zone:
            x = float(rng.normal(0, 13))
            z = float(rng.normal(prof["z"] + 5, 14))
        else:
            if rng.random() < 0.6:  # 좌우로 빠지는 공
                x = float(rng.choice([-1, 1]) * rng.normal(34, 9))
                z = float(rng.normal(prof["z"], 18))
            else:  # 위아래로 빠지는 공
                x = float(rng.normal(0, 16))
                z = float(prof["z"] + rng.choice([-1, 1]) * abs(rng.normal(42, 10)))
        zone = _in_zone(x, z)

        swing_p = 0.66 if zone else 0.29 / b.discipline
        if strikes == 2:
            swing_p = min(0.95, swing_p + 0.15)
        if balls == 3 and strikes < 2:
            swing_p *= 0.7
        row = dict(pitch_type=ptype, release_speed=round(velo, 1), spin_rate=round(spin),
                   pfx_x=round(pfx_x, 1), pfx_z=round(pfx_z, 1), plate_x=round(x, 1), plate_z=round(z, 1),
                   balls=balls, strikes=strikes, description=None, pa_result=None,
                   launch_speed=None, launch_angle=None, spray_angle=None)
        if rng.random() < swing_p:
            whiff_p = prof["whiff"] / b.contact * b.weakness.get(ptype, 1.0) * _zone_penalty(b, x, z)
            whiff_p *= 0.55 if zone else 1.35
            if rng.random() < min(whiff_p, 0.85):
                row["description"] = "swinging_strike"
                strikes += 1
            elif rng.random() < 0.50:
                row["description"] = "foul"
                strikes = min(2, strikes + 1)
            else:
                row["description"] = "in_play"
                ev, la, spray, res = _batted_ball(rng, b, ptype, zone)
                row.update(launch_speed=round(ev, 1), launch_angle=round(la, 1), spray_angle=round(spray, 1), pa_result=res)
        else:
            if not zone and rng.random() < 0.006:
                row["description"] = "hit_by_pitch"
                row["pa_result"] = "hit_by_pitch"
            elif zone and rng.random() < 0.94 or (not zone and rng.random() < 0.06):
                row["description"] = "called_strike"
                strikes += 1
            else:
                row["description"] = "ball"
                balls += 1
        if row["pa_result"] is None:
            if strikes >= 3:
                row["pa_result"] = "strikeout"
            elif balls >= 4:
                row["pa_result"] = "walk"
        rows.append(row)
        if row["pa_result"]:
            return rows


OUTS_ADDED = {"strikeout": 1, "field_out": 1, "double_play": 2}


def _advance(bases: list[bool], result: str) -> list[bool]:
    b1, b2, b3 = bases
    if result in ("walk", "hit_by_pitch"):
        return [True, b2 or b1, b3 or (b1 and b2)]
    if result == "single":
        return [True, b1, b2]
    if result == "double":
        return [False, True, b1]
    if result == "triple":
        return [False, False, True]
    if result == "home_run":
        return [False, False, False]
    if result == "double_play":
        return [False, b2, b3]
    return bases


def generate(n_games: int = 60, seed: int = 7, start: date = date(2026, 4, 1)) -> pd.DataFrame:
    """가상 리그 경기를 시뮬레이션해 투구 단위 DataFrame을 돌려준다."""
    rng = np.random.default_rng(seed)
    pitchers, batters = build_rosters(rng)
    teams = list(TEAMS)
    by_team_p = {t: [p for p in pitchers if p.team == t] for t in teams}
    by_team_b = {t: [b for b in batters if b.team == t] for t in teams}
    rotation = {t: 0 for t in teams}
    rows: list[dict] = []

    for g in range(n_games):
        home, away = rng.choice(teams, size=2, replace=False)
        gdate = start + timedelta(days=g // 2)
        game_id = f"{gdate:%Y%m%d}-{away}{home}-{g % 2 + 1}"
        lineups = {t: list(rng.choice(by_team_b[t], size=9, replace=False)) for t in (home, away)}
        state = {}
        for t in (home, away):
            sps = [p for p in by_team_p[t] if p.role == "SP"]
            state[t] = {"pitcher": sps[rotation[t] % len(sps)], "count": 0, "used": set(), "order": 0}
            rotation[t] += 1
        pa_seq = 0
        for inning in range(1, 10):
            for half, bat_team, field_team in (("T", away, home), ("B", home, away)):
                outs, bases = 0, [False, False, False]
                fs = state[field_team]
                while outs < 3:
                    limit = 95 if fs["pitcher"].role == "SP" else 25
                    if fs["count"] >= limit:
                        fs["used"].add(fs["pitcher"].pid)
                        pool = [p for p in by_team_p[field_team] if p.role == "RP" and p.pid not in fs["used"]]
                        if pool:
                            fs["pitcher"] = pool[int(rng.integers(len(pool)))]
                            fs["count"] = 0
                    p = fs["pitcher"]
                    bs = state[bat_team]
                    b = lineups[bat_team][bs["order"] % 9]
                    bs["order"] += 1
                    pa_seq += 1
                    for n, pr in enumerate(simulate_pa(rng, p, b), start=1):
                        fs["count"] += 1
                        rows.append(dict(
                            game_id=game_id, game_date=gdate.isoformat(), venue=f"{TEAMS[home]} 홈구장",
                            home_team=home, away_team=away, inning=inning, top_bottom=half,
                            pa_seq=pa_seq, pitch_num=n,
                            pitcher_id=p.pid, pitcher_name=p.name, pitcher_team=p.team, p_throws=p.throws,
                            batter_id=b.pid, batter_name=b.name, batter_team=b.team, stand=b.stand,
                            outs=outs, on_1b=bases[0], on_2b=bases[1], on_3b=bases[2],
                            video_url=f"video/{game_id}.mp4", video_ts=None,
                            **pr,
                        ))
                        res = pr["pa_result"]
                    outs += OUTS_ADDED.get(res, 0)
                    bases = _advance(bases, res)
    df = pd.DataFrame(rows)
    # 영상 타임코드: 경기 영상 안에서 투구 간격을 약 22초로 가정
    df["video_ts"] = df.groupby("game_id").cumcount() * 22.0
    return df


def planted_weaknesses(seed: int = 7) -> dict[str, dict]:
    """테스트·시연용: 시뮬레이션에 심은 타자 약점을 돌려준다."""
    rng = np.random.default_rng(seed)
    _, batters = build_rosters(rng)
    return {b.pid: {"weakness": b.weakness, "weak_zone": b.weak_zone} for b in batters}
