import { createRequire } from "node:module";

export interface EnvironmentDoctorCheck {
  name: string;
  ok: boolean;
  required: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface EnvironmentDoctorReport {
  ok: boolean;
  nodeVersion: string;
  npmVersion?: string;
  checks: EnvironmentDoctorCheck[];
  warnings: string[];
}

const nodeRequire = createRequire(__filename);

export class EnvironmentDoctor {
  static run(options: {
    npmVersion?: string;
    vectorExtensionPath?: string;
    strict?: boolean;
  } = {}): EnvironmentDoctorReport {
    const checks: EnvironmentDoctorCheck[] = [];
    const nodeVersion = process.versions.node;
    const nodeMajor = Number(nodeVersion.split(".")[0] ?? 0);
    checks.push({
      name: "node_version",
      ok: nodeMajor >= 24,
      required: true,
      message: nodeMajor >= 24
        ? `Node ${nodeVersion} supports the OMS SQLite runtime target.`
        : `Node ${nodeVersion} is below the OMS target; use Node 24+ for node:sqlite.`,
      details: { nodeMajor },
    });

    const sqlite = this.inspectNodeSqlite();
    checks.push(sqlite.check);
    checks.push({
      name: "sqlite_load_extension_api",
      ok: sqlite.loadExtensionAvailable,
      required: false,
      message: sqlite.loadExtensionAvailable
        ? "SQLite loadExtension API is available for optional vector extensions."
        : "SQLite loadExtension API is unavailable; RAG can still use brute-force fallback.",
    });

    const configuredVectorExtension = typeof options.vectorExtensionPath === "string" &&
      options.vectorExtensionPath.trim().length > 0;
    checks.push({
      name: "vector_extension_config",
      ok: configuredVectorExtension,
      required: false,
      message: configuredVectorExtension
        ? "Vector extension path is configured; OMS will try sqlite_vec first."
        : "No vector extension path configured; sqlite_vec will degrade to brute-force when RAG is enabled.",
      details: configuredVectorExtension ? { vectorExtensionPath: options.vectorExtensionPath } : undefined,
    });

    if (options.npmVersion) {
      checks.push({
        name: "npm_version",
        ok: true,
        required: false,
        message: `npm ${options.npmVersion} detected.`,
      });
    }

    const blocking = checks.filter((check) => check.required && !check.ok);
    const warnings = checks
      .filter((check) => !check.required && !check.ok)
      .map((check) => check.message);
    return {
      ok: blocking.length === 0 && (options.strict === true ? warnings.length === 0 : true),
      nodeVersion,
      npmVersion: options.npmVersion,
      checks,
      warnings,
    };
  }

  private static inspectNodeSqlite(): {
    check: EnvironmentDoctorCheck;
    loadExtensionAvailable: boolean;
  } {
    try {
      const sqlite = nodeRequire("node:sqlite") as {
        DatabaseSync?: new (location: string) => {
          close(): void;
          enableLoadExtension?: (enabled: boolean) => void;
          loadExtension?: (path: string) => void;
        };
      };
      if (!sqlite.DatabaseSync) {
        return {
          check: {
            name: "node_sqlite",
            ok: false,
            required: true,
            message: "node:sqlite loaded but DatabaseSync is unavailable.",
          },
          loadExtensionAvailable: false,
        };
      }
      const db = new sqlite.DatabaseSync(":memory:");
      try {
        return {
          check: {
            name: "node_sqlite",
            ok: true,
            required: true,
            message: "node:sqlite DatabaseSync is available.",
          },
          loadExtensionAvailable: typeof db.enableLoadExtension === "function" &&
            typeof db.loadExtension === "function",
        };
      } finally {
        db.close();
      }
    } catch (error) {
      return {
        check: {
          name: "node_sqlite",
          ok: false,
          required: true,
          message: `node:sqlite unavailable: ${error instanceof Error ? error.message : String(error)}`,
        },
        loadExtensionAvailable: false,
      };
    }
  }
}
