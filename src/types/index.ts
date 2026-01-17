/**
 * 核心类型定义
 */

// ============ Package Manager Types ============

export type PackageManagerName = "npm" | "pnpm" | "yarn";

export interface PackageManagerInfo {
  name: PackageManagerName;
  version: string;
  lockFile: string | null;
  lockFilePath: string | null;
}

// ============ Package.json Types ============

export interface PackageJson {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  optionalDependencies?: Record<string, string>;
  engines?: {
    node?: string;
    npm?: string;
    pnpm?: string;
    yarn?: string;
  };
  packageManager?: string;
  workspaces?: string[] | { packages: string[] };
  overrides?: Record<string, string | Record<string, string>>;
  resolutions?: Record<string, string>;
  pnpm?: {
    overrides?: Record<string, string>;
  };
}

// ============ Dependency Types ============

export type DependencyType = "prod" | "dev" | "peer" | "optional";

export interface DependencyNode {
  name: string;
  version: string;
  specifier: string;
  resolved?: string;
  integrity?: string;
  dependencyType: DependencyType;
  hoisted: boolean;
  deduped: boolean;
  location: string;
  dependencies: DependencyNode[];
  peerDependencies: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  problems?: string[];
}

export interface DependencyTree {
  name: string;
  version: string;
  path: string;
  dependencies: DependencyNode[];
}

export interface FlatDependency {
  name: string;
  versions: string[];
  locations: string[];
  requestedBy: Array<{
    name: string;
    version: string;
    requirement: string;
  }>;
}

// ============ Workspace Types ============

export interface WorkspaceInfo {
  name: string;
  path: string;
  relativePath: string;
  version: string;
  packageJson: PackageJson;
}

export interface WorkspaceConfig {
  enabled: boolean;
  packages: string[];
  configSource: "package.json" | "pnpm-workspace.yaml" | null;
}

// ============ Conflict Types ============

export type ConflictType =
  | "version_conflict"
  | "peer_dependency"
  | "multiple_versions"
  | "workspace_mismatch"
  | "override_risk"
  | "engine_mismatch"
  | "deprecated"
  | "missing_dependency";

export type Severity = "error" | "warning" | "info";

export interface ConflictIssue {
  id: string;
  type: ConflictType;
  severity: Severity;
  package: string;
  message: string;
  details: ConflictDetails;
  affectedPaths: string[];
  suggestedAction: string;
}

export interface ConflictDetails {
  conflictingVersions?: Array<{
    version: string;
    requiredBy: string;
    requirement: string;
  }>;
  peerDependency?: {
    host: string;
    hostVersion: string;
    peerPackage: string;
    required: string;
    installed: string | null;
  };
  multipleVersions?: Array<{
    version: string;
    paths: string[];
  }>;
  workspaceMismatch?: Array<{
    workspace: string;
    localVersion: string;
    usedVersions: string[];
  }>;
  overrideRisk?: {
    package: string;
    forcedVersion: string;
    originalRequirements: Array<{
      from: string;
      requirement: string;
    }>;
    potentialBreaking: boolean;
  };
  engineMismatch?: {
    package: string;
    required: string;
    current: string;
    field: "node" | "npm" | "pnpm" | "yarn";
  };
}

// ============ Solution Types ============

export type SolutionAction =
  | "upgrade"
  | "downgrade"
  | "add"
  | "remove"
  | "override"
  | "dedupe"
  | "regenerate_lock";

export type RiskLevel = "low" | "medium" | "high";
export type EffortLevel = "trivial" | "minor" | "moderate" | "major";

export interface SolutionStep {
  action: SolutionAction;
  target: string;
  from?: string;
  to?: string;
  file: string;
  field?: string;
  command?: string;
  manual?: boolean;
}

export interface Solution {
  id: string;
  forIssue: string;
  title: string;
  description: string;
  steps: SolutionStep[];
  risk: {
    level: RiskLevel;
    factors: string[];
    mitigations: string[];
  };
  compatibility: {
    breakingChanges: boolean;
    affectedPackages: string[];
    testingRequired: string[];
  };
  recommendation: {
    score: number;
    reasons: string[];
  };
  estimatedEffort: EffortLevel;
}

// ============ Registry Types ============

export interface RegistryPackageInfo {
  name: string;
  version: string;
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  engines?: Record<string, string>;
  deprecated?: string;
}

export interface RegistryPackageDocument {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, RegistryPackageInfo>;
  time?: Record<string, string>;
  maintainers?: Array<{ name: string; email?: string }>;
  description?: string;
  homepage?: string;
  repository?: { type: string; url: string };
  license?: string;
}

// ============ Environment Types ============

export interface EnvironmentInfo {
  packageManager: PackageManagerInfo;
  isMonorepo: boolean;
  workspaces: WorkspaceConfig;
  nodeVersion: {
    required: string | null;
    current: string;
  };
  packageManagerField: string | null;
  overrides: {
    npm: Record<string, string>;
    pnpm: Record<string, string>;
    yarn: Record<string, string>;
  };
  rootPackage: {
    name: string;
    version: string;
    private: boolean;
  };
}

// ============ Analysis Stats Types ============

export interface DependencyStats {
  totalPackages: number;
  uniquePackages: number;
  duplicatePackages: number;
  maxDepth: number;
  prodDependencies: number;
  devDependencies: number;
}
