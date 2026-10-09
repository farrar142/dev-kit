# 엔진 쪽: 시계 손잡이 설계

틱 루프를 가진 서버(게임 엔진, 시뮬레이터, 배치 스케줄러)에 시험 전용 손잡이를 다는 틀이다. 운영 코드는 바꾸지 않는다. **시험 엔진에서만 루프 클래스를 감싼 것으로 바꿔 끼운다.**

## 상태

```python
@dataclass
class Run:            # 감기 하나
    left: int         # 남은 틱
    gap: float        # 틱 사이 실제 초
    reply: tuple | None = None   # 다 돌면 줄 답(요청 id, 답)

@dataclass
class Clock:
    paused: bool = False
    rebase: bool = False          # 다음 박자는 지금부터 잰다(멈춘 시간만큼 따라잡지 않는다)
    runs: list[Run] = field(default_factory=list)   # 줄 선 감기, 맨 앞이 도는 것
    done: list = field(default_factory=list)        # 다 돈 감기의 답

    def holding(self): return self.paused and not self.runs
    def controls(self): return self.paused or bool(self.runs) or self.rebase
```

## 루프에 끼우는 자리 (세 곳)

1. **다음 박자 시각:** 손잡이를 쥐고 있으면 `지금 + (감기 중이면 run.gap, 아니면 원래 간격)`. 쥐지 않았으면 원래 계산을 그대로 쓴다.
2. **틱이 끝난 뒤:** 맨 앞 감기의 `left -= 1`. 0이 되면 꺼내서 그 답을 `done`에 넣는다.
3. **요청 처리 구간:**
   - 먼저 `done`의 답을 보낸다. 마지막 틱이 다 돈 뒤다.
   - 멈춤 중(`holding`)이면 틱을 돌지 않는다. 요청 큐만 짧게(0.2초) 막혀 기다리며 처리한다.
   - 멈춤 중에도 1초마다 살아 있음(감시견, 상태 키)을 새로 한다. 멈춤은 죽음이 아니다.
   - `advance` 요청은 바로 답하지 않는다. 그 감기의 `reply`에 걸어 두고 다 돌면 답한다.

## 요청 기한과 조각

RPC에 답 기한(예: 2초)이 있으면, 긴 감기는 호출하는 쪽(Django)에서 조각으로 나눈다.
- 간격이 0이면 RPC 하나에 최대 200틱.
- 간격이 있으면 `1초 // 간격 + 1`틱씩 나누고, 조각 사이에도 같은 간격을 둔다.
- 엔진은 한 조각이 기한을 넘을 만큼 길면 거절한다(`too_long`).

## 노출

- op 이름은 `test.*`로 둔다. 시험 op를 켠 엔진만 받는다.
- 관리 명령 `pause_clock`, `resume_clock`, `advance_clock --ticks N --interval-ms M`.
- HTTP `POST /api/test/clock/<action>`. 시험 설정에서만 URL을 등록한다. 운영 설정에서 404인지 시험한다.

## 시험(백엔드)

- **멈춤:** 멈춘 동안 틱 수가 그대로이고, 다시 돌리면 월드 시각이 멈춘 시간만큼 뛰지 않는다.
- **감기:** N틱을 감으면 정확히 N틱이 돈다. 답이 마지막 틱 뒤에 온다. 겹친 감기가 줄을 선다.
- **잘못된 인자:** `ticks < 1`이거나 `interval < 0`이면 거절한다.
- **운영:** 운영 설정에서 경로가 404다.
