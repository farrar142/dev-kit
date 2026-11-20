# switchboard 바뀐 것

## 0.14.0

- 넘기기 전에 `switchboard job ping`(#188): `SWITCHBOARD_CLI`로 고른 CLI로 부르고 종료 코드 0일 때만 넘긴다. 0이 아니거나 시간 초과·실행 실패면 원래 호출 그대로 두고 「넘기지 못했다: <까닭>」 한 줄을 붙인다. 까닭에 종료 코드 이름(10 config·11 data·12 server·13 token·14 runner)을 쓴다. ping 이 없는 옛 CLI(exit 2)는 `version`으로 판을 적는다.
- CLI 판 문턱 0.27.0 → 0.29.0(`job ping`이 처음 들어간 판). 이전의 `version` 대신 재던 길은 없앴다.
- ping 성공은 CLI 경로별로 30초 기억해 도구 호출마다 1초씩 더 걸리지 않게 하고, 실패는 기억하지 않아 고친 뒤 바로 다시 넘어간다.
- exit 125(실행기가 못 뜸, `job run`·`watch start`가 stderr 에 「job not handed over, run the command yourself」)는 CLI README 계약대로 아무것도 넘기지 않았고 명령도 돌지 않은 것이다. `--wait`은 명령의 종료 코드를 그대로 돌려주므로 훅이 125 를 보고 명령을 다시 돌리지는 않는다(명령이 스스로 125 로 끝난 것과 섞여 두 번 도는 것을 막는다). ping 의 runner 확인이 같은 조건을 미리 걸러 낸다.
- 기본 꺼짐은 그대로다.

## 0.13.2

- 넘기기 기본 꺼짐(#186): `SWITCHBOARD_HANDOFF`가 `1`·`on`·`true`·`yes`일 때만 켠다(없거나 그 밖의 값은 꺼짐). 사용자 범위로 올린 플러그인이 그 뒤 모든 세션을 넘기기 시험에 넣던 것을 막는다. 기본값 상수는 `core/handoff.ts`의 `HANDOFF_DEFAULT_ON`·`HANDOFF_ON_VALUES`.

## 0.13.1

- 넘기기 고침(#184): CLI v0.27.0 이상이 필요하다(건강 검사 문턱 0.26.0 → 0.27.0).
  - 시간 한도(timeout)가 있는 Monitor → `watch start --attach --no-extend --expires <timeout_ms>ms`. 세션이 붙어 있어도 기한이 늘지 않아 기한을 넘겨 살아남지 않는다. 한도 없는 Monitor 는 그대로(연장됨).
  - ScheduleWakeup → `schedule add --in <초>s`. 분으로 올림하던 것을 없앴다.

## 0.13.0

- 넘기기(#182): 리눅스에서 프로필 있는 본 세션의 백그라운드 명령·예약·감시를 switchboard 장부로 넘겨, 세션이 다시 떠도 남게 한다. CLI v0.26.0 이상이 필요하다.
  - Bash `run_in_background` → `switchboard job run --wait --label <앞 60자> -- <셸> -c <원래 명령>`. 출력 첫 줄(stderr) `switchboard job <id>`로 다시 뜬 세션이 `job wait <id>`로 붙는다.
  - Monitor(명령) → `switchboard watch start --attach --expires <timeout_ms> --label <설명> -- <셸> -c <원래 명령>`. 웹소켓 감시는 그대로.
  - CronCreate → `schedule add --cron`(한 번짜리는 분·시·일·월이 박힌 꼴만 `--at`), 호출은 거절하고 까닭에 `sb-<id>`와 「메일로 온다」. CronDelete `sb-<id>` → `schedule rm`, CronList 뒤에 `schedule list`.
  - ScheduleWakeup → `schedule add --in <분>`, 거절. `stop`은 이 세션이 만든 것을 거둔다.
  - 넘기지 않는 것: 서브에이전트의 호출, /loop 표지(`<<…>>`) 프롬프트, 이미 `switchboard job run`·`watch start`로 시작하는 명령.
  - 건강 검사(`job ping`, 없으면 `version` ≥ 0.26.0, 3초)가 실패하면 원래 호출 그대로 돌고 결과에 「넘기지 못했다」 한 줄을 더한다. 훅 오류도 원래 호출을 막지 않는다.
  - 끄기 `SWITCHBOARD_HANDOFF=0`, CLI 고르기 `SWITCHBOARD_CLI`. 켜는 플랫폼은 `core/handoff.ts`의 `HANDOFF_PLATFORMS` 한 곳.
