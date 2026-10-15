import i18n from "i18next"
import type { TOptions } from "i18next"

import { ensureI18n, TxKeyPath } from "."

/**
 * @example
 * Translations:
 *
 * ```en.ts
 * {
 *  "hello": "Hello, {{name}}!"
 * }
 * ```
 *
 * Usage:
 * ```ts
 * import { translate } from "./i18n"
 *
 * translate("hello", { name: "world" })
 * // => "Hello world!"
 * ```
 */
export function translate(key: TxKeyPath, options?: TOptions): string {
  ensureI18n()
  return i18n.isInitialized ? i18n.t(key, options) : key
}
