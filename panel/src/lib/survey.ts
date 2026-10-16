/** Display helpers for the satisfaction survey. Data comes from GET /admin/surveys. */

export type SurveySummary = {
  month: {
    sent: number;
    answers: number;
    average: number | null;
    /** Answers per rating, index 0 = rating 1. */
    byRating: [number, number, number, number, number];
  };
  low: Array<{
    surveyId: string;
    patientId: string;
    patientName: string;
    patientPhone: string;
    rating: number;
    answeredAt: string;
    appointmentAt: string;
  }>;
};

/** Same labels as the buttons of the pesquisa_satisfacao template. */
export const RATING_LABEL: Record<number, string> = {
  5: "5 - Excelente",
  4: "4 - Bom",
  3: "3 - Regular",
  2: "2 - Ruim",
  1: "1 - Péssimo",
};

/** "4,6" or "-" without answers. */
export function averageLabel(average: number | null): string {
  return average === null ? "-" : average.toFixed(1).replace(".", ",");
}

/** Share of the surveys sent this month that got a rating, in whole percent; null if none. */
export function answerRate(month: SurveySummary["month"]): number | null {
  return month.sent === 0 ? null : Math.round((month.answers / month.sent) * 100);
}
