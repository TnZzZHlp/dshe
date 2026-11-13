import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'

/** Plain-object check shared by config, provider and payload validation. */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Cheap "this path is a regular file" probe. */
export function existsAsFile(filename) {
  try {
    return statSync(filename).isFile()
  } catch {
    return false
  }
}

/** Cheap "this path is an executable regular file" probe. */
export function isExecutableFile(filename) {
  try {
    accessSync(filename, constants.X_OK)
    return statSync(filename).isFile()
  } catch {
    return false
  }
}

/** Resolve paths and drop duplicates/empty entries while keeping order. */
export function uniquePaths(values) {
  const result = []
  const seen = new Set()
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) continue
    const resolved = path.resolve(value)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    result.push(resolved)
  }
  return result
}

/** Clamp a source limit, returning undefined for non-integers. */
export function clampMaxResults(value, hardMax = 10) {
  if (!Number.isInteger(value)) return undefined
  return Math.min(Math.max(value, 1), hardMax)
}

export function trimmedString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

export function hostLabelFromUrl(url) {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
