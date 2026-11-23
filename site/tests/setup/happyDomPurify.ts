/**
 * happy-dom v20 WHATWG shims for DOMPurify (Node.prototype.nodeName, live NodeIterator on removal),
 * so DOMPurify hooks and removals behave as in browsers. Shared by the AI companion sanitizer tests.
 */
import type { Window } from 'happy-dom'

export function installHappyDomWhatwgShims(win: Window): void {
  const doc = win.document
  const elemTagGet = Object.getOwnPropertyDescriptor(win.Element.prototype, 'tagName')?.get
  const origNodeNameDesc = Object.getOwnPropertyDescriptor(win.Node.prototype, 'nodeName')
  if (origNodeNameDesc && origNodeNameDesc.get && elemTagGet) {
    const origNN = origNodeNameDesc.get
    Object.defineProperty(win.Node.prototype, 'nodeName', {
      configurable: true,
      get(this: Node) {
        if (this instanceof (win.Element as unknown as typeof Element)) return elemTagGet.call(this) as string
        if (this.nodeType === 3) return '#text'
        if (this.nodeType === 8) return '#comment'
        if (this.nodeType === 9) return '#document'
        if (this.nodeType === 11) return '#document-fragment'
        return origNN.call(this) as string
      },
    })
  }

  interface ShimmedIterator {
    root: Node
    referenceNode: Node
    before: boolean
    nextNode: () => Node | null
    detach: () => void
  }
  const iterators = new Set<ShimmedIterator>()
  const prevInTree = (root: Node, target: Node): Node | null => {
    let last: Node | null = null
    const stack: Node[] = [root]
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (cur === target) return last
      last = cur
      const kids = cur.childNodes
      for (let i = kids.length - 1; i >= 0; i--) {
        stack.push(kids[i]!)
      }
    }
    return null
  }
  const containsNode = (anc: Node, node: Node): boolean => {
    for (let c: Node | null = node; c; c = c.parentNode) {
      if (c === anc) return true
    }
    return false
  }
  const preRemove = (child: Node): void => {
    for (const it of iterators) {
      if (containsNode(child, it.referenceNode)) {
        const prev = prevInTree(it.root, child)
        if (prev) it.referenceNode = prev
        else {
          it.referenceNode = it.root
          it.before = true
        }
      }
    }
  }

  const origRemoveChild = win.Node.prototype.removeChild
  const origElemRemove = win.Element.prototype.remove
  const origCharRemove = win.CharacterData.prototype.remove

  win.Node.prototype.removeChild = function <T extends Node>(this: Node, child: T): T {
    preRemove(child as unknown as Node)
    return origRemoveChild.call(this as unknown as never, child as unknown as never) as unknown as T
  } as typeof win.Node.prototype.removeChild
  win.Element.prototype.remove = function (this: Element): void {
    preRemove(this)
    origElemRemove.call(this as unknown as never)
  }
  win.CharacterData.prototype.remove = function (this: CharacterData): void {
    preRemove(this)
    origCharRemove.call(this as unknown as never)
  }

  let docProto: object | null = doc as unknown as object
  while (docProto && !Object.getOwnPropertyDescriptor(docProto, 'createNodeIterator')) {
    docProto = Object.getPrototypeOf(docProto) as object | null
  }
  if (docProto) {
    Object.defineProperty(docProto, 'createNodeIterator', {
      configurable: true,
      value(root: Node, whatToShow = -1, filter: NodeFilter | null = null): ShimmedIterator {
        const it: ShimmedIterator = {
          root,
          referenceNode: root,
          before: true,
          nextNode() {
            const nextAfter = (n: Node): Node | null => {
              if (n.firstChild) return n.firstChild
              for (let c: Node | null = n; c && c !== root; c = c.parentNode) {
                if (c.nextSibling) return c.nextSibling
              }
              return null
            }
            while (true) {
              const candidate = this.before ? ((this.before = false), this.referenceNode) : nextAfter(this.referenceNode)
              if (!candidate) return null
              this.referenceNode = candidate
              const bit = 1 << (candidate.nodeType - 1)
              if ((whatToShow & bit) === 0) continue
              const accept =
                !filter
                  ? 1
                  : typeof filter === 'function'
                    ? (filter as (node: Node) => number)(candidate)
                    : filter.acceptNode(candidate)
              if (accept === 1) return candidate
            }
          },
          detach() {
            iterators.delete(this)
          },
        }
        iterators.add(it)
        return it
      },
    })
  }
}
