# switchboard 바뀐 것

## 0.17.0

- 질문 도구(`ask`)에 선택 칸 `relay_to` 를 더했다(#215). 이 답 원문을 받을 역할 문자열 배열, 최대 8개(공백·빈 값·중복은 걷는다).
  - 서버 질문(`POST /api/questions`) 본문에 `relay_to` 로 싣는다. 비었거나 안 주면 칸을 뺀다(옛 서버는 모르는 칸을 무시한다). 서버가 400 을 주면 지금처럼 그 본문이 결과에 남는다.
  - 서버에 올리지 못해 로컬 패널로 떨어졌고 `relay_to` 가 있었으면 결과에 「중계되지 않음」 한 줄을 붙인다.

## 0.16.2

- CLI 판(`switchboard version`)을 세션에 한 번만 읽던 것을 시각 붙은 캐시로 바꿨다(#211). 디스크의 CLI 를 올려도 먼저 뜬 세션은 다시 뜰 때까지 옛 판을 heartbeat 머리(`X-Switchboard-Version`)에 싣고, 서버가 「옛 판」 통지를 보냈다.
  - 수명은 10분(`CLI_VERSION_TTL_MS`). 읽기 한도 3초는 그대로. 수명이 지난 뒤에는 앞의 값을 바로 쓰고 뒤에서 다시 읽어, 읽기가 느려도 heartbeat 가 밀리지 않는다. 다시 읽기가 실패하면(오류·한도 초과·이상한 출력) 앞의 값을 그대로 쓴다.
  - 메일 꼬리 판가름도 같은 캐시를 쓴다. 새 판은 이 플러그인이 다시 뜬 세션부터 적용된다.

## 0.16.1

- 시스템 통지(예약이 울려 온 메일 포함)와 긴급 메일 본문 상한을 2,000자에서 4,000자로 올려 일반 메일(`MAIL_INLINE_MAX`)과 맞춘다(#206). 한도는 서버·CLI 가 아니라 이 플러그인의 `NOTICE_MAX_CHARS`·`URGENT_MAX_CHARS` 였다.
- 상한을 넘어 잘릴 때 꼬리를 「이 글만으로 일을 시작하지 말고 먼저 `switchboard read <ID>` 로 전문을 읽어라」로 바꿨다.

## 0.16.0

- 일반 메일 본문을 세션에 바로 넣는다(#203). 「메일 #N 을 읽어라」 한 줄만 넣으면 세션이 본문을 보려고 `read` 를 한 번 더 불러, 메일마다 모델 호출 하나가 덧값으로 들었다.
  - 꼴은 CLI `read` 출력과 같다: `#ID 제목` / `보낸이 → 받는이 · read` / 본문(두 칸 들여쓰기). 넣은 뒤 read 로 표시한다.
  - 한 통이 4,000자(`MAIL_INLINE_MAX`)를 넘으면 머리만 넣고 `switchboard read <ID>` 를 시킨다. 한 턴에 여러 통이면 본문 합 8,000자(`MAIL_TURN_MAX`)까지 넣고, 넘는 통은 머리만.
  - 본문을 못 받으면(서버 오류·연결 실패·응답 모양 틀림·10초 한도) 그 통은 읽음 처리하지 않고 옛 꼴(「메일 #N 을 읽고 처리하라」)로 넣는다. 본문을 받은 뒤 턴 넣기가 실패하면 받아 둔 본문으로 다시 넣는다(본문 GET 이 서버에서 read 로 바꿨어도 잃지 않는다).
- 꼬리는 CLI 판으로 가른다(문턱 `MAIL_TAIL_MIN_VERSION` = 0.32.0). 이상이면 「답하고 끝내기: switchboard reply <ID> --complete … / 답 없이 끝내기: switchboard complete <ID>」, 열린 지시의 답이면 「끝났으면 switchboard close <답 ID>」. 낮거나 CLI 가 없거나 판을 못 읽으면(3초 한도) 옛 꼬리 그대로다. 판은 세션에 한 번 읽고 슬롯 머리(`X-Switchboard-Version`)와 같이 쓴다.
- 넣는 때(유휴, 입력 중 미룸, 긴급은 바로)는 그대로다.

## 0.15.0

- 슬롯 register·heartbeat(takeover·release 포함) 요청에 머리 `X-Switchboard-Version: vX.Y.Z` 를 싣는다(#192). 서버가 세션 행의 CLI 판을 이 머리로만 채워, 싣지 않으면 모든 세션이 「판 모름」으로 떴다. 값은 플러그인 판이 아니라 그 세션이 쓰는 `switchboard version` 출력(「switchboard v0.31.0」)의 `vX.Y.Z`다.
- CLI 경로는 넘기기 훅과 같다(`SWITCHBOARD_CLI`, 없으면 PATH). 판은 세션에 한 번만 읽고(heartbeat 마다 프로세스를 띄우지 않는다) 결과를 기억한다.
- CLI 가 없거나 실행 실패·시간 초과(프로세스 2.5초, 번호 받기 쪽에서 3초)·출력에서 판을 못 읽으면 머리만 뺀다. 번호 받기·메일함 연결은 그대로다.

## 0.14.1

- CLI 판 문턱 0.29.0 → 0.30.0(#190). v0.29.x 의 `job ping` 은 터미널을 닫으면 실행기가 죽는 환경을 보지 못해 0 을 낸다. ping 이 0 이어도 `version`이 0.30.0 미만(또는 못 읽음)이면 원래 호출 그대로 두고 「넘기지 못했다: CLI <판> < v0.30.0」 한 줄을 붙인다. 판 확인은 ping 성공과 함께 30초 기억한다.
- 기본 꺼짐은 그대로다.

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
