/**
 * NPM Registry 客户端
 * 查询包的版本信息、peerDependencies 等
 */

import type {
  RegistryPackageDocument,
  RegistryPackageInfo,
} from "../../types/index.js";

// 缓存存储
const cache = new Map<string, { data: RegistryPackageDocument; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟缓存

export interface RegistryClientOptions {
  registry?: string;
  timeout?: number;
}

export class RegistryClient {
  private registry: string;
  private timeout: number;

  constructor(options: RegistryClientOptions = {}) {
    this.registry = options.registry || "https://registry.npmjs.org";
    this.timeout = options.timeout || 10000;
  }

  /**
   * 获取包的完整信息
   */
  async getPackageInfo(name: string): Promise<RegistryPackageDocument | null> {
    // 检查缓存
    const cached = cache.get(name);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    try {
      const url = `${this.registry}/${encodeURIComponent(name)}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as RegistryPackageDocument;

      // 存入缓存
      cache.set(name, { data, timestamp: Date.now() });

      return data;
    } catch {
      return null;
    }
  }

  /**
   * 获取包的特定版本信息
   */
  async getVersionInfo(
    name: string,
    version: string
  ): Promise<RegistryPackageInfo | null> {
    const packageInfo = await this.getPackageInfo(name);
    if (!packageInfo) {
      return null;
    }

    return packageInfo.versions[version] || null;
  }

  /**
   * 获取包的最新版本
   */
  async getLatestVersion(name: string): Promise<string | null> {
    const packageInfo = await this.getPackageInfo(name);
    if (!packageInfo) {
      return null;
    }

    return packageInfo["dist-tags"].latest || null;
  }

  /**
   * 获取包的所有版本
   */
  async getAllVersions(name: string): Promise<string[]> {
    const packageInfo = await this.getPackageInfo(name);
    if (!packageInfo) {
      return [];
    }

    return Object.keys(packageInfo.versions);
  }

  /**
   * 获取包的 peerDependencies
   */
  async getPeerDependencies(
    name: string,
    version: string
  ): Promise<Record<string, string>> {
    const versionInfo = await this.getVersionInfo(name, version);
    if (!versionInfo) {
      return {};
    }

    return versionInfo.peerDependencies || {};
  }

  /**
   * 获取包的 peerDependenciesMeta
   */
  async getPeerDependenciesMeta(
    name: string,
    version: string
  ): Promise<Record<string, { optional?: boolean }>> {
    const versionInfo = await this.getVersionInfo(name, version);
    if (!versionInfo) {
      return {};
    }

    return versionInfo.peerDependenciesMeta || {};
  }

  /**
   * 检查包是否已废弃
   */
  async isDeprecated(name: string, version: string): Promise<string | null> {
    const versionInfo = await this.getVersionInfo(name, version);
    if (!versionInfo) {
      return null;
    }

    return versionInfo.deprecated || null;
  }

  /**
   * 获取包的 engines 约束
   */
  async getEngines(
    name: string,
    version: string
  ): Promise<Record<string, string>> {
    const versionInfo = await this.getVersionInfo(name, version);
    if (!versionInfo) {
      return {};
    }

    return versionInfo.engines || {};
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    cache.clear();
  }
}

// 默认客户端实例
export const registryClient = new RegistryClient();
