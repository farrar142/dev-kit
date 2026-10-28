// Playwright 설정 조각 — 저장소의 playwright.config.ts 에 합친다.
// 핵심 셋: 시험 하나 3초(앞뒤 걸이 포함), 재시도 없음, 실패한 시험의 trace 만 남김.
import { defineConfig } from "@playwright/test";

// PLAYWRIGHT_WORKERS 는 숫자("4")와 퍼센트("50%") 둘 다 받는다. 문자열 "4" 를 그대로 넘기면
// Playwright 가 "config.workers must be a number or percentage" 로 설정 로딩 단계에서 죽는다.
function workersFromEnv(value: string | undefined): number | string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return /^\d+$/.test(value.trim()) ? Number(value) : value;
}

export default defineConfig({
  fullyParallel: true,
  // 기본 "50%" = 코어의 절반. 하드코딩하면 작은 머신에서는 죽고 큰 머신에서는 논다.
  // 메모리가 워커 수의 실제 상한이다 — 올리기 전에 앱 컨테이너의 메모리 여유를 본다.
  workers: workersFromEnv(process.env.PLAYWRIGHT_WORKERS) ?? "50%",
  forbidOnly: !!process.env.CI,
  // 재시도하지 않는다: 재시도가 흔들리는 시험을 초록으로 덮는다 (로그에만 남아 아무도 못 본다).
  retries: 0,
  // 시험 하나는 3초 안에 끝난다(앞뒤 걸이 포함). 넘으면 한도를 늘리지 않고 원인을 줄인다 —
  // 준비는 화면이 아니라 API 로, 기다림은 시간이 아니라 사건으로 한다.
  // 스펙에서 test.setTimeout / test.slow / describe.configure({ timeout }) 로 이 한도를 바꾸지 않는다.
  timeout: 3_000,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    // 재시도가 없으니 "on-first-retry" 는 영영 남지 않는다 — 실패한 시험의 것만 남긴다.
    trace: "retain-on-failure",
  },
});
