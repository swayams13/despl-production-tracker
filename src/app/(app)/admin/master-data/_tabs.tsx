import { Tabs } from "@/components/industrial/tabs";

/** Parts · Materials · Sequence review · Import. Import is shown to those who may at least check a workbook. */
export function MasterDataTabs({ active, showImport }: { active: "parts" | "materials" | "sequence" | "import"; showImport: boolean }) {
  const items = [
    { key: "parts", label: "Parts", href: "/admin/master-data", active: active === "parts" },
    { key: "materials", label: "Materials", href: "/admin/master-data/materials", active: active === "materials" },
    { key: "sequence", label: "Sequence review", href: "/admin/master-data/sequence-review", active: active === "sequence" },
    ...(showImport ? [{ key: "import", label: "Import", href: "/admin/master-data/import", active: active === "import" }] : []),
  ];
  return (
    <div style={{ marginBottom: 12 }}>
      <Tabs items={items} />
    </div>
  );
}
