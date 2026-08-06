export const AI_SUMMARY_AUDIENCE_PROMPTS = {
  session: {
    participant:
      'Untuk peserta, isi participant.summaryText dengan 3 sampai 4 kalimat dan maksimal 600 karakter: tulis narasi yang hangat, mudah dipahami, menyebut capaian angka, menjelaskan maknanya dalam konteks permainan, lalu beri semangat dan fokus bermain berikutnya yang realistis.',
    doctor:
      'Untuk dokter, isi clinician.summaryText dengan 4 sampai 5 kalimat dan maksimal 650 karakter: analisis hubungan antarmetrik secara lebih tajam, termasuk konsistensi, ketepatan, kecepatan, atau kestabilan performa permainan; bandingkan angka yang tersedia dan sebutkan pola serta fokus permainan berikutnya yang dapat diamati.',
  },
  mode: {
    participant:
      'Untuk peserta, isi participantSummary dengan 3 sampai 4 kalimat dan maksimal 650 karakter: jelaskan capaian angka, maknanya dalam permainan, pola yang terlihat, lalu beri semangat dan fokus bermain berikutnya yang realistis.',
    doctor:
      'Untuk dokter, isi clinicianSummary dengan 4 sampai 5 kalimat dan maksimal 900 karakter: analisis hubungan skor, ketepatan, kekuatan, kecepatan, atau kestabilan yang tersedia; jelaskan pola serta fokus pengamatan sesi berikutnya.',
  },
  aggregate: {
    participant:
      'Untuk peserta, isi participantSummary dengan 3 sampai 4 kalimat dan maksimal 650 karakter, hangat dan mudah dipahami, menjelaskan arti angka pada Peras Jeruk, Go-No-Go, dan Ding Dong Dong, lalu memberi semangat serta arahan bermain nonmedis yang realistis.',
    doctor:
      'Untuk dokter, isi clinicianSummary dengan 4 sampai 5 kalimat dan maksimal 900 karakter, analitis dan padat: hubungkan kekuatan dan kestabilan genggaman, akurasi dan waktu respons, rentang ingatan dan respons pertama; soroti pola yang relatif kuat atau perlu dipantau pada sesi berikutnya berdasarkan angka.',
  },
} as const;

export const SESSION_SUMMARY_SYSTEM_PROMPT = [
  'Tulis dua ringkasan hasil permainan dalam bahasa Indonesia berdasarkan hanya metrik agregat yang diberikan.',
  'Balas JSON ketat sesuai skema dengan participant dan clinician, masing-masing berisi summaryText dan observations paling banyak tiga pengamatan.',
  AI_SUMMARY_AUDIENCE_PROMPTS.session.participant,
  AI_SUMMARY_AUDIENCE_PROMPTS.session.doctor,
  'Jangan menyimpulkan fungsi kognitif, kondisi tubuh, atau kemampuan di luar permainan; jangan memakai kata sempurna, terjamin, atau mengindikasikan.',
  'Semua teks wajib faktual, menyebut angka dan nama metrik yang tersedia, tanpa markdown.',
  'Jangan menyebut atau menebak identitas, diagnosis, kondisi medis, risiko klinis, terapi, pengobatan, atau tindakan medis.',
  'Semua nama field teknis wajib diterjemahkan ke bahasa Indonesia alami: maxSequenceLength menjadi panjang urutan maksimum, wrongAttempts menjadi percobaan salah, timedOutAttempts menjadi percobaan kehabisan waktu, multiButtonAttempts menjadi percobaan tombol ganda, meanFirstResponseMs menjadi rata-rata respons pertama, meanInterButtonMs menjadi rata-rata jeda antar tombol, dan LEVEL_CAP_REACHED menjadi semua level selesai.',
  'Jangan menulis nama field camelCase, snake_case, kode enum, atau istilah motor grip.',
  'Setiap summaryText dan setiap item observations wajib secara mandiri memuat sedikitnya satu digit angka; tulis 0 dan jangan menggantinya dengan frasa tidak ada atau nol.',
].join(' ');

export const PARTICIPANT_MODE_SYSTEM_PROMPT = [
  'Tulis ringkasan perkembangan satu mode permainan dalam bahasa Indonesia berdasarkan hanya statistik agregat mode tersebut.',
  'Balas JSON ketat dengan participantSummary dan clinicianSummary.',
  AI_SUMMARY_AUDIENCE_PROMPTS.mode.participant,
  AI_SUMMARY_AUDIENCE_PROMPTS.mode.doctor,
  'Jangan membahas mode lain yang tidak ada di input. Jangan menyebut identitas, diagnosis, kondisi medis, risiko klinis, terapi, pengobatan, atau tindakan medis.',
  'Jangan mengarang angka. Setiap paragraf wajib menyebut angka dari input dan menggunakan istilah bahasa Indonesia alami, tanpa markdown atau nama field teknis.',
].join(' ');

export const PARTICIPANT_AGGREGATE_SYSTEM_PROMPT = [
  'Tulis ringkasan perkembangan keseluruhan peserta dalam bahasa Indonesia berdasarkan hanya statistik agregat lintas permainan.',
  'Balas JSON ketat dengan participantSummary dan clinicianSummary.',
  AI_SUMMARY_AUDIENCE_PROMPTS.aggregate.participant,
  AI_SUMMARY_AUDIENCE_PROMPTS.aggregate.doctor,
  'Jangan menyebut identitas, diagnosis, kondisi medis, risiko klinis, terapi, pengobatan, atau tindakan medis.',
  'Jangan mengarang angka. Setiap paragraf wajib menyebut angka dari input dan menggunakan istilah bahasa Indonesia alami, tanpa markdown atau nama field teknis.',
].join(' ');

export function sessionSummaryUserPrompt(data: unknown): string {
  return `Data agregat sesi: ${JSON.stringify(data)}`;
}

export function participantModeUserPrompt(data: unknown): string {
  return `Statistik agregat satu mode: ${JSON.stringify(data)}`;
}

export function participantAggregateUserPrompt(data: unknown): string {
  return `Statistik agregat lintas permainan: ${JSON.stringify(data)}`;
}
