export type QuestionPanelOption = { label: string; description: string }

export type QuestionPanelQuestion = {
  question: string
  /** 12자 이내 */
  header: string
  options: QuestionPanelOption[]
  multiSelect: boolean
  /** 고른 선택지의 label들(고른 순서) */
  picked: string[]
  /** 「기타(직접 입력)」 칸의 글 */
  other: string
}

export type QuestionPanelBatch = {
  id: string
  /** 만든 시각(ms) */
  createdAt: number
  /** pending: 답 대기, sent: 모델에 보냄(또는 via가 chat이면 대화창에서 답함) */
  status: 'pending' | 'sent'
  questions: QuestionPanelQuestion[]
  /** 삭제 확인을 띄운 상태(없으면 false) */
  confirmingDelete?: boolean
  /** 이 묶음을 올린 도구 호출의 tool_use_id(0.3.0부터; 그 전 묶음은 없음) */
  toolUseId?: string
  /** 어떻게 닫혔나: chat이면 사용자가 대화창에 글로 답함(0.4.0부터; 없으면 패널에서 보냄) */
  via?: 'chat'
}

declare module 'claude-code' {
  interface PluginState {
    'question-panel': { queue: Shaped<QuestionPanelBatch[]>; draft: string }
  }
}
