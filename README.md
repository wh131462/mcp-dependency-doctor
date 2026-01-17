# Dependency Doctor MCP

一个专门用于诊断和修复 Node.js 项目依赖冲突的 MCP (Model Context Protocol) 服务器。

## 功能特性

- **环境检测** - 自动识别包管理器 (npm/pnpm/yarn)、monorepo 结构、workspace 配置
- **依赖分析** - 解析 package.json 和 lock 文件，构建完整依赖树
- **冲突检测** - 检测版本冲突、peerDependencies 问题、多版本依赖等
- **依赖追踪** - 追踪特定依赖的完整路径和来源
- **Registry 查询** - 查询 npm registry 获取真实版本信息
- **解决方案生成** - 为检测到的问题生成多个解决方案并进行比较
- **自动修复** - 通过添加 overrides/resolutions 自动修复 peer dependency 警告

## 安装

### 方式一：使用 Claude Code CLI（推荐）

```bash
claude mcp add @eternalheart/mcp-dependency-doctor
```

### 方式二：全局安装

```bash
npm install -g @eternalheart/mcp-dependency-doctor
```

### 方式三：从源码构建

```bash
git clone https://github.com/wh131462/mcp-dependency-doctor.git
cd mcp-dependency-doctor
npm install
npm run build
```

## 使用方式

### 在 Claude Code 中配置

如果使用 `claude mcp add` 命令安装，配置会自动添加。

手动配置时，在 `~/.claude.json` 的 `mcpServers` 中添加：

```json
{
  "mcpServers": {
    "dependency-doctor": {
      "command": "npx",
      "args": ["@eternalheart/mcp-dependency-doctor"]
    }
  }
}
```

或者使用全局安装的方式：

```json
{
  "mcpServers": {
    "dependency-doctor": {
      "command": "mcp-dependency-doctor"
    }
  }
}
```

### 可用工具 (7个)

#### 1. `detect_environment`

检测项目的包管理器类型、monorepo 结构、workspace 配置。

```
参数:
- projectPath: 项目根目录的绝对路径
```

#### 2. `analyze_dependencies`

解析项目的依赖树，识别 hoist 行为和重复依赖。

```
参数:
- projectPath: 项目根目录路径
- depth: 依赖树深度限制 (可选，默认 10)
- includeDevDependencies: 是否包含 dev 依赖 (可选，默认 true)
- packageName: 指定分析某个包 (可选)
- workspace: 指定分析某个 workspace (可选)
```

#### 3. `detect_conflicts`

检测依赖冲突和问题。

```
参数:
- projectPath: 项目根目录路径
- checkTypes: 检测类型数组 (可选)
  - version_conflict: 版本冲突
  - peer_dependency: peerDependencies 问题
  - multiple_versions: 多版本依赖
  - workspace_mismatch: workspace 版本不一致
  - override_risk: overrides/resolutions 风险
  - engine_mismatch: engine 不匹配
- severity: 过滤严重级别 (all/error/warning)
```

#### 4. `trace_dependency`

追踪特定依赖的完整路径。

```
参数:
- projectPath: 项目根目录路径
- packageName: 要追踪的包名
- version: 指定版本 (可选)
```

#### 5. `query_registry`

查询 npm registry 获取包信息。

```
参数:
- packageName: 包名
- query: 查询类型 (latest/versions/peerDependencies/full/compatibility)
- version: 指定版本 (可选)
- registry: 自定义 registry URL (可选)
```

#### 6. `suggest_solutions`

为依赖问题生成解决方案。

```
参数:
- projectPath: 项目根目录路径
- targetPackage: 目标包名 (可选)
- targetVersion: 目标版本 (可选)
- strategy: 策略 (conservative/aggressive/balanced)
- constraints: 约束条件 (可选)
  - allowMajorUpgrade: 是否允许主版本升级
  - preferredVersions: 首选版本映射
  - excludePackages: 排除的包列表
```

#### 7. `apply_fix`

**自动修复依赖冲突**。通过添加 overrides/resolutions 解决 peer dependency 警告。

```
参数:
- projectPath: 项目根目录路径
- fixes: 手动指定修复列表 (可选，不指定则自动检测)
  - package: 包名
  - version: 目标版本
  - type: 修复类型 (override/install/upgrade)
- autoDetect: 自动检测需要修复的问题 (可选，默认 true)
- dryRun: 仅预览修改，不实际执行 (可选，默认 false)
- reinstall: 修改后是否重新安装依赖 (可选，默认 true)
```

**示例 - 自动修复所有 peer dependency 警告:**
```
apply_fix({ projectPath: "/path/to/project" })
```

**示例 - 手动指定修复:**
```
apply_fix({
  projectPath: "/path/to/project",
  fixes: [
    { package: "less", version: "^4.2.0" },
    { package: "rollup", version: "^3.29.4" }
  ]
})
```

**示例 - 预览模式:**
```
apply_fix({ projectPath: "/path/to/project", dryRun: true })
```

## 典型使用流程

### 诊断流程
1. **检测环境** - 使用 `detect_environment` 了解项目配置
2. **分析依赖** - 使用 `analyze_dependencies` 获取依赖结构
3. **检测问题** - 使用 `detect_conflicts` 找出所有问题
4. **追踪根因** - 使用 `trace_dependency` 追踪问题来源
5. **查询信息** - 使用 `query_registry` 获取包的版本信息
6. **生成方案** - 使用 `suggest_solutions` 获取解决建议

### 快速修复流程
1. **一键修复** - 直接使用 `apply_fix` 自动检测并修复所有 peer dependency 警告

## 支持的包管理器

| 包管理器 | 版本覆盖字段 | 支持状态 |
|---------|-------------|---------|
| npm | `overrides` | ✅ |
| pnpm | `pnpm.overrides` | ✅ |
| yarn | `resolutions` | ✅ |

## 开发

```bash
# 开发模式
npm run dev

# 构建
npm run build

# 类型检查
npm run typecheck
```

## 许可证

MIT
