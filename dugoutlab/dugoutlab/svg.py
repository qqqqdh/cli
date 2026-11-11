"""리포트용 인라인 SVG 차트 (외부 라이브러리 없이 인쇄·오프라인에서 그대로 보인다)."""

from __future__ import annotations

import math
from html import escape

PITCH_COLORS = {
    "FF": "#d1495b", "SI": "#ed7d3a", "FC": "#8c5e58", "SL": "#2e86ab",
    "ST": "#3fa7d6", "CU": "#5b507a", "CH": "#3c9d5d", "FS": "#1b998b", "KN": "#888888",
}

# 순차 색 (밝음 → 진함). 값이 클수록 진하게.
HEAT_RED = [(255, 245, 240), (252, 187, 161), (251, 106, 74), (203, 24, 29), (103, 0, 13)]
HEAT_BLUE = [(247, 251, 255), (198, 219, 239), (107, 174, 214), (33, 113, 181), (8, 48, 107)]


def pitch_color(code: str) -> str:
    return PITCH_COLORS.get(code, "#777777")


def _interp(stops: list[tuple[int, int, int]], t: float) -> str:
    t = min(max(t, 0.0), 1.0) * (len(stops) - 1)
    i = min(int(t), len(stops) - 2)
    f = t - i
    a, b = stops[i], stops[i + 1]
    r, g, bl = (round(a[k] + (b[k] - a[k]) * f) for k in range(3))
    return f"rgb({r},{g},{bl})"


def zone_heatmap(grid: dict, title: str, lo: float, hi: float, fmt: str = "pct",
                 min_n: int = 5, scheme: str = "red", size: int = 170) -> str:
    """5x5 격자 히트맵. 가운데 3x3 굵은 테두리 = 스트라이크존. 포수 시점."""
    stops = HEAT_RED if scheme == "red" else HEAT_BLUE
    cell = size / 5
    top = 22
    parts = [
        f'<svg class="heat" viewBox="0 0 {size} {size + top + 18}" width="{size}" '
        f'role="img" aria-label="{escape(title)}">',
        f'<text x="{size / 2}" y="14" text-anchor="middle" class="ct">{escape(title)}</text>',
    ]
    for r, row in enumerate(grid["cells"]):
        for c, item in enumerate(row):
            x, y = c * cell, top + r * cell
            v, n = item["v"], item["n"]
            ok = n >= min_n and math.isfinite(v)
            fill = _interp(stops, (v - lo) / (hi - lo)) if ok else "#f1f1f1"
            parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{cell:.1f}" height="{cell:.1f}" '
                         f'fill="{fill}" stroke="#ffffff" stroke-width="1"/>')
            if ok:
                label = f"{v:.0%}" if fmt == "pct" else f"{v:.3f}".lstrip("0")
                dark = (v - lo) / (hi - lo) > 0.55
                parts.append(f'<text x="{x + cell / 2:.1f}" y="{y + cell / 2 + 4:.1f}" text-anchor="middle" '
                             f'class="cv" fill="{"#ffffff" if dark else "#222222"}">{label}</text>')
    parts.append(f'<rect x="{cell:.1f}" y="{top + cell:.1f}" width="{cell * 3:.1f}" height="{cell * 3:.1f}" '
                 f'fill="none" stroke="#222" stroke-width="2"/>')
    parts.append(f'<text x="{size / 2}" y="{size + top + 13}" text-anchor="middle" class="cn">'
                 f'포수 시점 · 회색 = 표본 {min_n} 미만</text>')
    parts.append("</svg>")
    return "".join(parts)


def movement_chart(arsenal: list[dict], size: int = 220) -> str:
    """구종별 평균 무브먼트(cm). 가로 = 수평(포수 시점), 세로 = 수직."""
    lim = 60.0
    pad = 26
    span = size - 2 * pad

    def sx(v: float) -> float:
        return pad + (v + lim) / (2 * lim) * span

    def sy(v: float) -> float:
        return pad + (lim - v) / (2 * lim) * span

    parts = [
        f'<svg class="move" viewBox="0 0 {size} {size}" width="{size}" role="img" aria-label="구종별 무브먼트">',
        f'<text x="{size / 2}" y="14" text-anchor="middle" class="ct">무브먼트 (cm, 포수 시점)</text>',
        f'<line x1="{pad}" y1="{sy(0)}" x2="{size - pad}" y2="{sy(0)}" stroke="#bbb"/>',
        f'<line x1="{sx(0)}" y1="{pad}" x2="{sx(0)}" y2="{size - pad}" stroke="#bbb"/>',
        f'<rect x="{pad}" y="{pad}" width="{span}" height="{span}" fill="none" stroke="#ddd"/>',
        f'<text x="{size - pad}" y="{sy(0) - 4}" text-anchor="end" class="cn">+{lim:.0f}</text>',
        f'<text x="{sx(0) + 4}" y="{pad + 10}" class="cn">+{lim:.0f}</text>',
    ]
    for row in arsenal:
        if not (math.isfinite(row["pfx_x"]) and math.isfinite(row["pfx_z"])):
            continue
        x, y = sx(max(-lim, min(lim, row["pfx_x"]))), sy(max(-lim, min(lim, row["pfx_z"])))
        r = 4 + 10 * math.sqrt(row["usage"])
        color = pitch_color(row["pitch_type"])
        parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" fill="{color}" fill-opacity="0.8"/>')
        parts.append(f'<text x="{x + r + 3:.1f}" y="{y + 4:.1f}" class="cl">{escape(row["pitch_type"])}</text>')
    parts.append("</svg>")
    return "".join(parts)


def usage_bar(arsenal: list[dict], width: int = 260) -> str:
    """구종 비율 가로 막대 하나 (좌·우타자 비교용으로 두 줄)."""
    h = 14
    rows = [("전체", "usage"), ("vs 좌타", "usage_vs_l"), ("vs 우타", "usage_vs_r")]
    label_w = 46
    parts = [f'<svg class="bar" viewBox="0 0 {width} {len(rows) * (h + 6)}" width="{width}" role="img" aria-label="구종 비율">']
    for i, (label, key) in enumerate(rows):
        y = i * (h + 6)
        parts.append(f'<text x="0" y="{y + h - 3}" class="cn">{label}</text>')
        x = label_w
        for row in arsenal:
            v = row.get(key)
            if v is None or not math.isfinite(v) or v <= 0:
                continue
            w = v * (width - label_w)
            parts.append(f'<rect x="{x:.1f}" y="{y}" width="{w:.1f}" height="{h}" fill="{pitch_color(row["pitch_type"])}"/>')
            if w > 24:
                parts.append(f'<text x="{x + w / 2:.1f}" y="{y + h - 3}" text-anchor="middle" class="cb">{row["pitch_type"]}</text>')
            x += w
    parts.append("</svg>")
    return "".join(parts)
