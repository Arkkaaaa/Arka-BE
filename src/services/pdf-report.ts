import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { AppError } from '../middleware/errors.js';
import type { GameService } from '../modules/game/game.service.js';
import type { ParticipantService } from '../modules/participant/participant.service.js';
import type {
  GameMetrics,
  GameMode,
  GameSessionDto,
  ParticipantDetailDto,
  ReportAudience,
} from '../schemas/index.js';
import type { AuditContext, AuditEvent } from './audit.js';

const PAGE = {
  left: 48,
  right: 48,
  top: 120,
  bottom: 76,
} as const;
const COLORS = {
  ink: '#183153',
  muted: '#667085',
  faint: '#F4F7FA',
  border: '#D9E2EC',
  yellow: '#F9C846',
  orange: '#F47B20',
  green: '#2B8A6E',
  blue: '#2878B5',
  red: '#C94C4C',
  white: '#FFFFFF',
} as const;
const FONT_FILES = {
  regular: 'nunito-latin-400-normal.woff',
  bold: 'nunito-latin-700-normal.woff',
  extraBold: 'nunito-latin-800-normal.woff',
} as const;
const FONT_NAMES = {
  regular: 'Nunito',
  bold: 'Nunito Bold',
  extraBold: 'Nunito ExtraBold',
} as const;
const MODE_LABELS: Readonly<Record<GameMode, string>> = {
  MOTOR_GRIP: 'Peras Jeruk',
  GO_NO_GO: 'Go-No-Go',
  SEQUENCE_MEMORY: 'Ding Dong Dong',
};

type ReportAuditWriter = (context: AuditContext, event: AuditEvent) => Promise<void>;
type MetricItem = { readonly label: string; readonly value: string };
type ReportHeader = {
  readonly audience: ReportAudience;
  readonly title: string;
  readonly institutionName: string;
};

export interface ReportRequestContext extends AuditContext {
  readonly institutionId: string;
  readonly institutionName: string;
}

function fontPath(file: string): string {
  return fileURLToPath(import.meta.resolve(`@fontsource/nunito/files/${file}`));
}

function createDocument(): PDFKit.PDFDocument {
  const document = new PDFDocument({
    autoFirstPage: false,
    bufferPages: true,
    compress: true,
    info: { Title: 'ARKA Report', Author: 'ARKA' },
  });
  document.registerFont(FONT_NAMES.regular, fontPath(FONT_FILES.regular));
  document.registerFont(FONT_NAMES.bold, fontPath(FONT_FILES.bold));
  document.registerFont(FONT_NAMES.extraBold, fontPath(FONT_FILES.extraBold));
  return document;
}

function addPage(document: PDFKit.PDFDocument): void {
  document.addPage({
    size: 'A4',
    margins: PAGE,
  });
}

function audienceLabel(audience: ReportAudience): string {
  return audience === 'participant' ? 'LAPORAN PERKEMBANGAN UNTUK PESERTA' : 'LAPORAN PERKEMBANGAN UNTUK DOKTER';
}

function formatDate(value: string | null): string {
  if (!value) return 'Tidak tersedia';
  return new Intl.DateTimeFormat('id-ID', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));
}

function formatNumber(value: number, maximumFractionDigits = 1): string {
  return new Intl.NumberFormat('id-ID', { maximumFractionDigits }).format(value);
}

function formatMilliseconds(value: number | null): string {
  return value === null ? 'Tidak tersedia' : `${formatNumber(value, 0)} ms`;
}

