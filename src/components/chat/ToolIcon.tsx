import {
  Archive,
  Brain,
  FilePen,
  FileText,
  FolderTree,
  Globe,
  Globe2,
  Layers,
  Network,
  Search,
  Stethoscope,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";

const MAP: Record<string, LucideIcon> = {
  "folder-tree": FolderTree,
  "file-text": FileText,
  "file-pen": FilePen,
  terminal: Terminal,
  search: Search,
  stethoscope: Stethoscope,
  layers: Layers,
  archive: Archive,
  brain: Brain,
  globe: Globe,
  "globe-search": Globe2,
  network: Network,
  wrench: Wrench,
};

export function ToolIcon({ name, className, size = 13 }: { name: string; className?: string; size?: number }) {
  const Icon = MAP[name] ?? Wrench;
  return <Icon size={size} className={className} />;
}
