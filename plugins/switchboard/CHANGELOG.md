# switchboard 바뀐 것

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