function drawHeaderAndFooter(document: PDFKit.PDFDocument, header: ReportHeader): void {
  const range = document.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    document.switchToPage(index);
    const width = document.page.width;
    const contentWidth = width - PAGE.left - PAGE.right;
    document.save();
    document.font(FONT_NAMES.extraBold).fontSize(8).fillColor(COLORS.orange).text(
      audienceLabel(header.audience),
      PAGE.left,
      28,
      { width: contentWidth - 90, lineBreak: false, ellipsis: true },
    );
    document.font(FONT_NAMES.bold).fontSize(12).fillColor(COLORS.ink).text(
      header.title,
      PAGE.left,
      46,
      { width: contentWidth - 90, lineBreak: false, ellipsis: true },
    );
    document.font(FONT_NAMES.regular).fontSize(8.5).fillColor(COLORS.muted).text(
      header.institutionName,
      PAGE.left,
      66,
      { width: contentWidth - 90, lineBreak: false, ellipsis: true },
    );
    document.font(FONT_NAMES.bold).fontSize(8.5).fillColor(COLORS.muted).text(
      `Halaman ${index - range.start + 1} dari ${range.count}`,
      width - PAGE.right - 86,
      46,
      { width: 86, align: 'right', lineBreak: false },
    );
    document.moveTo(PAGE.left, 94).lineTo(width - PAGE.right, 94).lineWidth(1).strokeColor(COLORS.border).stroke();
    const footerRuleY = document.page.height - 51;
    document.moveTo(PAGE.left, footerRuleY).lineTo(width - PAGE.right, footerRuleY).lineWidth(2).strokeColor(COLORS.yellow).stroke();
    document.font(FONT_NAMES.extraBold).fontSize(9).fillColor(COLORS.ink).text(
      'ARKA',
      PAGE.left,
      footerRuleY + 14,
      { width: 80, height: 12, lineBreak: false },
    );
    document.font(FONT_NAMES.regular).fontSize(8.5).fillColor(COLORS.muted).text(
      header.institutionName,
      PAGE.left + 100,
      footerRuleY + 14,
      { width: contentWidth - 100, height: 12, align: 'right', lineBreak: false, ellipsis: true },
    );
    document.restore();
  }
}

function bufferDocument(document: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    document.on('data', (chunk: Buffer | Uint8Array) => chunks.push(Buffer.from(chunk)));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
    document.end();
  });
}

function pageTitle(document: PDFKit.PDFDocument, eyebrow: string, title: string, subtitle?: string): void {
  document.font(FONT_NAMES.extraBold).fontSize(9).fillColor(COLORS.orange).text(eyebrow.toUpperCase());
  document.moveDown(0.45);
  document.font(FONT_NAMES.extraBold).fontSize(24).fillColor(COLORS.ink).text(title, { lineGap: 1 });
  if (subtitle) {
    document.moveDown(0.35);
    document.font(FONT_NAMES.regular).fontSize(10).fillColor(COLORS.muted).text(subtitle, { lineGap: 2 });
  }
  document.moveDown(1.1);
}

function sectionTitle(document: PDFKit.PDFDocument, title: string): void {
  document.font(FONT_NAMES.extraBold).fontSize(13).fillColor(COLORS.ink).text(title);
  document.moveDown(0.55);
}

function drawMetricCards(document: PDFKit.PDFDocument, items: readonly MetricItem[], columns = 3): void {
  const gap = 10;
  const width = document.page.width - PAGE.left - PAGE.right;
  const cardWidth = (width - gap * (columns - 1)) / columns;
  const cardHeight = 62;
  const startY = document.y;
  items.forEach((item, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = PAGE.left + column * (cardWidth + gap);
    const y = startY + row * (cardHeight + gap);
    document.roundedRect(x, y, cardWidth, cardHeight, 8).fillAndStroke(COLORS.faint, COLORS.border);
    document.font(FONT_NAMES.regular).fontSize(8).fillColor(COLORS.muted).text(item.label, x + 12, y + 11, {
      width: cardWidth - 24,
      lineBreak: false,
      ellipsis: true,
    });
    document.font(FONT_NAMES.extraBold).fontSize(15).fillColor(COLORS.ink).text(item.value, x + 12, y + 31, {
      width: cardWidth - 24,
      lineBreak: false,
      ellipsis: true,
    });
  });
  const rows = Math.ceil(items.length / columns);
  document.y = startY + rows * cardHeight + Math.max(0, rows - 1) * gap + 18;
}

