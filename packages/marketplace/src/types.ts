export type CatalogItemKind = "skill" | "plugin";

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  kind: CatalogItemKind;
  repo: string;
  subdir?: string;
  tags?: string[];
}
