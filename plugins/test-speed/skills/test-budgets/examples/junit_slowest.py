#!/usr/bin/env python3
"""junit XML 에서 느린 시험을 뽑는다 — 쓰임: junit_slowest.py <junit.xml> [상위 N=20] [임계 초=0.5]

두 모드를 파일이 정한다.
- pytest(conftest_cpu_budget.py 가 `cpu_seconds` 를 남긴 junit): `cpu_seconds`(본문 CPU)와 `time`(setup·teardown
  포함 벽시계)을 나란히 보인다. time 만 크고 cpu_seconds 가 작으면 느린 것은 시험이 아니라 픽스처(setup)다.
- `cpu_seconds` 가 하나도 없는 junit(vitest 등): `time` 기준으로 센다. 벽시계라 머신 부하에 부푼다 —
  한도 판정이 아니라 후보 찾기에만 쓴다 (reference/vitest.md).
"""

import sys
import xml.etree.ElementTree as ET


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    path = sys.argv[1]
    top = int(sys.argv[2]) if len(sys.argv) > 2 else 20
    threshold = float(sys.argv[3]) if len(sys.argv) > 3 else 0.5
    rows: list[tuple[float | None, float, str]] = []
    for case in ET.parse(path).getroot().iter("testcase"):
        cpu: float | None = None
        for prop in case.iter("property"):
            if prop.get("name") == "cpu_seconds":
                cpu = float(prop.get("value", "0"))
        rows.append((cpu, float(case.get("time", "0")), f"{case.get('classname')}::{case.get('name')}"))

    if all(r[0] is None for r in rows):
        over = [r for r in rows if r[1] > threshold]
        print(f"시험 {len(rows)}건, cpu_seconds 없음 -> time(벽시계) 기준, time > {threshold}: {len(over)}건")
        print(f"{'time':>7}  시험")
        for _, wall, name in sorted(rows, key=lambda r: r[1], reverse=True)[:top]:
            print(f"{wall:7.3f}  {name}")
        return 0

    full = [(r[0] or 0.0, r[1], r[2]) for r in rows]
    over_cpu = [r for r in full if r[0] > threshold]
    print(f"시험 {len(full)}건, cpu_seconds > {threshold}: {len(over_cpu)}건")
    print(f"{'cpu':>7} {'time':>7}  시험")
    for cpu, wall, name in sorted(full, reverse=True)[:top]:
        print(f"{cpu:7.3f} {wall:7.3f}  {name}")
    print("-- time 이 크고 cpu 가 작은 것(픽스처가 느린 후보) --")
    for cpu, wall, name in sorted(full, key=lambda r: r[1] - r[0], reverse=True)[:5]:
        print(f"{cpu:7.3f} {wall:7.3f}  {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