function drawNarrative(document: PDFKit.PDFDocument, title: string, narrative: string | null): void {
  sectionTitle(document, title);
  const text = narrative?.trim() || 'Ringkasan belum tersedia.';
  document.font(FONT_NAMES.regular).fontSize(10.5).fillColor(COLORS.ink).text(text, {
    width: document.page.width - PAGE.left - PAGE.right,
    lineGap: 4,
  });
}

function participantNarrative(
  participant: ParticipantDetailDto,
  audience: ReportAudience,
): string | null {
  if (!participant.aggregateSummary) return null;
  return audience === 'participant'
    ? participant.aggregateSummary.participantSummary
    : participant.aggregateSummary.clinicianSummary;
}

function modeNarrative(
  summary: ParticipantDetailDto['modeSummaries'][number],
  audience: ReportAudience,
): string | null {
  if (!summary.narrativeSummary) return null;
  return audience === 'participant'
    ? summary.narrativeSummary.participantSummary
    : summary.narrativeSummary.clinicianSummary;
}

function participantModeMetrics(
  summary: ParticipantDetailDto['modeSummaries'][number],
): MetricItem[] {
  const metrics = summary.overallMetrics;
  const base: MetricItem[] = [
    { label: 'Jumlah permainan', value: formatNumber(summary.savedSessionsTotal, 0) },
    { label: 'Skor terbaru', value: summary.latestSession ? formatNumber(summary.latestSession.score, 0) : 'Belum ada' },
    { label: 'Rata-rata skor', value: metrics ? formatNumber(metrics.averageScore, 0) : 'Belum ada' },
  ];
  if (!metrics) return base;
  if (metrics.mode === 'MOTOR_GRIP') {
    return [
      ...base,
      { label: 'Rata-rata puncak', value: `${formatNumber(metrics.averagePeakKilograms)} kg` },
      { label: 'Rata-rata kekuatan', value: `${formatNumber(metrics.averageKilograms)} kg` },
      { label: 'Rata-rata tahan kontinu', value: formatMilliseconds(metrics.averageContinuousHoldMs) },
    ];
  }
  if (metrics.mode === 'GO_NO_GO') {
    return [
      ...base,
      { label: 'Rata-rata akurasi', value: `${formatNumber(metrics.averageAccuracyPercent)}%` },
      { label: 'Rata-rata reaksi', value: formatMilliseconds(metrics.averageReactionMs) },
      { label: 'Total percobaan', value: formatNumber(metrics.totalTrials, 0) },
      { label: 'Respons tepat', value: formatNumber(metrics.totalHits + metrics.totalCorrectRejections, 0) },
      { label: 'Respons keliru', value: formatNumber(metrics.totalMisses + metrics.totalFalsePositives, 0) },
    ];
  }
  return [
    ...base,
    { label: 'Rata-rata rentang memori', value: formatNumber(metrics.averageMemorySpan) },
    { label: 'Rata-rata respons pertama', value: formatMilliseconds(metrics.averageFirstResponseMs) },
    { label: 'Level terukur', value: formatNumber(metrics.levelLatencies.length, 0) },
  ];
}

function sessionMetricItems(metrics: GameMetrics, score: number): MetricItem[] {
  const base = [{ label: 'Skor', value: formatNumber(score, 0) }];
  if (metrics.mode === 'MOTOR_GRIP') {
    return [
      ...base,
      { label: 'Puncak kekuatan', value: `${formatNumber(metrics.peakKilograms)} kg` },
      { label: 'Rata-rata kekuatan', value: `${formatNumber(metrics.averageKilograms)} kg` },
      { label: 'Target', value: `${formatNumber(metrics.targetKilograms)} kg` },
      { label: 'Tahan kontinu', value: formatMilliseconds(metrics.continuousHoldMs) },
      { label: 'Target tercapai', value: metrics.targetCompleted ? 'Ya' : 'Belum' },
    ];
  }
  if (metrics.mode === 'GO_NO_GO') {
    return [
      ...base,
      { label: 'Akurasi', value: `${formatNumber(metrics.accuracyPercent)}%` },
      { label: 'Rata-rata reaksi', value: formatMilliseconds(metrics.meanHitReactionMs) },
      { label: 'Respons tepat', value: formatNumber(metrics.hits + metrics.correctRejections, 0) },
      { label: 'Terlewat', value: formatNumber(metrics.misses, 0) },
      { label: 'Respons tidak tepat', value: formatNumber(metrics.falsePositives, 0) },
    ];
  }
  return [
    ...base,
    { label: 'Rentang memori', value: formatNumber(metrics.maxSequenceLength, 0) },
    { label: 'Level selesai', value: formatNumber(metrics.completedLevels, 0) },
    { label: 'Respons pertama', value: formatMilliseconds(metrics.meanFirstResponseMs) },
    { label: 'Percobaan keliru', value: formatNumber(metrics.wrongAttempts, 0) },
    { label: 'Kehabisan waktu', value: formatNumber(metrics.timedOutAttempts, 0) },
  ];
}

