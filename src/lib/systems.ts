import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Multi-system registry.
 *
 * One server process can talk to any SAP system listed in a single file kept OUTSIDE the
 * project repositories (default: ~/.sap-mcp/systems.json, override with SAP_SYSTEMS_FILE).
 * The active system is switched at runtime with the sap_connect tool — no client restart.
 *
 * File format:
 * {
 *   "defaultSystem": "wisent-demo",
 *   "systems": {
 *     "wisent-demo": {
 *       "url": "https://host:44300", "client": "100", "user": "ME", "password": "...",
 *       "language": "TR", "insecureTls": true, "readOnly": false, "description": "..."
 *     }
 *   }
 * }
 *
 * "password" may be "env:VAR_NAME" to read it from an environment variable instead.
 */
export interface SystemDef {
  name: string;
  url: string;
  user: string;
  password: string;
  client?: string;
  language?: string;
  /** Accept self-signed / untrusted TLS certificates for this system only. */
  insecureTls?: boolean;
  /** Refuse every tool that is not annotated read-only (and non-GET raw_http). */
  readOnly?: boolean;
  description?: string;
  /** Where the definition came from: the systems file or SAP_* environment variables. */
  source: 'file' | 'env';
}

export const ENV_SYSTEM_NAME = 'env';

export function systemsFilePath(): string {
  return process.env.SAP_SYSTEMS_FILE || path.join(os.homedir(), '.sap-mcp', 'systems.json');
}

function resolvePassword(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  if (raw.startsWith('env:')) return process.env[raw.slice(4)] || '';
  return raw;
}

export interface Registry {
  file: string;
  fileExists: boolean;
  /** Parse error of the systems file, if any — surfaced by sap_systems instead of crashing. */
  fileError?: string;
  defaultSystem?: string;
  systems: Map<string, SystemDef>;
}

/** Read the registry fresh on every call so edits to the file apply without a restart. */
export function loadRegistry(): Registry {
  const file = systemsFilePath();
  const reg: Registry = { file, fileExists: false, systems: new Map() };

  if (fs.existsSync(file)) {
    reg.fileExists = true;
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
      const systems = json.systems || {};
      for (const [rawName, v] of Object.entries<any>(systems)) {
        const name = rawName.trim().toLowerCase();
        if (!v || typeof v !== 'object' || !v.url || !v.user) continue;
        reg.systems.set(name, {
          name,
          url: String(v.url),
          user: String(v.user),
          password: resolvePassword(v.password),
          client: v.client != null ? String(v.client) : undefined,
          language: v.language != null ? String(v.language) : undefined,
          insecureTls: v.insecureTls === true,
          readOnly: v.readOnly === true,
          description: v.description != null ? String(v.description) : undefined,
          source: 'file',
        });
      }
      if (typeof json.defaultSystem === 'string') reg.defaultSystem = json.defaultSystem.trim().toLowerCase();
    } catch (e: any) {
      reg.fileError = `${file}: ${e?.message || e}`;
    }
  }

  // Legacy single-system configuration via SAP_* environment variables keeps working.
  if (process.env.SAP_URL && process.env.SAP_USER && process.env.SAP_PASSWORD) {
    reg.systems.set(ENV_SYSTEM_NAME, {
      name: ENV_SYSTEM_NAME,
      url: process.env.SAP_URL,
      user: process.env.SAP_USER,
      password: process.env.SAP_PASSWORD,
      client: process.env.SAP_CLIENT,
      language: process.env.SAP_LANGUAGE,
      insecureTls: process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0',
      readOnly: process.env.SAP_READ_ONLY === 'true',
      description: 'SAP_* environment variables',
      source: 'env',
    });
  }

  return reg;
}

/**
 * Which system to activate at startup:
 * SAP_SYSTEM env (explicit) → SAP_* env credentials (legacy) → defaultSystem in the file → none.
 */
export function initialSystem(reg: Registry): SystemDef | undefined {
  const wanted = process.env.SAP_SYSTEM?.trim().toLowerCase();
  if (wanted && reg.systems.has(wanted)) return reg.systems.get(wanted);
  if (reg.systems.has(ENV_SYSTEM_NAME)) return reg.systems.get(ENV_SYSTEM_NAME);
  if (reg.defaultSystem && reg.systems.has(reg.defaultSystem)) return reg.systems.get(reg.defaultSystem);
  return undefined;
}

/** Resolve a user-supplied name: exact match, else a unique prefix/substring match. */
export function findSystem(reg: Registry, query: string): { match?: SystemDef; candidates: string[] } {
  const q = (query || '').trim().toLowerCase();
  const names = [...reg.systems.keys()];
  if (reg.systems.has(q)) return { match: reg.systems.get(q), candidates: [q] };
  const stripped = q.replace(/^sap[-_]/, '');
  if (reg.systems.has(stripped)) return { match: reg.systems.get(stripped), candidates: [stripped] };
  const candidates = names.filter(n => n.includes(stripped));
  if (candidates.length === 1) return { match: reg.systems.get(candidates[0]), candidates };
  return { candidates };
}

/** Listing safe to show the model/user — never includes passwords. */
export function describeSystem(s: SystemDef, active?: string) {
  return {
    name: s.name,
    active: s.name === active,
    url: s.url,
    client: s.client,
    user: s.user,
    language: s.language,
    readOnly: !!s.readOnly,
    hasPassword: !!s.password,
    ...(s.description ? { description: s.description } : {}),
  };
}
