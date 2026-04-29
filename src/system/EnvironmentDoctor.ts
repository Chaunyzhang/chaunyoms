import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { serializeVectorFloat32 } from "../retrieval/VectorEmbedding";

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
    vectorExtensionEntryPoint?: string;
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
    if (configuredVectorExtension) {
      checks.push(this.inspectVectorExtensionLoad({
        path: options.vectorExtensionPath?.trim() ?? "",
        entryPoint: options.vectorExtensionEntryPoint,
      }));
    }

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
        DatabaseSync?: new (location: string, options?: { allowExtension?: boolean }) => {
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

  private static inspectVectorExtensionLoad(options: {
    path: string;
    entryPoint?: string;
  }): EnvironmentDoctorCheck {
    if (!existsSync(options.path)) {
      return {
        name: "vector_extension_load",
        ok: false,
        required: false,
        message: `Configured vector extension does not exist: ${options.path}`,
        details: { vectorExtensionPath: options.path },
      };
    }
    try {
      const sqlite = nodeRequire("node:sqlite") as {
        DatabaseSync?: new (location: string, options?: { allowExtension?: boolean }) => {
          close(): void;
          enableLoadExtension?: (enabled: boolean) => void;
          loadExtension?: (path: string, entryPoint?: string) => void;
          prepare(sql: string): {
            get(...params: unknown[]): Record<string, unknown> | undefined;
          };
        };
      };
      if (!sqlite.DatabaseSync) {
        throw new Error("node_sqlite_database_unavailable");
      }
      const db = new sqlite.DatabaseSync(":memory:", { allowExtension: true });
      try {
        if (typeof db.enableLoadExtension !== "function" || typeof db.loadExtension !== "function") {
          throw new Error("sqlite_load_extension_unavailable");
        }
        db.enableLoadExtension(true);
        const entryPoint = options.entryPoint?.trim();
        if (entryPoint) {
          db.loadExtension(options.path, entryPoint);
        } else {
          db.loadExtension(options.path);
        }
        db.enableLoadExtension(false);
        const row = db.prepare("SELECT vec_distance_cosine(?, ?) AS distance")
          .get(serializeVectorFloat32([1, 0]), serializeVectorFloat32([1, 0]));
        const distance = Number(row?.distance);
        if (!Number.isFinite(distance) || Math.abs(distance) > 0.0001) {
          throw new Error("sqlite_vec_probe_failed");
        }
        return {
          name: "vector_extension_load",
          ok: true,
          required: false,
          message: "Configured SQLite vector extension loaded and passed vec_distance_cosine probe.",
          details: { vectorExtensionPath: options.path, entryPoint },
        };
      } finally {
        try {
          db.enableLoadExtension?.(false);
        } catch {
          // Best effort; the in-memory connection is about to close.
        }
        db.close();
      }
    } catch (error) {
      return {
        name: "vector_extension_load",
        ok: false,
        required: false,
        message: `Configured vector extension failed to load/probe: ${error instanceof Error ? error.message : String(error)}`,
        details: { vectorExtensionPath: options.path },
      };
    }
  }
}
