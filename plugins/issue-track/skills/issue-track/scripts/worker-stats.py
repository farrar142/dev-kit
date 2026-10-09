"""issue-worker(플러그인 이름공간 `issue-track:issue-worker` 포함)와 그 심부름꾼 토큰 통계. 인자: 작업자 agentId 여럿(없으면 이 세션 issue-worker 전부).

세션 폴더: WSTATS_DIR(subagents 폴더), 없으면 현재 디렉터리 프로젝트에서 가장 최근에 바뀐 세션의 subagents.
워크트리 안에서 돌리면 프로젝트가 달라지니 저장소 루트에서 돌린다."""
import json, sys, glob, os, collections
# 세션 폴더: WSTATS_DIR, 없으면 이 프로젝트에서 가장 최근에 바뀐 세션의 subagents
P = os.path.expanduser("~/.claude/projects/" + os.getcwd().replace("/", "-").replace(".", "-"))
D = os.environ.get("WSTATS_DIR") or max(glob.glob(f"{P}/*/subagents"), key=os.path.getmtime)
metas = {os.path.basename(p)[6:-10]: json.load(open(p)) for p in glob.glob(f"{D}/agent-*.meta.json")}
def stat(aid):
    tin = tout = maxctx = turns = 0; tools = collections.Counter(); seen = set()
    for l in open(f"{D}/agent-{aid}.jsonl"):
        d = json.loads(l)
        if d.get("type") != "assistant": continue
        m = d["message"]; u = m.get("usage") or {}
        rid = d.get("requestId") or m.get("id")
        if rid not in seen:
            seen.add(rid); turns += 1
            ctx = u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
            tin += ctx; tout += u.get("output_tokens", 0); maxctx = max(maxctx, ctx)
        for c in m.get("content", []):
            if c.get("type") == "tool_use": tools[c["name"]] += 1
    return dict(turns=turns, inM=tin / 1e6, outK=tout / 1e3, maxK=maxctx / 1e3, tools=tools)
ids = sys.argv[1:] or [k for k, v in metas.items() if str(v.get("agentType", "")).endswith("issue-worker")]
for aid in ids:
    s = stat(aid); kids = [k for k, v in metas.items() if v.get("parentAgentId") == aid]
    ks = [stat(k) for k in kids]
    t = s["tools"]
    print(f"{metas[aid]['description'][:22]:22} 턴{s['turns']:4} 입력{s['inM']:6.1f}M 최대ctx{s['maxK']:5.0f}k 출력{s['outK']:5.0f}k | Bash{t['Bash']} Read{t['Read']} Edit{t['Edit']+t['Write']} Agent{t['Agent']} | 심부름{len(kids)} 입력{sum(k['inM'] for k in ks):.1f}M")
    for k in kids: print(f"    └ {metas[k]['description'][:40]} ({metas[k]['agentType']}) 입력{stat(k)['inM']:.1f}M")
