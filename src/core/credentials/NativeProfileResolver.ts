import os from 'os';
import path from 'path';
import { NativeProfileRef, parseNativeProfileRef } from './NativeProfileRef';

export type ConfigurationStatus = 'DOCUMENTED_SUPPORTED' | 'EXPERIMENTAL_UNPROVEN';
export type RuntimeIsolationStatus = 'PENDING_R5D' | 'VERIFIED';

export interface NativeProfileResolution {
  provider: string;
  profileId: string;
  profileRef: string;
  envOverrides: Record<string, string>;
  profileDirectory: string;
  configurationStatus: ConfigurationStatus;
  runtimeIsolationStatus: RuntimeIsolationStatus;
  notes: string;
}

export interface NativeProfileResolverOptions {
  baseProfilesDir?: string;
  homeDir?: string;
}

/**
 * Resolves NativeProfileRef pointers to deterministic execution environment overrides
 * and directory layouts without reading, inspecting, or copying provider OAuth token files.
 *
 * Revalidates reference inputs fail-closed to prevent traversal or forged profile identities.
 */
export class NativeProfileResolver {
  readonly #baseProfilesDir: string;
  readonly #homeDir: string;

  constructor(options: NativeProfileResolverOptions = {}) {
    this.#homeDir = options.homeDir ?? os.homedir();
    if (options.baseProfilesDir) {
      this.#baseProfilesDir = options.baseProfilesDir;
    } else if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA;
      if (!localAppData || localAppData.trim() === '') {
        throw new Error(
          '[NativeProfileResolver] NATIVE_PROFILE_ROOT_UNAVAILABLE: LOCALAPPDATA environment variable is missing or blank on Windows.'
        );
      }
      this.#baseProfilesDir = path.join(localAppData.trim(), 'AgentForge', 'profiles');
    } else {
      this.#baseProfilesDir = path.join(this.#homeDir, '.agentforge', 'profiles');
    }
  }

  /**
   * Resolves a native profile reference into safe execution configuration metadata.
   * Fails closed for unknown providers that do not have a declared provider contract.
   */
  public resolve(refOrUri: NativeProfileRef | string): NativeProfileResolution {
    if (!refOrUri) {
      throw new Error('[NativeProfileResolver] Native profile reference cannot be null or undefined.');
    }

    const rawUri =
      typeof refOrUri === 'string'
        ? refOrUri
        : typeof (refOrUri as any).toUriString === 'function'
          ? (refOrUri as any).toUriString()
          : String(refOrUri);

    const canonicalRef = parseNativeProfileRef(rawUri);

    const provider = canonicalRef.getProvider();
    const profileId = canonicalRef.getProfileId();
    const canonicalUri = canonicalRef.toUriString();

    switch (provider) {
      case 'codex': {
        const profileDir = path.join(this.#baseProfilesDir, 'codex', profileId);
        return {
          provider: 'codex',
          profileId,
          profileRef: canonicalUri,
          envOverrides: {
            CODEX_HOME: profileDir,
          },
          profileDirectory: profileDir,
          configurationStatus: 'DOCUMENTED_SUPPORTED',
          runtimeIsolationStatus: 'VERIFIED',
          notes:
            'Codex CLI configuration mapping via CODEX_HOME. Multi-profile runtime isolation verified in R5D.',
        };
      }

      case 'gemini': {
        const profileDir = path.join(this.#baseProfilesDir, 'gemini', profileId);
        return {
          provider: 'gemini',
          profileId,
          profileRef: canonicalUri,
          envOverrides: {
            GEMINI_CLI_HOME: profileDir,
          },
          profileDirectory: profileDir,
          configurationStatus: 'DOCUMENTED_SUPPORTED',
          runtimeIsolationStatus: 'VERIFIED',
          notes:
            'Gemini CLI configuration mapping via GEMINI_CLI_HOME. Multi-profile runtime isolation verified in R5D. Live runtime execution blocked by UNSUPPORTED_CLIENT.',
        };
      }

      case 'claude': {
        const profileDir = path.join(this.#baseProfilesDir, 'claude', profileId);
        return {
          provider: 'claude',
          profileId,
          profileRef: canonicalUri,
          envOverrides: {
            CLAUDE_CONFIG_DIR: profileDir,
          },
          profileDirectory: profileDir,
          configurationStatus: 'EXPERIMENTAL_UNPROVEN',
          runtimeIsolationStatus: 'PENDING_R5D',
          notes:
            'Claude Code profile isolation is unverified and experimental. Multi-profile runtime isolation pending R5D proof.',
        };
      }

      default: {
        throw new Error(
          `[NativeProfileResolver] Unsupported native profile provider "${provider}". Supported providers: codex, gemini, claude.`
        );
      }
    }
  }
}
