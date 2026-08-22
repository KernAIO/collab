import type * as Y from 'yjs'

/**
 * Flattens a Yjs document to plain text for search indexing and previews.
 *
 * Kern's editors store ProseMirror documents in a shared XML fragment, so walking the fragment gives
 * the text without needing the schema. Unknown shapes are skipped rather than guessed at.
 */
export function extractText(document: Y.Doc, limit = 100_000): string {
  const parts: string[] = []
  let length = 0

  const walk = (node: unknown): void => {
    if (length >= limit || node == null) return
    const value = node as {
      toString?: () => string
      toArray?: () => unknown[]
      length?: number
    }
    if (typeof value.toArray === 'function') {
      for (const child of value.toArray()) {
        walk(child)
        if (length >= limit) return
      }
      return
    }
    if (typeof value.toString === 'function') {
      const text = value.toString().trim()
      if (text) {
        parts.push(text)
        length += text.length
      }
    }
  }

  document.share.forEach((_type, key) => {
    if (length >= limit) return
    try {
      walk(document.get(key))
    } catch {
      // a shared type we do not know how to read contributes nothing to the snapshot
    }
  })

  return parts.join('\n').slice(0, limit)
}
