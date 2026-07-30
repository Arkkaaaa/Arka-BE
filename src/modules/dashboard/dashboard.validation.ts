import {
  DashboardActivityDtoSchema,
  DashboardProgressDtoSchema,
  DashboardSummaryDtoSchema,
} from '../../schemas/index.js';
import type { z } from 'zod';

export { DashboardActivityDtoSchema, DashboardProgressDtoSchema, DashboardSummaryDtoSchema };
export type DashboardSummaryDto = z.infer<typeof DashboardSummaryDtoSchema>;
export type DashboardActivityDto = z.infer<typeof DashboardActivityDtoSchema>;
export type DashboardProgressDto = z.infer<typeof DashboardProgressDtoSchema>;
