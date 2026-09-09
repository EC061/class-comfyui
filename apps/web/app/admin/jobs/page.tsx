import { Jobs } from "@/components/jobs";
export default async function Page({ searchParams }: { searchParams: Promise<{ classId?: string; userId?: string }> }) {
  const filters = await searchParams;
  return <Jobs classId={filters.classId} userId={filters.userId} />;
}
