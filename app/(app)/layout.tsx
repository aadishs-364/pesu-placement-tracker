import { prisma } from "@/lib/db";
import { getCurrentStudent } from "@/lib/auth/rbac";
import { roleAtLeast } from "@/lib/auth/rbac";
import { Sidebar } from "@/components/shell/sidebar";

export const dynamic = "force-dynamic";

/**
 * The application shell.
 *
 * Every screen renders inside this, so navigation is persistent and a page
 * change never costs the sidebar, the batch selection, or the scroll position
 * of the nav.
 *
 * The shell does NOT require a session. Reading the tracker is open to anyone —
 * the figures here are cohort aggregates that are already suppressed below a
 * minimum group size, and a placement page nobody can open before signing in is
 * a placement page nobody reads. Signing in is what it takes to *add* to it, so
 * the gate sits on /submit, /me and /admin rather than on the whole group.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const student = await getCurrentStudent();

  const [batches, branch, pendingReports] = await Promise.all([
    prisma.batch.findMany({ orderBy: { year: "desc" }, select: { year: true } }),
    student?.branchId
      ? prisma.branch.findUnique({ where: { id: student.branchId }, select: { code: true } })
      : null,
    student && roleAtLeast(student.role, "ADMIN")
      ? prisma.report.count({ where: { status: { in: ["OPEN", "UNDER_REVIEW"] } } })
      : 0,
  ]);

  const years = batches.map((batch) => batch.year);
  const fallbackYear = years[0] ?? new Date().getFullYear();

  return (
    <div className="min-h-dvh">
      <Sidebar
        batches={years}
        activeBatch={student?.graduationYear ?? fallbackYear}
        student={
          student
            ? {
                name: student.name,
                srn: student.srn,
                role: student.role,
                branch: branch?.code ?? null,
              }
            : null
        }
        pendingReportCount={pendingReports}
      />
      <div className="lg:pl-[236px]">{children}</div>
    </div>
  );
}
