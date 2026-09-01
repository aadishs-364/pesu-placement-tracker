import type { PrismaClient } from "../../../generated/prisma/client.js";
import type { OfferCycle, OfferNature, RoleFamily } from "@/generated/prisma/enums";
import { deriveCompensation, type TaxRegime } from "@/lib/comp/model";
import type { ImportedRole } from "../sheets/types";

/**
 * Expanding a published headcount into the offer rows it stands for.
 *
 * The sheets say "IBM placed 88". The app's entire analytics story is built on
 * students filing their own offers, and we cannot ask the 2022 cohort to come
 * back and re-submit — so the sheet stands in for them, in their format. 88
 * becomes 88 `Offer` rows rather than the integer 88 on a `DriveRole` column.
 *
 * What we do NOT know is identity: which student each row refers to. That is
 * what `Offer.studentId` being nullable already encodes, and why nothing here
 * invents a `Student` to hang the row off. A fabricated student would be
 * counted as a person by every query that counts people.
 *
 * This is the "import-mode sibling" of `createOffer`. It deliberately does not
 * call it: `createOffer` rate-limits on `student.id`, checks the submitter's
 * `graduationYear` against the batch, runs the per-student quota, and refuses
 * an archived batch — four rules that all presuppose a real submitter. Rather
 * than thread a bypass flag through each of them (and risk that flag ever being
 * reachable from the form), the two paths stay separate and share the parts
 * that matter: the same compensation derivation, the same tier, the same table.
 */

/** Each headcount column is a different kind of offer, not a different count of one. */
const NATURE_BY_COLUMN = {
  placedInternship: "INTERNSHIP_ONLY",
  placedFte: "FTE_ONLY",
  placedBoth: "INTERNSHIP_PLUS_FTE",
} as const satisfies Record<string, OfferNature>;

export type ExpandArgs = {
  role: ImportedRole;
  driveRoleId: string;
  companyId: string;
  batchId: string;
  cycle: OfferCycle;
  tierKey: string | null;
  roleFamily: RoleFamily;
  regime: TaxRegime | null;
  eligibleBranches: string[];
  announcedCgpaCutoff: number | null;
};

/**
 * Reads the tax regime once per import rather than once per offer. The figures
 * are identical for every row in a run, and `deriveCompensation` is pure.
 */
export async function loadTaxRegimeFor(prisma: PrismaClient): Promise<TaxRegime | null> {
  const row = await prisma.taxRegimeConfig.findFirst({ orderBy: { financialYear: "desc" } });
  if (!row) return null;

  const slabs = (Array.isArray(row.slabs) ? row.slabs : [])
    .map((slab) => {
      const record = slab as Record<string, unknown>;
      const rate = record["ratePercent"];
      if (typeof rate !== "number") return null;
      const upTo = record["upToLpa"];
      return { upToLpa: typeof upTo === "number" ? upTo : null, ratePercent: rate };
    })
    .filter((slab): slab is { upToLpa: number | null; ratePercent: number } => slab !== null);

  return {
    financialYear: row.financialYear,
    slabs,
    standardDeductionInr: Number(row.standardDeductionInr),
    employeePfPercent: Number(row.employeePfPercent),
    cessPercent: Number(row.cessPercent),
    professionalTaxInr: Number(row.professionalTaxInr),
    rebateThresholdInr:
      row.rebateThresholdInr === null ? null : Number(row.rebateThresholdInr),
  };
}

/**
 * Creates one offer row per placed student for a single drive role.
 *
 * Returns the number of rows written. A role with no headcount at all writes
 * nothing: "we don't know how many" and "nobody" are different answers, and
 * only the second one is a placement of zero students.
 */
export async function expandRoleIntoOffers(
  prisma: PrismaClient,
  args: ExpandArgs,
): Promise<number> {
  const { role } = args;

  const derived = deriveCompensation(
    {
      baseLpa: role.baseLpa,
      ctcLpa: role.ctcLpa,
      components: role.components.map((component) => ({
        kind: component.kind,
        amount: component.amount,
        currency: component.currency,
        isLpa: component.isLpa,
        isOneTime: component.isOneTime,
        isCash: component.isCash,
        vestingYears: component.vestingYears,
      })),
    },
    args.regime,
  );

  let written = 0;

  for (const [column, nature] of Object.entries(NATURE_BY_COLUMN) as Array<
    [keyof typeof NATURE_BY_COLUMN, OfferNature]
  >) {
    const count = role[column];
    if (count === null || count <= 0) continue;

    for (let index = 0; index < count; index += 1) {
      // Each offer owns its compensation row: `Offer.compensationId` is unique,
      // so these cannot share one the way merged DriveRole cells do. That means
      // one published package becomes `count` identical rows — which is exactly
      // why `source` has to be the discriminator in the analytics layer. These
      // are one observation wearing `count` hats, not `count` observations.
      const compensation = await prisma.compensationPackage.create({
        data: {
          stipendPerMonthInr: role.stipendPerMonthInr,
          baseLpa: role.baseLpa,
          ctcLpa: role.ctcLpa,
          disclosure: role.disclosure,
          rawNote: role.compensationNote,
          firstYearCashLpa: derived.firstYearCashLpa,
          steadyStateCashLpa: derived.steadyStateCashLpa,
          estimatedInHandMonthlyInr: derived.estimatedInHandMonthlyInr,
          ctcInflationRatio: derived.ctcInflationRatio,
          computedForFinancialYear: args.regime?.financialYear ?? null,
          computedAt: new Date(),
          components: {
            create: role.components.map((component) => ({
              kind: component.kind,
              amount: component.amount,
              currency: component.currency,
              isLpa: component.isLpa,
              isOneTime: component.isOneTime,
              isCash: component.isCash,
              vestingYears: component.vestingYears,
              note: component.note,
            })),
          },
        },
      });

      await prisma.offer.create({
        data: {
          compensationId: compensation.id,

          // The row this stands for has no owning student, and must never be
          // given one. See the comment on Offer.studentId.
          studentId: null,
          source: "OFFICIAL_IMPORT",

          companyId: args.companyId,
          batchId: args.batchId,
          driveRoleId: args.driveRoleId,

          // The sheets frequently leave the role blank. The fallback matches
          // what the DriveRole already stores for the same row, so the offer
          // and the drive role never disagree about what the role was called.
          roleTitle: role.title ?? "Unspecified role",
          roleFamily: args.roleFamily,
          cycle: args.cycle,
          nature,
          tierKey: args.tierKey,

          // A placement sheet records placements, not pending decisions: the
          // student named in that headcount took the offer.
          acceptanceStatus: "ACCEPTED",

          locations: role.locations,
          bondMonths: role.bondMonths,
          internshipDurationMonths: role.internshipDurationMonths,
          announcedCgpaCutoff: args.announcedCgpaCutoff,
          eligibleBranches: args.eligibleBranches,

          // Everything below is a property of a person, and a headcount has no
          // person: no CGPA, no branch, no backlogs, no name to show.
          cgpa: null,
          cgpaBand: null,
          branchId: null,
          nameVisibility: "ANONYMOUS",

          // Not run through detectOutlier: an imported row IS the published
          // figure, so flagging it against itself is meaningless. Corroboration
          // skips it too — recomputeCorroboration already filters to
          // SELF_REPORTED, so these rows neither gain nor grant confidence.
          verification: "UNVERIFIED",
          isOutlierFlagged: false,
        },
      });

      written += 1;
    }
  }

  return written;
}
