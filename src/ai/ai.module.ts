import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AiOrchestratorService, AI_PROVIDER } from '@/ai/ai-orchestrator.service';
import { GeminiProvider } from '@/ai/providers/gemini.provider';
import { GroqProvider } from '@/ai/providers/groq.provider';

@Module({
  imports: [HttpModule],
  providers: [
    GeminiProvider,
    GroqProvider,
    {
      provide: AI_PROVIDER,
      useFactory: (geminiProvider: GeminiProvider, groqProvider: GroqProvider) => {
        const provider = (process.env.AI_PROVIDER || 'gemini').trim().toLowerCase();
        switch (provider) {
          case 'groq':
            return groqProvider;
          case 'gemini':
          default:
            return geminiProvider;
        }
      },
      inject: [GeminiProvider, GroqProvider],
    },
    AiOrchestratorService,
  ],
  exports: [AiOrchestratorService],
})
export class AiModule {}