function renderParticipantContent(
  document: PDFKit.PDFDocument,
  participant: ParticipantDetailDto,
  audience: ReportAudience,
): void {
  addPage(document);
  pageTitle(document, 'Ringkasan keseluruhan', 'Laporan Perkembangan Peserta', participant.displayName);
  drawMetricCards(document, participant.modeSummaries.map((summary) => ({
    label: MODE_LABELS[summary.mode],
    value: summary.overallMetrics ? formatNumber(summary.overallMetrics.averageScore, 0) : 'Belum ada',
  })));
  drawNarrative(document, 'Ringkasan keseluruhan', participantNarrative(participant, audience));

  for (const mode of ['MOTOR_GRIP', 'GO_NO_GO', 'SEQUENCE_MEMORY'] as const) {
    const summary = participant.modeSummaries.find((item) => item.mode === mode);
    addPage(document);
    pageTitle(
      document,
      'Perkembangan per permainan',
      MODE_LABELS[mode],
      summary?.latestSession
        ? `Sesi terbaru ${formatDate(summary.latestSession.completedAt)}`
        : 'Belum ada sesi tersimpan',
    );
    if (!summary) {
      drawNarrative(document, 'Ringkasan permainan', null);
      continue;
    }
    drawMetricCards(document, participantModeMetrics(summary));
    drawNarrative(document, 'Ringkasan permainan', modeNarrative(summary, audience));
  }
}

function selectedSessionSummary(
  session: GameSessionDto,
  audience: ReportAudience,
): { readonly summary: string | null; readonly observations: readonly string[] } {
  const aiSummary = session.result?.aiSummary;
  if (!aiSummary || aiSummary.status !== 'READY') return { summary: null, observations: [] };
  const selected = audience === 'participant' ? aiSummary.participant : aiSummary.clinician;
  return { summary: selected.summaryText, observations: selected.observations };
}

function drawObservations(document: PDFKit.PDFDocument, observations: readonly string[]): void {
  sectionTitle(document, 'Observasi');
  if (observations.length === 0) {
    document.font(FONT_NAMES.regular).fontSize(10.5).fillColor(COLORS.muted).text('Observasi belum tersedia.');
    return;
  }
  for (const observation of observations) {
    document.circle(PAGE.left + 4, document.y + 6, 2.5).fill(COLORS.yellow);
    document.font(FONT_NAMES.regular).fontSize(10).fillColor(COLORS.ink).text(observation, PAGE.left + 16, document.y, {
      width: document.page.width - PAGE.left - PAGE.right - 16,
      lineGap: 2,
    });
    document.moveDown(0.55);
  }
}

