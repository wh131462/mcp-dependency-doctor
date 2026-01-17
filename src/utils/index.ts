/**
 * 工具函数
 */

import { execaCommand } from "execa";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as semver from "semver";

// ============ File Utils ============

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

// ============ Path Utils ============

export function resolvePath(basePath: string, ...segments: string[]): string {
  return path.resolve(basePath, ...segments);
}

export function relativePath(from: string, to: string): string {
  return path.relative(from, to);
}

export function joinPath(...segments: string[]): string {
  return path.join(...segments);
}

export function dirname(filePath: string): string {
  return path.dirname(filePath);
}

export function basename(filePath: string): string {
  return path.basename(filePath);
}

// ============ Command Execution ============

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function execCommand(
  command: string,
  cwd: string
): Promise<ExecResult> {
  try {
    const result = await execaCommand(command, {
      cwd,
      shell: true,
      reject: false,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? 0,
    };
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 1,
    };
  }
}

// ============ Semver Utils ============

export function parseVersion(version: string): semver.SemVer | null {
  return semver.parse(version);
}

export function satisfiesVersion(
  version: string,
  range: string
): boolean {
  try {
    return semver.satisfies(version, range);
  } catch {
    return false;
  }
}

export function getMaxSatisfying(
  versions: string[],
  range: string
): string | null {
  return semver.maxSatisfying(versions, range);
}

export function compareVersions(v1: string, v2: string): number {
  return semver.compare(v1, v2);
}

export function isValidVersion(version: string): boolean {
  return semver.valid(version) !== null;
}

export function isValidRange(range: string): boolean {
  try {
    return semver.validRange(range) !== null;
  } catch {
    return false;
  }
}

export function coerceVersion(version: string): string | null {
  const coerced = semver.coerce(version);
  return coerced ? coerced.version : null;
}

// ============ String Utils ============

export function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + "...";
}

// ============ Object Utils ============

export function flattenObject(
  obj: Record<string, unknown>,
  prefix = ""
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      Object.assign(
        result,
        flattenObject(value as Record<string, unknown>, newKey)
      );
    } else {
      result[newKey] = String(value);
    }
  }
  return result;
}

// ============ Async Utils ============

export async function mapAsync<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  return Promise.all(items.map(fn));
}

export async function filterAsync<T>(
  items: T[],
  fn: (item: T) => Promise<boolean>
): Promise<T[]> {
  const results = await Promise.all(items.map(fn));
  return items.filter((_, index) => results[index]);
}
