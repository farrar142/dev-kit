export type QuestionPanelOption = {
  label: string
  description: string
  /** 고르기 전에 보여 줄 마크다운(코드·ASCII 목업·설정 예시). AskUserQuestion의 preview와 같은 뜻(0.5.0부터) */
  preview?: string
}

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
  /** 지금 펼친 preview의 선택지 label(없으면 접힘, 0.5.0부터) */
  peek?: string
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
  /** 어떻게 닫혔나: chat이면 사용자가 대화창에 글로 답함(0.4.0부터), dismissed면 답 없이 닫음(0.8.0부터); 없으면 패널에서 보냄 */
  via?: 'chat' | 'dismissed' | 'orca' | 'orca-dismissed'
  /**
   * 닫힘 장부 key `<세션 ID>~q<N>~<만든 시각>`(0.9.0부터). Orca 질문 패널과 이 묶음을 잇는다. 없으면(옛 묶음) 장부를 안 쓴다.
   * via orca: Orca 질문 패널에서 답함, orca-dismissed: Orca 패널에서 답 없이 닫음(장부에서 읽음).
   */
  key?: string
}

declare module 'claude-code' {
  interface PluginState {
    'question-panel': { queue: Shaped<QuestionPanelBatch[]>; draft: string }
  }
}