function drawBarChart(
  document: PDFKit.PDFDocument,
  title: string,
  items: readonly { readonly label: string; readonly value: number; readonly display: string; readonly color: string }[],
  maximum?: number,
): void {
  sectionTitle(document, title);
  const chartX = PAGE.left + 112;
  const chartWidth = document.page.width - PAGE.right - chartX - 54;
  const startY = document.y + 8;
  const max = maximum ?? Math.max(1, ...items.map((item) => item.value));
  items.forEach((item, index) => {
    const y = startY + index * 52;
    document.font(FONT_NAMES.bold).fontSize(9).fillColor(COLORS.ink).text(item.label, PAGE.left, y + 7, {
      width: 100,
      align: 'right',
      lineBreak: false,
      ellipsis: true,
    });
    document.roundedRect(chartX, y, chartWidth, 26, 5).fill(COLORS.faint);
    const fillWidth = item.value <= 0 ? 0 : Math.max(3, Math.min(chartWidth, (item.value / max) * chartWidth));
    if (fillWidth > 0) document.roundedRect(chartX, y, fillWidth, 26, 5).fill(item.color);
    document.font(FONT_NAMES.extraBold).fontSize(9).fillColor(COLORS.ink).text(item.display, chartX + chartWidth + 8, y + 7, {
      width: 46,
      align: 'right',
      lineBreak: false,
      ellipsis: true,
    });
  });
  document.y = startY + items.length * 52 + 8;
}

function drawGripChart(document: PDFKit.PDFDocument, metrics: Extract<GameMetrics, { mode: 'MOTOR_GRIP' }>): void {
  sectionTitle(document, 'Kekuatan genggam sepanjang sesi');
  const x = PAGE.left + 34;
  const y = document.y + 16;
  const width = document.page.width - PAGE.left - PAGE.right - 48;
  const height = 250;
  const samples = metrics.gripSamples;
  const maximum = Math.max(metrics.targetKilograms, metrics.peakKilograms, ...samples.map((sample) => sample.kilograms), 1);
  document.rect(x, y, width, height).fillAndStroke(COLORS.faint, COLORS.border);
  for (let index = 0; index <= 4; index += 1) {
    const gridY = y + (height / 4) * index;
    document.moveTo(x, gridY).lineTo(x + width, gridY).lineWidth(0.5).strokeColor(COLORS.border).stroke();
    const value = maximum * (1 - index / 4);
    document.font(FONT_NAMES.regular).fontSize(8).fillColor(COLORS.muted).text(`${formatNumber(value)} kg`, PAGE.left, gridY - 4, {
      width: 28,
      align: 'right',
      lineBreak: false,
    });
  }
  const targetY = y + height - (metrics.targetKilograms / maximum) * height;
  document.moveTo(x, targetY).lineTo(x + width, targetY).dash(4, { space: 3 }).lineWidth(1.5).strokeColor(COLORS.orange).stroke().undash();
  if (samples.length > 1) {
    samples.forEach((sample, index) => {
      const pointX = x + (index / (samples.length - 1)) * width;
      const pointY = y + height - (sample.kilograms / maximum) * height;
      if (index === 0) document.moveTo(pointX, pointY);
      else document.lineTo(pointX, pointY);
    });
    document.lineWidth(2.5).strokeColor(COLORS.blue).stroke();
  } else {
    const peakHeight = (metrics.peakKilograms / maximum) * height;
    document.roundedRect(x + width / 2 - 36, y + height - peakHeight, 72, peakHeight, 5).fill(COLORS.blue);
  }
  document.font(FONT_NAMES.bold).fontSize(8.5).fillColor(COLORS.orange).text(
    `Target ${formatNumber(metrics.targetKilograms)} kg`,
    x + width - 120,
    targetY - 15,
    { width: 116, align: 'right', lineBreak: false },
  );
  document.font(FONT_NAMES.regular).fontSize(8.5).fillColor(COLORS.muted).text('Awal sesi', x, y + height + 12, { lineBreak: false });
  document.text('Akhir sesi', x + width - 70, y + height + 12, { width: 70, align: 'right', lineBreak: false });
  document.y = y + height + 46;
}

