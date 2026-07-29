import { DashboardSummaryDtoSchema } from '../../schemas/index.js';
import type { z } from 'zod';

export { DashboardSummaryDtoSchema };
export type DashboardSummaryDto = z.infer<typeof DashboardSummaryDtoSchema>;
