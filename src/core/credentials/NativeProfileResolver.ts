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
 */
export class NativeProfileResolver {
  readonly #baseProfilesDir: string;
  readonly #homeDir: string;

  constructor(options: NativeProfileResolverOptions = {}) {
    this.#homeDir = options.homeDir ?? os.homedir();
    this.#baseProfilesDir =
      options.baseProfilesDir ?? path.join(this.#homeDir, '.agentforge', 'profiles');
  }

  /**
   * Resolves a native profile reference into safe execution configuration metadata.
   * Fails closed for unknown providers that do not have a declared provider contract.
   */
  public resolve(refOrUri: NativeProfileRef | string): NativeProfileResolution {
    const profileRef =
      typeof refOrUri === 'string' ? parseNativeProfileRef(refOrUri) : refOrUri;

    const provider = profileRef.getProvider();
    const profileId = profileRef.getProfileId();
    const rawRef = profileRef.toUriString();

    switch (provider) {
      case 'codex': {
        const profileDir = path.join(this.#baseProfilesDir, 'codex', profileId);
        return {
          provider: 'codex',
          profileId,
          profileRef: rawRef,
          envOverrides: {
            CODEX_HOME: profileDir,
          },
          profileDirectory: profileDir,
          configurationStatus: 'DOCUMENTED_SUPPORTED',
          runtimeIsolationStatus: 'PENDING_R5D',
          notes:
            'Codex CLI configuration mapping via CODEX_HOME. Multi-profile runtime isolation pending R5D proof.',
        };
      }

      case 'gemini': {
        const profileDir = path.join(this.#baseProfilesDir, 'gemini', profileId);
        return {
          provider: 'gemini',
          profileId,
          profileRef: rawRef,
          envOverrides: {
            GEMINI_CLI_HOME: profileDir,
          },
          profileDirectory: profileDir,
          configurationStatus: 'DOCUMENTED_SUPPORTED',
          runtimeIsolationStatus: 'PENDING_R5D',
          notes:
            'Gemini CLI configuration mapping via GEMINI_CLI_HOME. Multi-profile runtime isolation pending R5D proof.',
        };
      }

      case 'claude': {
        const profileDir = path.join(this.#baseProfilesDir, 'claude', profileId);
        return {
          provider: 'claude',
          profileId,
          profileRef: rawRef,
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
