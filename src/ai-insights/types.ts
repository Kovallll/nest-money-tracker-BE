export type InsightType =
  | 'anomaly'
  | 'overspend'
  | 'budget_tip'
  | 'fx_signal'
  | 'investment_signal'
  | 'system';

export type InsightSeverity = 'low' | 'medium' | 'high';

export type InsightStatus = 'active' | 'acknowledged' | 'dismissed' | 'expired';

export interface AiInsightItem {
  id: string;
  userId: string;
  type: InsightType;
  severity: InsightSeverity;
  status: InsightStatus;
  title: string;
  message: string;
  confidence: number;
  riskLevel: 'low' | 'medium' | 'high';
  source: 'rules' | 'llm' | 'market';
  payload: Record<string, unknown>;
  notFinancialAdvice: boolean;
  createdAt: string;
  expiresAt?: string | null;
}

export interface ChatReference {
  kind: 'insight' | 'metric' | 'transaction';
  value: string;
}

export interface ChatResponse {
  answer: string;
  references: ChatReference[];
  usedFallback: boolean;
}

export interface ChatHistoryMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  message: string;
  refs: ChatReference[];
  createdAt: string;
}

export interface ChatSessionItem {
  id: string;
  channel: 'app' | 'telegram';
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string | null;
  messagesCount: number;
}

