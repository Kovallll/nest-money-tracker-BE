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

