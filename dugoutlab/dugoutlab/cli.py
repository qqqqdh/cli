"""명령줄 도구: dugoutlab <명령> ...

  demo     가상 리그 샘플 데이터를 만들어 DB에 넣는다 (처음 써 볼 때)
  sample   샘플 투구 CSV 파일만 만든다
  ingest   투구 CSV를 DB에 적재한다 (장비별 컬럼은 --mapping 으로 맞춤)
  team     팀 코드에 표시 이름을 붙인다
  report   상대팀 스카우팅 리포트(HTML/PDF)를 만든다
  serve    투구 탐색기 웹 화면을 띄운다
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .db import DEFAULT_DB_PATH, connect, set_team_name


def _add_db(p: argparse.ArgumentParser) -> None:
    p.add_argument("--db", default=str(DEFAULT_DB_PATH), help=f"DuckDB 파일 (기본 {DEFAULT_DB_PATH})")


def cmd_sample(args) -> int:
    from .sample_data import generate

    df = generate(n_games=args.games, seed=args.seed)
    df.to_csv(args.out, index=False)
    print(f"{args.out}: {len(df):,}구, {df['game_id'].nunique()}경기")
    return 0


def cmd_demo(args) -> int:
    from .ingest import ingest_dataframe
    from .sample_data import TEAMS, generate

    con = connect(args.db)
    df = generate(n_games=args.games, seed=args.seed)
    result = ingest_dataframe(con, df, source="sim", file_label="demo")
    for code, name in TEAMS.items():
        set_team_name(con, code, name)
    print(result.summary())
    print(f"팀: {', '.join(f'{c}({n})' for c, n in TEAMS.items())}")
    print(f"다음: dugoutlab report RED --db {args.db}  또는  dugoutlab serve --db {args.db}")
    return 0


def cmd_ingest(args) -> int:
    from .ingest import ingest_csv

    con = connect(args.db)
    failed = False
    for path in args.files:
        print(f"[{path}]")
        try:
            result = ingest_csv(con, path, source=args.source, mapping_path=args.mapping)
        except (ValueError, FileNotFoundError) as exc:
            print(f"  실패: {exc}")
            failed = True
            continue
        print("  " + result.summary().replace("\n", "\n  "))
    return 1 if failed else 0


def cmd_team(args) -> int:
    con = connect(args.db)
    set_team_name(con, args.code, args.name)
    print(f"{args.code} = {args.name}")
    return 0


def cmd_report(args) -> int:
    from .report import build_team_report, render_html, write_pdf

    con = connect(args.db)
    try:
        ctx = build_team_report(con, args.team, args.date_from, args.date_to,
                                min_pitches=args.min_pitches, min_pa=args.min_pa)
    except ValueError as exc:
        print(f"리포트를 만들 수 없습니다: {exc}", file=sys.stderr)
        return 1
    html = render_html(ctx)
    out = Path(args.out or f"report_{args.team}.html")
    out.write_text(html, encoding="utf-8")
    print(f"HTML: {out} (투수 {len(ctx['pitchers'])}명, 타자 {len(ctx['batters'])}명)")
    if args.pdf:
        try:
            print(f"PDF: {write_pdf(html, args.pdf)}")
        except RuntimeError as exc:
            print(str(exc), file=sys.stderr)
            return 1
    return 0


def cmd_serve(args) -> int:
    import uvicorn

    from .api import create_app

    app = create_app(args.db)
    print(f"투구 탐색기: http://{args.host}:{args.port}/")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="dugoutlab", description="야구 전력분석 지원 도구 (MVP)")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("demo", help="샘플 데이터를 만들어 DB에 넣기")
    _add_db(p)
    p.add_argument("--games", type=int, default=120)
    p.add_argument("--seed", type=int, default=7)
    p.set_defaults(func=cmd_demo)

    p = sub.add_parser("sample", help="샘플 투구 CSV 만들기")
    p.add_argument("--games", type=int, default=120)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--out", default="sample_pitches.csv")
    p.set_defaults(func=cmd_sample)

    p = sub.add_parser("ingest", help="투구 CSV 적재")
    _add_db(p)
    p.add_argument("files", nargs="+")
    p.add_argument("--source", help="데이터 출처 이름 (선수 ID 매핑 구분용)")
    p.add_argument("--mapping", help="컬럼·단위 매핑 JSON 파일")
    p.set_defaults(func=cmd_ingest)

    p = sub.add_parser("team", help="팀 표시 이름 설정")
    _add_db(p)
    p.add_argument("code")
    p.add_argument("name")
    p.set_defaults(func=cmd_team)

    p = sub.add_parser("report", help="상대팀 스카우팅 리포트")
    _add_db(p)
    p.add_argument("team", help="팀 코드")
    p.add_argument("--from", dest="date_from")
    p.add_argument("--to", dest="date_to")
    p.add_argument("--min-pitches", type=int, default=80, help="투수 포함 기준 투구 수")
    p.add_argument("--min-pa", type=int, default=20, help="타자 포함 기준 타석 수")
    p.add_argument("--out", help="HTML 저장 경로")
    p.add_argument("--pdf", help="PDF 저장 경로 (Playwright 필요)")
    p.set_defaults(func=cmd_report)

    p = sub.add_parser("serve", help="투구 탐색기 웹 화면")
    _add_db(p)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.set_defaults(func=cmd_serve)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
