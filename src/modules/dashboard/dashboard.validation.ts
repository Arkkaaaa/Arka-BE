import { DashboardActivityDtoSchema, DashboardSummaryDtoSchema } from '../../schemas/index.js';
import type { z } from 'zod';

export { DashboardActivityDtoSchema, DashboardSummaryDtoSchema };
export type DashboardSummaryDto = z.infer<typeof DashboardSummaryDtoSchema>;
export type DashboardActivityDto = z.infer<typeof DashboardActivityDtoSchema>;
