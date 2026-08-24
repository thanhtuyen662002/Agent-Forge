import os from 'os';
import path from 'path';
import { NativeProfileRef, parseNativeProfileRef } from './NativeProfileRef';

export type ProfileIsolationStatus = 'VERIFIED' | 'EXPERIMENTAL_UNPROVEN';

export interface NativeProfileResolution {
  provider: string;
  profileId: string;
  profileRef: string;
  envOverrides: Record<string, string>;
  profileDirectory: string;
  isolationStatus: ProfileIsolationStatus;
  notes?: string;
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
  private readonly baseProfilesDir: string;
  private readonly homeDir: string;

  constructor(options: NativeProfileResolverOptions = {}) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.baseProfilesDir =
      options.baseProfilesDir ?? path.join(this.homeDir, '.agentforge', 'profiles');
  }

  /**
   * Resolves a native profile reference into safe execution configuration metadata.
   */
  public resolve(refOrUri: NativeProfileRef | string): NativeProfileResolution {
    const profileRef =
      typeof refOrUri === 'string' ? parseNativeProfileRef(refOrUri) : refOrUri;

    const provider = profileRef.getProvider();
    const profileId = profileRef.getProfileId();
    const rawRef = profileRef.toUriString();

    switch (provider) {
      case 'codex': {
        const profileDir = path.join(this.baseProfilesDir, 'codex', profileId);
        return {
          provider: 'codex',
          profileId,
          profileRef: rawRef,
          envOverrides: {
            CODEX_HOME: profileDir,
          },
          profileDirectory: profileDir,
          isolationStatus: 'VERIFIED',
          notes: 'Codex CLI profile isolated via CODEX_HOME.',
        };
      }

      case 'gemini': {
        const profileDir = path.join(this.baseProfilesDir, 'gemini', profileId);
        return {
          provider: 'gemini',
          profileId,
          profileRef: rawRef,
          envOverrides: {
            GEMINI_CLI_HOME: profileDir,
          },
          profileDirectory: profileDir,
          isolationStatus: 'VERIFIED',
          notes: 'Gemini CLI profile isolated via GEMINI_CLI_HOME.',
        };
      }

      case 'claude': {
        const profileDir = path.join(this.baseProfilesDir, 'claude', profileId);
        return {
          provider: 'claude',
          profileId,
          profileRef: rawRef,
          envOverrides: {
            CLAUDE_CONFIG_DIR: profileDir,
          },
          profileDirectory: profileDir,
          isolationStatus: 'EXPERIMENTAL_UNPROVEN',
          notes:
            'Claude Code profile isolation is unverified and experimental until R5D native execution proof.',
        };
      }

      default: {
        const profileDir = path.join(this.baseProfilesDir, provider, profileId);
        return {
          provider,
          profileId,
          profileRef: rawRef,
          envOverrides: {
            [`${provider.toUpperCase().replace(/-/g, '_')}_HOME`]: profileDir,
          },
          profileDirectory: profileDir,
          isolationStatus: 'EXPERIMENTAL_UNPROVEN',
          notes: `Generic profile isolation for provider "${provider}". Unverified until proven.`,
        };
      }
    }
  }
}
