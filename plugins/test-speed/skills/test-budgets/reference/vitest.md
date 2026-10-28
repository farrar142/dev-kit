# vitest(프런트 단위 시험)에 적용할 때

## 한도: 정하지 않음

백엔드의 CPU 한도 방식(`conftest_cpu_budget.py`)은 맞지 않는다.

- vitest 는 시험 본문의 CPU 초를 내지 않는다. 남는 것은 **벽시계** `time` 뿐이다.
- 벽시계는 머신 부하에 부푼다. 같은 시험이 조용할 때 0.3초, 워커가 붐빌 때 1초다. 한도 근처의 시험이 빌드마다 번갈아 떨어진다(백엔드가 CPU 로 재는 이유).
- vitest 는 파일을 워커로 나눠 돌려 시험의 벽시계에 다른 파일의 부하가 섞인다. 첫 시험엔 모듈 import 가 붙는다.

그래서 이 스킬은 vitest 한도 값을 정하지 않는다. 분포를 재서 저장소 주인과 정한다. 정하더라도 후보 찾기용 경고(예: junit 후처리로 목록만 출력)에서 시작하고, 실패로 바꾸는 것은 분포를 본 뒤에 한다.

**한 저장소의 실측(일반 규칙 아님)**: 499건 가운데 0.5초 초과 13~14건, 1초 초과 1건(최대 1.13초). 이 수치를 다른 저장소의 한도로 옮기지 않는다 — 자기 분포를 잰다.

## junit 뽑는 법

```bash
npx vitest run --reporter=junit --outputFile=test-results/vitest-junit.xml
python3 <이 스킬 폴더>/examples/junit_slowest.py test-results/vitest-junit.xml 20 0.5
```

`cpu_seconds` 속성이 없으면 `junit_slowest.py` 는 자동으로 `time` 기준으로 센다(출력 첫 줄에 「time(벽시계) 기준」이 찍힌다). 여러 번 돌려 두 번 이상 나오는 시험만 후보로 삼는다. 콘솔에도 같이 보려면 `--reporter=default --reporter=junit` 으로 둘을 겹친다.

## 느릴 때 먼저 볼 것

모듈 import 가 무거운 파일(첫 시험에 붙는다), 진짜 타이머를 기다리는 시험(→ `reference/waiting-for-events.md` 의 가짜 타이머), 네트워크를 진짜로 부르는 시험.
