/**
 * Dev seed: one clinic, one dentist, a few procedures and the Odontoprev plan.
 * Fictitious data only. Prints DEFAULT_CLINIC_ID to put in .env.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const clinic = await db.clinic.upsert({
  where: { id: "clinic_dev" },
  create: { id: "clinic_dev", name: "Clínica Odontológica Exemplo", address: "Rua Exemplo, 123" },
  update: {},
});

const dentist = await db.dentist.upsert({
  where: { id: "dentist_dev" },
  create: { id: "dentist_dev", clinicId: clinic.id, name: "Dra. Exemplo", cro: "CRO-SP 00000" },
  update: {},
});

const procedures = [
  { name: "Avaliação", durationMinutes: 30, priceCents: null },
  { name: "Limpeza (profilaxia)", durationMinutes: 45, priceCents: 25000 },
  { name: "Restauração em resina", durationMinutes: 60, priceCents: 35000 },
  { name: "Tratamento de canal", durationMinutes: 90, priceCents: 120000 },
  { name: "Extração simples", durationMinutes: 45, priceCents: 30000 },
  { name: "Clareamento", durationMinutes: 60, priceCents: 90000 },
];
for (const p of procedures) {
  await db.procedure.upsert({
    where: { clinicId_name: { clinicId: clinic.id, name: p.name } },
    create: { clinicId: clinic.id, ...p },
    update: {},
  });
}

const odontoprev = await db.insurancePlan.upsert({
  where: { clinicId_name: { clinicId: clinic.id, name: "Odontoprev" } },
  create: { clinicId: clinic.id, name: "Odontoprev" },
  update: {},
});

// Coverage examples only: the clinic must fill the real table during onboarding.
for (const name of [
  "Avaliação",
  "Limpeza (profilaxia)",
  "Restauração em resina",
  "Extração simples",
]) {
  const proc = await db.procedure.findUniqueOrThrow({
    where: { clinicId_name: { clinicId: clinic.id, name } },
  });
  await db.insuranceCoverage.upsert({
    where: {
      insurancePlanId_procedureId: { insurancePlanId: odontoprev.id, procedureId: proc.id },
    },
    create: { insurancePlanId: odontoprev.id, procedureId: proc.id },
    update: {},
  });
}

// Mon-Fri 8h-12h and 13h-18h.
await db.workingHours.deleteMany({ where: { dentistId: dentist.id } });
for (let weekday = 1; weekday <= 5; weekday++) {
  await db.workingHours.createMany({
    data: [
      { dentistId: dentist.id, weekday, startMinute: 8 * 60, endMinute: 12 * 60 },
      { dentistId: dentist.id, weekday, startMinute: 13 * 60, endMinute: 18 * 60 },
    ],
  });
}

console.log(`Seed ok. DEFAULT_CLINIC_ID=${clinic.id}`);
await db.$disconnect();