function renderSessionVisual(document: PDFKit.PDFDocument, metrics: GameMetrics): void {
  if (metrics.mode === 'MOTOR_GRIP') {
    drawGripChart(document, metrics);
    return;
  }
  if (metrics.mode === 'GO_NO_GO') {
    drawBarChart(document, 'Distribusi respons', [
      { label: 'Tepat sasaran', value: metrics.hits, display: formatNumber(metrics.hits, 0), color: COLORS.green },
      { label: 'Penolakan tepat', value: metrics.correctRejections, display: formatNumber(metrics.correctRejections, 0), color: COLORS.blue },
      { label: 'Terlewat', value: metrics.misses, display: formatNumber(metrics.misses, 0), color: COLORS.orange },
      { label: 'Respons keliru', value: metrics.falsePositives, display: formatNumber(metrics.falsePositives, 0), color: COLORS.red },
    ], metrics.totalTrials);
    return;
  }
  const latencyItems = metrics.levelLatencies.map((point) => ({
    label: `Level ${point.level}`,
    value: point.latencyMs,
    display: `${formatNumber(point.latencyMs, 0)} ms`,
    color: COLORS.blue,
  }));
  if (latencyItems.length > 0) {
    drawBarChart(document, 'Waktu respons per level', latencyItems);
  } else {
    drawNarrative(document, 'Waktu respons per level', 'Data latensi per level belum tersedia.');
  }
}

function renderSessionContent(
  document: PDFKit.PDFDocument,
  session: GameSessionDto,
  audience: ReportAudience,
): void {
  const result = session.result;
  if (!result) throw new AppError(409, 'report_unavailable', 'Laporan belum tersedia.');
  const selected = selectedSessionSummary(session, audience);
  addPage(document);
  pageTitle(
    document,
    'Hasil sesi',
    MODE_LABELS[session.mode],
    `${session.displayName} · Disimpan ${formatDate(result.savedAt)}`,
  );
  drawMetricCards(document, sessionMetricItems(result.metrics, result.score));
  drawNarrative(document, 'Ringkasan sesi', selected.summary);
  document.moveDown(1.1);
  drawObservations(document, selected.observations);

  addPage(document);
  pageTitle(document, 'Visualisasi sesi', MODE_LABELS[session.mode], 'Data tersimpan dari sesi permainan');
  renderSessionVisual(document, result.metrics);
}

async function participantPdf(
  participant: ParticipantDetailDto,
  audience: ReportAudience,
  institutionName: string,
): Promise<Buffer> {
  const document = createDocument();
  renderParticipantContent(document, participant, audience);
  drawHeaderAndFooter(document, {
    audience,
    title: `Peserta · ${participant.displayName}`,
    institutionName,
  });
  return bufferDocument(document);
}

async function sessionPdf(
  session: GameSessionDto,
  audience: ReportAudience,
  institutionName: string,
): Promise<Buffer> {
  const document = createDocument();
  renderSessionContent(document, session, audience);
  drawHeaderAndFooter(document, {
    audience,
    title: `${MODE_LABELS[session.mode]} · ${session.displayName}`,
    institutionName,
  });
  return bufferDocument(document);
}

export class PdfReportService {
  public constructor(
    private readonly participantService: ParticipantService,
    private readonly gameService: GameService,
    private readonly writeAudit: ReportAuditWriter,
  ) {}

  public async participantReport(
    context: ReportRequestContext,
    participantId: string,
    audience: ReportAudience,
  ): Promise<Buffer> {
    const participant = await this.participantService.getParticipant(context.institutionId, participantId);
    const report = await participantPdf(participant, audience, context.institutionName);
    await this.writeAudit(context, {
      action: 'PARTICIPANT_REPORT_EXPORTED',
      targetType: 'Participant',
      targetId: participantId,
      metadata: { audience, format: 'pdf' },
    });
    return report;
  }

  public async sessionReport(
    context: ReportRequestContext,
    sessionId: string,
    audience: ReportAudience,
  ): Promise<Buffer> {
    const session = await this.gameService.getSession(context.institutionId, sessionId);
    if (session.status !== 'SAVED' || !session.result) {
      throw new AppError(409, 'report_unavailable', 'Laporan hanya tersedia untuk sesi yang sudah tersimpan.');
    }
    const report = await sessionPdf(session, audience, context.institutionName);
    await this.writeAudit(context, {
      action: 'GAME_SESSION_REPORT_EXPORTED',
      targetType: 'GameSession',
      targetId: sessionId,
      metadata: { audience, format: 'pdf' },
    });
    return report;
  }
}
