export type SourceNetworkDefaultMode = 'direct' | 'byedpi' | 'custom';

/** Host settings: source code cannot read or modify these options. */
export interface SourceNetworkSettings {
  revision: number;
  defaultProxy: string;
  /** Explicit transport selection; defaultProxy remains saved even while direct is selected. */
  defaultMode?: SourceNetworkDefaultMode;
  origin: 'environment' | 'settings' | 'direct';
  /** Saved user default stays separate from the built-in transport. */
  effectiveProxy?: string;
  byedpi?: { available: boolean; enabled: boolean; running: boolean };
}
export interface SourceNetworkSettingsRequest {
  revision: number;
  /** Saved address. Without defaultMode, empty means direct; null restores the environment default. */
  defaultProxy: string | null;
  defaultMode?: SourceNetworkDefaultMode;
  /** Omitted by older clients: preserve the saved switch. */
  byedpiEnabled?: boolean;
}
