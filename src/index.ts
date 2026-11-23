import type { Config, Plugin } from 'payload'

/**
 * Sharing for Payload. A skeleton for now: the pieces land in their own pull requests. Who may share what, and with
 * whom, is always the host's to pass in; nothing here grants anything by default.
 */
export type SharingOptions = {
  /** Turn the plugin off without removing it. Default true. */
  enabled?: boolean
}

export const sharing =
  (options: SharingOptions = {}): Plugin =>
  (config: Config): Config => {
    if (options.enabled === false) return config
    return config
  }
