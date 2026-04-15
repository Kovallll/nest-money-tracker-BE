import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';
import { AiInsightsService } from '@/ai-insights/ai-insights.service';
import { AckInsightDto, AskAiDto, QueryInsightsDto } from '@/ai-insights/dto';

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiInsightsController {
  constructor(private readonly aiInsights: AiInsightsService) {}

  @Get('insights')
  async getInsights(@Req() req: { user: { id: string } }, @Query() query: QueryInsightsDto) {
    return this.aiInsights.getInsights(req.user.id, {
      status: query.status,
      type: query.type,
    });
  }

  @Post('insights/recompute')
  async recompute(@Req() req: { user: { id: string } }) {
    return this.aiInsights.recomputeUserInsights(req.user.id, 'manual_api');
  }

  @Post('insights/:id/ack')
  async ackInsight(
    @Req() req: { user: { id: string } },
    @Param('id') insightId: string,
    @Body() dto: AckInsightDto,
  ) {
    return this.aiInsights.acknowledgeInsight(req.user.id, insightId, dto.status);
  }

  @Post('chat')
  async ask(@Req() req: { user: { id: string } }, @Body() dto: AskAiDto) {
    return this.aiInsights.ask(req.user.id, dto.question, 'app');
  }

  @Get('metrics')
  async metrics(@Req() req: { user: { id: string } }) {
    return this.aiInsights.getUserMetrics(req.user.id);
  }
}

