/** Static compiled sheets owned by the root client plugin lifetime. */
const sheets = new Map<string, string>()
/** @param id - package-relative stylesheet id. @param css - compiled sheet text. */
export function registerStyle(id: string, css: string): void { sheets.set(id, css) }
/** @returns a disposer that removes this plugin's compiled stylesheet nodes. */
export function installStyles(): () => void {
  const nodes: HTMLStyleElement[] = []
  for (const [id, css] of sheets) {
    const node = document.createElement('style')
    node.dataset.dshNotificationsStyle = id
    node.textContent = css
    document.head.append(node)
    nodes.push(node)
  }
  return () => { for (const node of nodes) node.remove() }
}
